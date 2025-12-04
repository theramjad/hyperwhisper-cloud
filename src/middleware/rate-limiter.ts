// RATE LIMITER MODULE
// Handles IP-based rate limiting for anonymous users (no license key)
//
// LIMITS:
// - 100 free credits per IP per day
// - Resets daily at midnight UTC
// - Uses minimal KV storage for tracking
//
// KEY FORMAT:
// - `ip_daily:{ip}:{date}` - Daily usage counter

import { Logger } from '../utils/logger';
import { CREDITS_PER_MINUTE, TRIAL_CREDIT_ALLOCATION } from '../constants/credits';
import { roundToTenth } from '../utils/utils';

// Configuration
const DAILY_FREE_CREDITS = TRIAL_CREDIT_ALLOCATION; // Free credits per IP per day

interface RateLimitStatus {
  allowed: boolean;
  creditsUsed: number;
  creditsRemaining: number;
  resetsAt: Date;
  isAnonymous: true; // Always true for rate-limited users
}

/**
 * Get the current UTC date as YYYY-MM-DD
 */
function getCurrentDateKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get the timestamp when the daily limit resets (midnight UTC)
 */
function getResetTime(): Date {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

/**
 * Check if an IP address has exceeded the daily rate limit
 *
 * @param kv - KV namespace for rate limit storage
 * @param ip - Client IP address
 * @param estimatedCredits - Estimated credits for this request
 * @param logger - Logger instance
 * @returns Rate limit status
 */
export async function checkRateLimit(
  kv: any,
  ip: string,
  estimatedCredits: number,
  logger: Logger
): Promise<RateLimitStatus> {
  const dateKey = getCurrentDateKey();
  const rateLimitKey = `ip_daily:${ip}:${dateKey}`;

  try {
    // Get current usage for this IP today
    const currentUsage = await kv.get(rateLimitKey);
    const parsedUsage = currentUsage ? Number.parseFloat(currentUsage) : 0;
    const creditsUsed = Number.isFinite(parsedUsage) ? roundToTenth(parsedUsage) : 0;

    // Check if adding this request would exceed the limit
    const creditsAfterRequest = roundToTenth(creditsUsed + estimatedCredits);
    const allowed = creditsAfterRequest <= DAILY_FREE_CREDITS;
    const creditsRemaining = roundToTenth(Math.max(0, DAILY_FREE_CREDITS - creditsUsed));

    logger.log('info', 'Rate limit check for anonymous user', {
      ip,
      dateKey,
      creditsUsed,
      creditsRemaining,
      estimatedCredits,
      allowed,
      dailyLimit: DAILY_FREE_CREDITS,
    });

    return {
      allowed,
      creditsUsed,
      creditsRemaining,
      resetsAt: getResetTime(),
      isAnonymous: true,
    };
  } catch (error) {
    logger.log('error', 'Rate limit check failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip,
    });

    // On error, deny access for safety
    return {
      allowed: false,
      creditsUsed: DAILY_FREE_CREDITS,
      creditsRemaining: 0,
      resetsAt: getResetTime(),
      isAnonymous: true,
    };
  }
}

/**
 * Increment the usage counter for an IP address
 *
 * @param kv - KV namespace for rate limit storage
 * @param ip - Client IP address
 * @param creditsUsed - Number of credits consumed
 * @param logger - Logger instance
 */
