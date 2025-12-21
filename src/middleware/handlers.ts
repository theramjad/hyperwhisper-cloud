// ROUTE HANDLERS MODULE
// HTTP request handlers for usage queries

import type { Env, UsageResponse } from '../types';
import { Logger } from '../utils/logger';
import { getUsageStats } from './rate-limiter';
import {
  validateAndGetCredits,
  formatMeterBalance
} from '../billing/billing';
import {
  getDeviceBalance,
  formatDeviceBalance
} from '../billing/device-credits';

/**
 * CORS headers for all responses
 */
export function getCORSHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

/**
 * Handle OPTIONS preflight requests
 */
export function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders()
  });
}

/**
 * Handle GET /usage requests to fetch current usage/balance
 *
 * For licensed users: Queries Polar meter balance
 * For trial users: Returns device credit balance
 * For anonymous users: REJECT (no identifier provided)
 */
export async function handleUsageQuery(
  url: URL,
  env: Env,
  logger: Logger,
  clientIP: string
): Promise<Response> {
  try {
    // Check for license key or device_id in query params
    // Support both 'license_key' and 'identifier' for backwards compatibility
    const queryLicenseKey = url.searchParams.get('license_key');
    const queryDeviceId = url.searchParams.get('device_id');
    const identifier = url.searchParams.get('identifier');
    const forceRefresh = url.searchParams.get('force_refresh') === 'true';

    // Allow legacy `identifier` param to represent either license key or device ID
    const resolved = resolveIdentifier({
      licenseKey: queryLicenseKey,
      deviceId: queryDeviceId,
      identifier,
      logger,
    });

    const { licenseKey, deviceId } = resolved;

    if (licenseKey) {
      // LICENSED USER: Query Next.js API for credit balance
      logger.log('info', 'Usage query for licensed user', { forceRefresh });

      // Validate license and get credit balance (with cache, unless forceRefresh)
      const { isValid, credits } = await validateAndGetCredits(
        env.LICENSE_CACHE,
        licenseKey,
        env.HYPERWHISPER_API_URL,
        env.HYPERWHISPER_API_KEY,
        logger,
        forceRefresh
      );

      if (!isValid) {
        return new Response(JSON.stringify({
          error: 'Invalid license key',
          message: 'The provided license key is invalid or expired'
        }), {
          status: 401,
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      const formattedBalance = formatMeterBalance(credits);

      const response: UsageResponse = {
        credits_remaining: formattedBalance.credits_remaining,
        minutes_remaining: formattedBalance.minutes_remaining,
        credits_per_minute: formattedBalance.credits_per_minute,
        is_licensed: true,
        is_trial: false,
        is_anonymous: false,
      };

      logger.log('info', 'Usage query successful for licensed user', {
        balance: formattedBalance.credits_remaining
      });

      return new Response(JSON.stringify(response), {
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });

    } else if (deviceId) {
      // TRIAL USER: Query device credits and IP quota
      logger.log('info', 'Usage query for trial user', {
        deviceId
      });

      // Get device credit balance
      const deviceBalance = await getDeviceBalance(env.DEVICE_CREDITS, deviceId, logger);
      const formattedDeviceBalance = formatDeviceBalance(deviceBalance);

      // Also get IP daily quota for context
      const ipStats = await getUsageStats(env.RATE_LIMITER, clientIP);

      const response: UsageResponse = {
        credits_remaining: formattedDeviceBalance.credits_remaining,
        minutes_remaining: formattedDeviceBalance.minutes_remaining,
        credits_per_minute: formattedDeviceBalance.credits_per_minute,
        is_licensed: false,
        is_trial: true,
        is_anonymous: false,
        device_id: deviceId,
        total_allocated: formattedDeviceBalance.total_allocated,
        credits_used: formattedDeviceBalance.credits_used,
        resets_at: ipStats.resetsAt.toISOString(), // IP daily quota reset time
      };

      logger.log('info', 'Usage query successful for trial user', {
        deviceId,
        deviceCredits: formattedDeviceBalance.credits_remaining,
        ipQuotaRemaining: ipStats.creditsRemaining,
      });

      return new Response(JSON.stringify(response), {
        headers: {
          ...getCORSHeaders(),
          'content-type': 'application/json',
          'X-Device-Credits-Remaining': formattedDeviceBalance.credits_remaining.toFixed(1),
          'X-IP-RateLimit-Remaining': ipStats.creditsRemaining.toFixed(1),
        }
      });

    } else {
      // ANONYMOUS USER: REJECT
      logger.log('warn', 'Usage query rejected - no identifier provided', {
        ip: clientIP
      });

      return new Response(JSON.stringify({
        error: 'Identifier required',
        message: 'You must provide either a license_key or device_id parameter'
      }), {
        status: 401,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

  } catch (error) {
    logger.log('error', 'Usage query failed', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    return new Response(JSON.stringify({
      error: 'Query failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
    });
  }
}

interface IdentifierResolution {
  licenseKey: string | null;
  deviceId: string | null;
}

interface IdentifierInputs {
  licenseKey: string | null;
  deviceId: string | null;
  identifier: string | null;
  logger: Logger;
}

function resolveIdentifier({
  licenseKey,
  deviceId,
  identifier,
  logger,
}: IdentifierInputs): IdentifierResolution {
  if (licenseKey) {
    return { licenseKey, deviceId };
  }

  if (!identifier) {
    return { licenseKey: null, deviceId };
  }

  const trimmed = identifier.trim();

  if (!trimmed) {
    return { licenseKey: null, deviceId };
  }

  if (looksLikeDeviceId(trimmed)) {
    logger.log('info', 'Identifier resolved as device ID', { identifier: maskIdentifier(trimmed) });
    return { licenseKey: null, deviceId: deviceId || trimmed };
  }

  logger.log('info', 'Identifier resolved as license key', { identifier: maskIdentifier(trimmed) });
  return { licenseKey: trimmed, deviceId };
}

function looksLikeDeviceId(value: string): boolean {
  const sha256HexPattern = /^[a-f0-9]{64}$/;

  if (sha256HexPattern.test(value)) {
    return true;
  }

  // Legacy device identifiers may be stored in UserDefaults already hashed.
  if (value.length >= 40 && /^[a-f0-9]+$/.test(value)) {
    return true;
  }

  return false;
}

function maskIdentifier(value: string): string {
  if (value.length <= 8) {
    return value;
  }

  const start = value.slice(0, 4);
  const end = value.slice(-4);
  return `${start}…${end}`;
}
