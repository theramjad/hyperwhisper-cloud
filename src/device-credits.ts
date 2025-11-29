// DEVICE CREDITS MODULE
// Manages trial credits for unlicensed users identified by device_id
//
// ALLOCATION:
// - 150 credits per device_id (one-time allocation)
// - Approximately 24 minutes of transcription
// - Stored in KV as `device_credits:{device_id}`
//
// SECURITY:
// - Combined with IP rate limiting to prevent device_id spoofing
// - Both device credits AND IP quota must have sufficient balance
// - Deductions happen against both pools

import { Logger } from './logger';
import { CREDITS_PER_MINUTE, TRIAL_CREDIT_ALLOCATION } from './constants/credits';
import { roundToTenth } from './utils';

// Configuration
const INITIAL_DEVICE_CREDITS = TRIAL_CREDIT_ALLOCATION; // One-time allocation for new devices

export interface DeviceCreditsBalance {
  creditsRemaining: number;
  totalAllocated: number;
  creditsUsed: number;
  minutesRemaining: number;
  isExhausted: boolean;
}

/**
 * Initialize a new device with starting credits
 * Only called once per device_id
 *
 * @param kv - KV namespace for device credits storage
 * @param deviceId - Unique device identifier
 * @param logger - Logger instance
 */
async function initializeDevice(
  kv: any,
  deviceId: string,
  logger: Logger
): Promise<void> {
  const deviceKey = `device_credits:${deviceId}`;

  try {
    // Initialize with full credit allocation
    const initialBalance = {
      creditsRemaining: INITIAL_DEVICE_CREDITS,
      totalAllocated: INITIAL_DEVICE_CREDITS,
      creditsUsed: 0,
    };

    // Store with no expiration (trial credits never expire)
    await kv.put(deviceKey, JSON.stringify(initialBalance));

    logger.log('info', 'New device initialized with trial credits', {
      deviceId,
      initialCredits: INITIAL_DEVICE_CREDITS,
    });
  } catch (error) {
    logger.log('error', 'Failed to initialize device', {
      error: error instanceof Error ? error.message : 'Unknown error',
      deviceId,
    });
    throw error;
  }
}

/**
 * Get credit balance for a device
 * Initializes the device if it doesn't exist yet
 *
 * @param kv - KV namespace for device credits storage
 * @param deviceId - Unique device identifier
 * @param logger - Logger instance
 * @returns Device credit balance
 */
export async function getDeviceBalance(
  kv: any,
  deviceId: string,
  logger: Logger
): Promise<DeviceCreditsBalance> {
  const deviceKey = `device_credits:${deviceId}`;

  try {
    const balanceData = await kv.get(deviceKey);

    if (!balanceData) {
      // New device - initialize with trial credits
      await initializeDevice(kv, deviceId, logger);

      const initialCredits = roundToTenth(INITIAL_DEVICE_CREDITS);

      return {
        creditsRemaining: initialCredits,
        totalAllocated: INITIAL_DEVICE_CREDITS,
        creditsUsed: 0,
        minutesRemaining: Math.floor(initialCredits / CREDITS_PER_MINUTE),
        isExhausted: false,
      };
    }

    // Parse existing balance
    const balance = JSON.parse(balanceData);

    const creditsRemaining = roundToTenth(balance.creditsRemaining ?? 0);
    const creditsUsed = roundToTenth(balance.creditsUsed ?? 0);

    // Estimate remaining minutes using shared conversion rate
    const minutesRemaining = Math.floor(creditsRemaining / CREDITS_PER_MINUTE);

    logger.log('info', 'Device balance retrieved', {
      deviceId,
      creditsRemaining: balance.creditsRemaining,
      creditsUsed: balance.creditsUsed,
      minutesRemaining,
    });

    return {
      creditsRemaining,
      totalAllocated: balance.totalAllocated,
      creditsUsed,
      minutesRemaining,
      isExhausted: creditsRemaining <= 0,
    };
  } catch (error) {
    logger.log('error', 'Failed to get device balance', {
      error: error instanceof Error ? error.message : 'Unknown error',
      deviceId,
    });

    // On error, return exhausted state for safety
    return {
      creditsRemaining: 0,
      totalAllocated: INITIAL_DEVICE_CREDITS,
      creditsUsed: INITIAL_DEVICE_CREDITS,
      minutesRemaining: 0,
      isExhausted: true,
    };
  }
}

/**
 * Deduct credits from device balance
 *
 * @param kv - KV namespace for device credits storage
 * @param deviceId - Unique device identifier
 * @param creditsToDeduct - Number of credits to deduct
 * @param logger - Logger instance
 * @returns Updated balance
 */
export async function deductDeviceCredits(
  kv: any,
  deviceId: string,
  creditsToDeduct: number,
  logger: Logger
): Promise<DeviceCreditsBalance> {
  const deviceKey = `device_credits:${deviceId}`;

  try {
    // Get current balance
    const currentBalance = await getDeviceBalance(kv, deviceId, logger);

    // Calculate new balance
    const newCreditsUsed = roundToTenth(currentBalance.creditsUsed + creditsToDeduct);
    const newCreditsRemaining = roundToTenth(Math.max(0, currentBalance.creditsRemaining - creditsToDeduct));

    const updatedBalance = {
      creditsRemaining: newCreditsRemaining,
      totalAllocated: currentBalance.totalAllocated,
      creditsUsed: newCreditsUsed,
    };

    // Store updated balance
    await kv.put(deviceKey, JSON.stringify(updatedBalance));

    logger.log('info', 'Device credits deducted', {
      deviceId,
      creditsDeducted: creditsToDeduct,
      previousRemaining: currentBalance.creditsRemaining,
      newRemaining: newCreditsRemaining,
      totalUsed: newCreditsUsed,
    });

    return {
      creditsRemaining: newCreditsRemaining,
      totalAllocated: currentBalance.totalAllocated,
      creditsUsed: newCreditsUsed,
      minutesRemaining: Math.floor(newCreditsRemaining / CREDITS_PER_MINUTE),
      isExhausted: newCreditsRemaining <= 0,
    };
  } catch (error) {
    logger.log('error', 'Failed to deduct device credits', {
      error: error instanceof Error ? error.message : 'Unknown error',
      deviceId,
      creditsToDeduct,
    });
    throw error;
  }
}

/**
 * Check if device has sufficient credits for a request
 *
 * @param balance - Device credit balance
 * @param requiredCredits - Credits needed for this request
 * @returns Whether device has sufficient balance
 */
export function hasDeviceSufficientCredits(
  balance: DeviceCreditsBalance,
  requiredCredits: number
): boolean {
  return balance.creditsRemaining >= requiredCredits;
}

/**
 * Format device balance for API response
 *
 * @param balance - Device credit balance
 * @returns Formatted balance object
 */
export function formatDeviceBalance(balance: DeviceCreditsBalance): {
  credits_remaining: number;
  total_allocated: number;
  credits_used: number;
  minutes_remaining: number;
  credits_per_minute: number;
  is_exhausted: boolean;
} {
  return {
    credits_remaining: balance.creditsRemaining,
    total_allocated: balance.totalAllocated,
    credits_used: balance.creditsUsed,
    minutes_remaining: balance.minutesRemaining,
    credits_per_minute: CREDITS_PER_MINUTE,
    is_exhausted: balance.isExhausted,
  };
}