export async function incrementUsage(
  kv: any,
  ip: string,
  creditsUsed: number,
  logger: Logger
): Promise<void> {
  const dateKey = getCurrentDateKey();
  const rateLimitKey = `ip_daily:${ip}:${dateKey}`;

  try {
    // Get current usage
    const currentUsage = await kv.get(rateLimitKey);
    const parsedCurrent = currentUsage ? Number.parseFloat(currentUsage) : 0;
    const currentCredits = Number.isFinite(parsedCurrent) ? roundToTenth(parsedCurrent) : 0;
    const normalizedUsage = roundToTenth(creditsUsed);
    const newCredits = roundToTenth(currentCredits + normalizedUsage);

    // Store updated usage with expiration at end of day (plus 1 hour buffer)
    const secondsUntilMidnight = Math.floor((getResetTime().getTime() - Date.now()) / 1000);
    const expirationTtl = secondsUntilMidnight + 3600; // Add 1 hour buffer

    await kv.put(rateLimitKey, newCredits.toFixed(1), {
      expirationTtl,
    });

    logger.log('info', 'Usage incremented for anonymous user', {
      ip,
      dateKey,
      previousCredits: currentCredits,
      creditsAdded: normalizedUsage,
      newTotal: newCredits,
      remainingCredits: roundToTenth(Math.max(0, DAILY_FREE_CREDITS - newCredits)),
    });
  } catch (error) {
    logger.log('error', 'Failed to increment usage', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip,
      creditsUsed: roundToTenth(creditsUsed),
    });
  }
}

/**
 * Get usage statistics for an IP address
 *
 * @param kv - KV namespace for rate limit storage
 * @param ip - Client IP address
 * @returns Usage statistics
 */
export async function getUsageStats(
  kv: any,
  ip: string
): Promise<{
  creditsUsed: number;
  creditsRemaining: number;
  minutesRemaining: number;
  resetsAt: Date;
}> {
  const dateKey = getCurrentDateKey();
  const rateLimitKey = `ip_daily:${ip}:${dateKey}`;

  try {
    const currentUsage = await kv.get(rateLimitKey);
    const parsedUsage = currentUsage ? Number.parseFloat(currentUsage) : 0;
    const creditsUsed = Number.isFinite(parsedUsage) ? roundToTenth(parsedUsage) : 0;
    const creditsRemaining = roundToTenth(Math.max(0, DAILY_FREE_CREDITS - creditsUsed));

    // Estimate remaining minutes using the shared conversion factor
    const minutesRemaining = Math.floor(creditsRemaining / CREDITS_PER_MINUTE);

    return {
      creditsUsed,
      creditsRemaining,
      minutesRemaining,
      resetsAt: getResetTime(),
    };
  } catch {
    return {
      creditsUsed: 0,
      creditsRemaining: DAILY_FREE_CREDITS,
      minutesRemaining: Math.floor(DAILY_FREE_CREDITS / CREDITS_PER_MINUTE),
      resetsAt: getResetTime(),
    };
  }
}

/**
 * Format rate limit headers for HTTP response
 *
 * @param status - Rate limit status
 * @returns HTTP headers
 */
export function formatRateLimitHeaders(status: RateLimitStatus): Record<string, string> {
  const resetTimestamp = Math.floor(status.resetsAt.getTime() / 1000);

  return {
    'X-RateLimit-Limit': DAILY_FREE_CREDITS.toString(),
    'X-RateLimit-Remaining': roundToTenth(status.creditsRemaining).toFixed(1),
    'X-RateLimit-Reset': resetTimestamp.toString(),
    'X-RateLimit-Type': 'anonymous-daily',
  };
}

/**
 * Check if an IP should be completely blocked (abuse prevention)
 *
 * @param kv - KV namespace
 * @param ip - Client IP address
 * @returns Whether IP is blocked
 */
export async function isIPBlocked(
  kv: any,
  ip: string
): Promise<boolean> {
  try {
    const blockKey = `ip_blocked:${ip}`;
    const blocked = await kv.get(blockKey);
    return blocked === 'true';
  } catch {
    return false;
  }
}

/**
 * Block an IP address (for abuse prevention)
 *
 * @param kv - KV namespace
 * @param ip - Client IP address
 * @param durationHours - How long to block (default 24 hours)
 */
export async function blockIP(
  kv: any,
  ip: string,
  durationHours: number = 24
): Promise<void> {
  const blockKey = `ip_blocked:${ip}`;
  const expirationTtl = durationHours * 3600;

  await kv.put(blockKey, 'true', {
    expirationTtl,
  });
}
