// POLAR BILLING MODULE
// Manages usage-based billing through Polar's meter system
//
// ARCHITECTURE:
// - Licensed users: Tracked via Polar customer meters
// - Anonymous users: Not tracked in Polar (handled by rate limiter)
// - Events: Ingested after successful transcription
// - Balance checks: Query customer meter balance before processing

import { Polar } from '@polar-sh/sdk';
import { Logger } from './logger';
import { CustomerMetersListResponse } from '@polar-sh/sdk/dist/commonjs/models/operations/customermeterslist';
import { getLicenseFromCache, setLicenseInCache } from './license-cache';
import { CREDITS_PER_MINUTE } from './constants/credits';
import { roundToTenth, roundUpToTenth } from './utils';

// Meter configuration
const METER_SLUG = 'transcription_credits'; // Must match meter created in Polar dashboard

/**
 * Initialize Polar SDK client
 * Uses sandbox mode for development, production mode for prod
 */
export function createPolarClient(accessToken: string, environment?: string): Polar {
  const server = environment === 'development' ? 'sandbox' : 'production';

  return new Polar({
    accessToken,
    server,
  });
}

/**
 * Validate license key and get associated customer ID
 * Uses cache-first strategy to reduce Polar API calls
 *
 * @param polar - Polar SDK client
 * @param licenseCache - KV namespace for license cache
 * @param licenseKey - License key to validate
 * @param organizationId - Polar organization ID
 * @param logger - Logger instance
 * @returns Customer ID if valid, null otherwise
 */
export async function validateAndGetCustomer(
  polar: Polar,
  licenseCache: any,
  licenseKey: string,
  organizationId: string,
  logger: Logger
): Promise<{ customerId: string | null; isValid: boolean }> {
  // STEP 1: Check cache first
  const cached = await getLicenseFromCache(licenseCache, licenseKey, logger);

  if (cached) {
    return {
      customerId: cached.isValid ? cached.customerId : null,
      isValid: cached.isValid,
    };
  }

  // STEP 2: Cache miss - validate with Polar API
  try {
    const response = await polar.licenseKeys.validate({
      key: licenseKey,
      organizationId,
    });

    // Check if license is valid (status: 'granted')
    const isValid = response.status === 'granted';
    const customerId = response.customerId;

    // STEP 3: Cache the result
    await setLicenseInCache(licenseCache, licenseKey, customerId, isValid, logger);

    if (isValid && customerId) {
      logger.log('info', 'License validated successfully (from Polar API)', {
        customerId,
        status: response.status,
      });

      return {
        customerId,
        isValid: true,
      };
    }

    logger.log('warn', 'Invalid license key (from Polar API)', {
      status: response.status || 'invalid',
    });

    return {
      customerId: null,
      isValid: false,
    };
  } catch (error) {
    logger.log('error', 'License validation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      customerId: null,
      isValid: false,
    };
  }
}

/**
 * Check customer's meter balance
 *
 * @param polar - Polar SDK client
 * @param customerId - Polar customer ID
 * @param organizationId - Polar organization ID
 * @returns Credit balance and usage information
 */
export async function getCustomerMeterBalance(
  polar: Polar,
  customerId: string,
  organizationId: string,
  meterId: string,
  logger: Logger
): Promise<{ hasCredits: boolean; balance: number; limit?: number }> {
  try {
    // Get customer meters - returns a promise that resolves to an iterator
    const metersIterator = await polar.customerMeters.list({
      customerId,
      organizationId,
      meterId,
    });

    // Collect all meters from the iterator
    const metersList: CustomerMetersListResponse[] = [];
    for await (const meter of metersIterator) {
      metersList.push(meter);
    }

    if (metersList.length === 0) {
      logger.log('warn', 'No meter found for customer', {
        customerId,
        meterSlug: METER_SLUG,
      });

      // Customer exists but no meter - might be new customer
      return {
        hasCredits: false,
        balance: 0,
      };
    }

    // Find the transcription credits meter
    const meterResult = metersList[0].result;
    const meter = meterResult.items[0];
    const balance = meter.balance || 0;
    const used = meter.consumedUnits || 0;
    const limit = meter.creditedUnits;

    logger.log('info', 'Customer meter balance retrieved', {
      customerId,
      balance,
      used,
      limit,
      hasCredits: balance > 0,
    });

    return {
      hasCredits: balance > 0,
      balance,
      limit,
    };
  } catch (error) {
    logger.log('error', 'Failed to get customer meter balance', {
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId,
    });

    // Error checking balance - deny access for safety
    return {
      hasCredits: false,
      balance: 0,
    };
  }
}

/**
 * Ingest usage event to Polar
 *
 * @param polar - Polar SDK client
 * @param customerId - Polar customer ID
 * @param creditsUsed - Number of credits consumed
 * @param metadata - Additional event metadata
 */
export async function ingestUsageEvent(
  polar: Polar,
  customerId: string,
  creditsUsed: number,
  metadata: Record<string, any>,
  logger: Logger
): Promise<void> {
  try {
    await polar.events.ingest({
      events: [
        {
          name: 'transcription_usage',
          customerId,
          metadata: {
            credits_used: creditsUsed,
            meter_slug: METER_SLUG,
            timestamp: new Date().toISOString(),
            ...metadata,
          },
        },
      ],
    });

    logger.log('info', 'Usage event ingested successfully', {
      customerId,
      creditsUsed,
      eventName: 'transcription_usage',
    });
  } catch (error) {
    logger.log('error', 'Failed to ingest usage event', {
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId,
      creditsUsed,
    });

    // Don't throw - we don't want to fail the transcription if event ingestion fails
    // Polar will handle retries and eventual consistency
  }
}

/**
 * Calculate credits to charge based on transcription cost
 *
 * @param costUsd - USD cost of the transcription
 * @returns Number of credits to charge
 */
export function calculateCreditsForCost(costUsd: number): number {
  // 1 credit = $0.001 USD; round up to avoid undercharging but allow 0.1 credit granularity
  if (costUsd <= 0) {
    return 0.1;
  }

  const credits = costUsd * 1000;
  return Math.max(0.1, roundUpToTenth(credits));
}

/**
 * Check if customer has sufficient balance for estimated usage
 *
 * @param balance - Current credit balance
 * @param estimatedCredits - Estimated credits needed
 * @returns Whether customer has sufficient balance
 */
export function hasSufficientBalance(balance: number, estimatedCredits: number): boolean {
  // Add a small buffer to avoid edge cases
  return balance >= estimatedCredits;
}

/**
 * Format meter balance for response
 *
 * @param balance - Credit balance
 * @param limit - Optional credit limit
 * @returns Formatted balance information
 */
export function formatMeterBalance(balance: number, limit?: number): {
  credits_remaining: number;
  minutes_remaining: number;
  credits_per_minute: number;
  has_limit: boolean;
  limit?: number;
} {
  const normalizedBalance = roundToTenth(balance);
  const minutesRemaining = Math.floor(normalizedBalance / CREDITS_PER_MINUTE);

  return {
    credits_remaining: normalizedBalance,
    minutes_remaining: minutesRemaining,
    credits_per_minute: CREDITS_PER_MINUTE,
    has_limit: limit !== undefined && limit !== null,
    limit,
  };
}
