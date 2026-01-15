// CREDITS MIDDLEWARE
// Validates credit balance and handles deduction after transcription.
// Works with both licensed users (Polar meters) and trial users (device credits).

import type { RequestContext, AuthenticatedUser } from './context';
import {
  type PipelineResult,
  ok,
  fail,
  insufficientCreditsResponse,
  deviceCreditsExhaustedResponse,
  ipRateLimitResponse,
} from './response';
import { CREDITS_PER_MINUTE, TRIAL_CREDIT_ALLOCATION, API_BASE_URL } from '../constants';
import { roundToTenth, roundUpToTenth } from '../utils/utils';
import { recordUsage, hasSufficientBalance } from '../billing/billing';
import { deductDeviceCredits, getDeviceBalance } from '../billing/device-credits';
import { checkRateLimit, incrementUsage } from '../middleware/rate-limiter';

// Approximate audio bitrate for credit estimation
// Most compressed audio (m4a, mp3, aac) is ~128kbps = 16KB/sec
// ~1MB ≈ 60 seconds of audio
const BYTES_PER_MINUTE_ESTIMATE = 1024 * 1024; // 1MB per minute

/**
 * Estimate credits needed based on file size.
 * Used BEFORE consuming the audio stream.
 */
export function estimateCreditsFromSize(sizeBytes: number): number {
  const estimatedMinutes = sizeBytes / BYTES_PER_MINUTE_ESTIMATE;
  const estimatedSeconds = Math.max(10, estimatedMinutes * 60);
  const estimatedCredits = (estimatedSeconds / 60) * CREDITS_PER_MINUTE;
  return Math.max(0.1, roundUpToTenth(estimatedCredits));
}

/**
 * Validate that the user has sufficient credits for the estimated usage.
 *
 * For licensed users: Checks credit balance.
 * For trial users: Checks both device credits AND IP rate limit.
 */
export async function validateCredits(
  ctx: RequestContext,
  user: AuthenticatedUser,
  estimatedCredits: number
): Promise<PipelineResult> {
  ctx.estimatedCredits = estimatedCredits;

  if (user.type === 'licensed') {
    return validateLicensedCredits(ctx, user, estimatedCredits);
  } else {
    return validateTrialCredits(ctx, user, estimatedCredits);
  }
}

/**
 * Validate credits for licensed users.
 */
async function validateLicensedCredits(
  ctx: RequestContext,
  user: AuthenticatedUser,
  estimatedCredits: number
): Promise<PipelineResult> {
  const balance = roundToTenth(user.credits);

  // Note: Credit check may be temporarily disabled for testing
  // Uncomment when billing is fully operational
  if (!hasSufficientBalance(balance, estimatedCredits)) {
    ctx.logger.log('warn', 'Insufficient credits - licensed user request rejected', {
      balance,
      estimated: estimatedCredits,
      deficit: roundToTenth(estimatedCredits - balance),
      action: 'User needs to purchase more credits',
    });
    return fail(insufficientCreditsResponse(balance, estimatedCredits));
  }

  ctx.logger.log('info', 'Licensed user has sufficient credits - pre-flight check passed', {
    balance,
    estimated: estimatedCredits,
    afterTransaction: roundToTenth(balance - estimatedCredits),
  });

  return ok(undefined);
}

/**
 * Validate credits for trial users.
 * Checks both device credits AND IP rate limit.
 */
async function validateTrialCredits(
  ctx: RequestContext,
  user: AuthenticatedUser,
  estimatedCredits: number
): Promise<PipelineResult> {
  const deviceId = user.deviceId!;

  // Check device credits
  const deviceBalance = await getDeviceBalance(ctx.env.DEVICE_CREDITS, deviceId, ctx.logger);

  if (deviceBalance.isExhausted || deviceBalance.creditsRemaining < estimatedCredits) {
    ctx.logger.log('warn', 'Trial credits exhausted - device has no remaining credits', {
      remaining: deviceBalance.creditsRemaining,
      estimated: estimatedCredits,
      totalAllocated: deviceBalance.totalAllocated,
      action: 'User needs to purchase a license to continue',
    });
    return fail(deviceCreditsExhaustedResponse(
      deviceBalance.creditsRemaining,
      deviceBalance.totalAllocated
    ));
  }

  // Check IP rate limit (anti-abuse for trial users)
  const rateLimit = await checkRateLimit(
    ctx.env.RATE_LIMITER,
    ctx.clientIP,
    estimatedCredits,
    ctx.logger
  );

  if (!rateLimit.allowed) {
    ctx.logger.log('warn', 'IP daily quota exceeded - anti-abuse protection triggered', {
      deviceId,
      ip: ctx.clientIP,
      creditsRemaining: rateLimit.creditsRemaining,
      resetsAt: rateLimit.resetsAt,
      action: 'User must wait until quota resets or purchase a license',
    });
    return fail(ipRateLimitResponse(rateLimit.resetsAt));
  }

  ctx.logger.log('info', 'Trial user passed all credit checks - device and IP quota OK', {
    deviceCredits: deviceBalance.creditsRemaining,
    ipQuotaRemaining: rateLimit.creditsRemaining,
    estimated: estimatedCredits,
    deviceAfterTransaction: roundToTenth(deviceBalance.creditsRemaining - estimatedCredits),
  });

  return ok(undefined);
}

/**
 * Deduct credits after successful transcription.
 * Call this in ctx.waitUntil() to run in background.
 *
 * @param ctx - Request context
 * @param user - Authenticated user
 * @param actualCredits - Actual credits to deduct (from transcription result)
 * @param metadata - Usage metadata for logging
 */
export async function deductCredits(
  ctx: RequestContext,
  user: AuthenticatedUser,
  actualCredits: number,
  metadata: Record<string, unknown>
): Promise<void> {
  if (user.type === 'licensed') {
    // Licensed user: Record usage via Next.js API
    // Also updates KV cache with new balance to keep it in sync
    await recordUsage(
      ctx.env.LICENSE_CACHE,
      API_BASE_URL,
      user.licenseKey!,
      actualCredits,
      metadata,
      ctx.logger
    );
  } else {
    // Trial user: Deduct from device credits AND IP quota
    await Promise.all([
      deductDeviceCredits(
        ctx.env.DEVICE_CREDITS,
        user.deviceId!,
        actualCredits,
        ctx.logger
      ),
      incrementUsage(
        ctx.env.RATE_LIMITER,
        ctx.clientIP,
        actualCredits,
        ctx.logger
      ),
    ]);
  }

  ctx.logger.log('info', 'Credits successfully deducted - user balance updated', {
    userType: user.type,
    credits: actualCredits,
    storage: user.type === 'licensed' ? 'Supabase database + KV cache' : 'KV (device + IP quota)',
  });
}
