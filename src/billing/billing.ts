// BILLING MODULE
// Manages usage-based billing through Next.js APIs backed by Supabase
//
// ARCHITECTURE:
// - License validation: Calls Next.js /api/license/validate (full validation + Polar fallback)
// - Credit balance: GET /api/license/credits (lightweight balance-only query)
// - Usage tracking: POST /api/license/credits (deduct credits)
//
// ENDPOINTS USED:
// - validateAndGetCredits: Uses /api/license/validate (includes device tracking, Polar import)
// - getCreditsBalance: Uses GET /api/license/credits (fast, balance-only)
// - recordUsage: Uses POST /api/license/credits (deduct credits)
//
// BENEFITS:
// - Centralized billing logic in Next.js (Supabase)
// - CF Workers only make HTTP calls, no SDK dependencies
// - Consistent with macOS app validation flow

import { Logger } from '../utils/logger';
import { getLicenseFromCache, setLicenseInCache, CachedLicense } from './license-cache';
import { CREDITS_PER_MINUTE } from '../constants/credits';
import { roundToTenth, roundUpToTenth } from '../utils/utils';

/**
 * Validate license key and get credit balance
 * Uses cache-first strategy to reduce API calls
 *
 * @param licenseCache - KV namespace for license cache
 * @param licenseKey - License key to validate
 * @param apiUrl - Base URL for Next.js API (e.g., https://hyperwhisper.com)
 * @param logger - Logger instance
 * @param forceRefresh - If true, bypass cache and fetch fresh data from API
 * @returns License validation result with credit balance
 */
export async function validateAndGetCredits(
  licenseCache: KVNamespace,
  licenseKey: string,
  apiUrl: string,
  logger: Logger,
  forceRefresh: boolean = false
): Promise<{ isValid: boolean; credits: number }> {
  // STEP 1: Check cache first (unless forceRefresh is true)
  if (!forceRefresh) {
    const cached = await getLicenseFromCache(licenseCache, licenseKey, logger);

    if (cached) {
      // Cache hit - return cached validation status and credits
      return {
        isValid: cached.isValid,
        credits: cached.credits,
      };
    }
  } else {
    logger.log('info', 'Force refresh requested, bypassing cache');
  }

  // STEP 2: Cache miss - validate with Next.js API
  try {
    const response = await fetch(`${apiUrl}/api/license/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        license_key: licenseKey,
        include_credits: true, // Request credit balance in response
      }),
    });

    const data = await response.json() as {
      valid: boolean;
      credits?: number;
      stripe_customer_id?: string;
      error?: string;
    };

    const isValid = data.valid === true;
    const credits = data.credits || 0;

    // STEP 3: Cache the result
    await setLicenseInCache(licenseCache, licenseKey, credits, isValid, logger);

    if (isValid) {
      logger.log('info', 'License validated successfully (from API)', {
        credits,
        hasStripeCustomer: !!data.stripe_customer_id,
      });

      return {
        isValid: true,
        credits,
      };
    }

    logger.log('warn', 'Invalid license key (from API)', {
      error: data.error || 'invalid',
    });

    return {
      isValid: false,
      credits: 0,
    };
  } catch (error) {
    logger.log('error', 'License validation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      isValid: false,
      credits: 0,
    };
  }
}

/**
 * Get credit balance for a license (lightweight, balance-only query)
 *
 * Uses GET /api/license/credits which is faster than validate endpoint because it:
 * - Does NOT do Polar fallback/import
 * - Does NOT track device validations
 * - Just queries the database for current balance
 *
 * USE CASES:
 * - Refreshing balance after usage (credits page refresh button)
 * - Getting updated balance when we already know license is valid (cache hit for validity)
 * - Any scenario where we just need current credits, not full validation
 *
 * @param licenseCache - KV namespace for license cache
 * @param licenseKey - License key to query
 * @param apiUrl - Base URL for Next.js API (e.g., https://hyperwhisper.com)
 * @param logger - Logger instance
 * @returns Credit balance or error
 */
export async function getCreditsBalance(
  licenseCache: KVNamespace,
  licenseKey: string,
  apiUrl: string,
  logger: Logger
): Promise<{ credits: number; error?: string }> {
  try {
    const response = await fetch(
      `${apiUrl}/api/license/credits?license_key=${encodeURIComponent(licenseKey)}`,
      {
        method: 'GET',
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string };
      const errorMessage = errorData.error || `HTTP ${response.status}`;

      logger.log('warn', 'Failed to get credit balance', {
        status: response.status,
        error: errorMessage,
      });

      return {
        credits: 0,
        error: errorMessage,
      };
    }

    const data = await response.json() as {
      credits: number;
      stripe_customer_id?: string;
    };

    logger.log('info', 'Credit balance retrieved', {
      credits: data.credits,
    });

    // Update cache with new balance (keep existing validity status)
    // This ensures cache reflects latest balance without needing full validation
    await setLicenseInCache(licenseCache, licenseKey, data.credits, true, logger);

    return {
      credits: data.credits,
    };
  } catch (error) {
    logger.log('error', 'Failed to get credit balance', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      credits: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Record usage and deduct credits
 * Called after successful transcription
 *
 * @param apiUrl - Base URL for Next.js API
 * @param licenseKey - License key for the user
 * @param creditsUsed - Number of credits to deduct
 * @param metadata - Additional event metadata
 * @param logger - Logger instance
 */
export async function recordUsage(
  apiUrl: string,
  licenseKey: string,
  creditsUsed: number,
  metadata: Record<string, unknown>,
  logger: Logger
): Promise<void> {
  try {
    const response = await fetch(`${apiUrl}/api/license/credits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        license_key: licenseKey,
        amount: creditsUsed,
        metadata,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logger.log('warn', 'Failed to record usage', {
        status: response.status,
        error: (errorData as Record<string, unknown>).error || 'Unknown error',
        creditsUsed,
      });
      return;
    }

    const data = await response.json() as {
      credits_remaining: number;
      credits_deducted: number;
    };

    logger.log('info', 'Usage recorded successfully', {
      creditsDeducted: data.credits_deducted,
      creditsRemaining: data.credits_remaining,
    });
  } catch (error) {
    logger.log('error', 'Failed to record usage', {
      error: error instanceof Error ? error.message : 'Unknown error',
      creditsUsed,
    });

    // Don't throw - we don't want to fail the transcription if usage recording fails
    // The credits will be out of sync temporarily, but the user experience is preserved
  }
}

/**
 * Invalidate cached license (e.g., after credit purchase)
 * Forces next validation to fetch fresh data from API
 *
 * @param licenseCache - KV namespace for license cache
 * @param licenseKey - License key to invalidate
 * @param logger - Logger instance
 */
export async function invalidateLicenseCache(
  licenseCache: KVNamespace,
  licenseKey: string,
  logger: Logger
): Promise<void> {
  try {
    const cacheKey = `license:${licenseKey}`;
    await licenseCache.delete(cacheKey);

    logger.log('info', 'License cache invalidated');
  } catch (error) {
    logger.log('error', 'Failed to invalidate license cache', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
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
 * @returns Formatted balance information
 */
export function formatMeterBalance(balance: number): {
  credits_remaining: number;
  minutes_remaining: number;
  credits_per_minute: number;
} {
  const normalizedBalance = roundToTenth(balance);
  const minutesRemaining = Math.floor(normalizedBalance / CREDITS_PER_MINUTE);

  return {
    credits_remaining: normalizedBalance,
    minutes_remaining: minutesRemaining,
    credits_per_minute: CREDITS_PER_MINUTE,
  };
}
