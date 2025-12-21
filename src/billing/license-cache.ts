// LICENSE CACHE MODULE
// Caches license validation results to reduce API calls
//
// CACHE STRATEGY:
// - Cache valid licenses for 5 minutes (to keep credits fresh)
// - Cache invalid licenses for 1 hour (to prevent abuse)
// - Key format: `license:{license_key}`
//
// BENEFITS:
// - Reduces Next.js API calls from 1 per request to ~0 (cache hit)
// - Faster response times (no API latency)
// - Credit balance is cached but refreshes frequently enough to stay accurate
//
// NOTE: Valid license TTL is shorter (5 min) vs old Polar approach (7 days)
// because we now cache credit balance which changes with usage

import { Logger } from '../utils/logger';

// Cache configuration
// Valid licenses cached for 5 minutes (credits change with usage)
// Invalid licenses cached for 1 hour (prevent brute-force)
const VALID_LICENSE_TTL = 5 * 60; // 5 minutes in seconds
const INVALID_LICENSE_TTL = 60 * 60; // 1 hour in seconds

export interface CachedLicense {
  credits: number; // Credit balance at time of caching
  isValid: boolean;
  cachedAt: number; // Unix timestamp
}

/**
 * Get a license from cache
 *
 * @param kv - KV namespace for license cache
 * @param licenseKey - License key to look up
 * @param logger - Logger instance
 * @returns Cached license data or null if not found
 */
export async function getLicenseFromCache(
  kv: KVNamespace,
  licenseKey: string,
  logger: Logger
): Promise<CachedLicense | null> {
  try {
    const cacheKey = `license:${licenseKey}`;
    const cached = await kv.get(cacheKey, 'json');

    if (!cached) {
      logger.log('info', 'License cache miss');
      return null;
    }

    const cachedData = cached as CachedLicense;

    logger.log('info', 'License cache hit', {
      credits: cachedData.credits,
      isValid: cachedData.isValid,
      cacheAge: Math.floor((Date.now() - cachedData.cachedAt) / 1000) + 's',
    });

    return cachedData;
  } catch (error) {
    logger.log('error', 'Failed to get license from cache', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Store a license validation result in cache
 *
 * @param kv - KV namespace for license cache
 * @param licenseKey - License key
 * @param credits - Credit balance
 * @param isValid - Whether the license is valid
 * @param logger - Logger instance
 */
export async function setLicenseInCache(
  kv: KVNamespace,
  licenseKey: string,
  credits: number,
  isValid: boolean,
  logger: Logger
): Promise<void> {
  try {
    const cacheKey = `license:${licenseKey}`;
    const ttl = isValid ? VALID_LICENSE_TTL : INVALID_LICENSE_TTL;

    const cacheData: CachedLicense = {
      credits: credits || 0,
      isValid,
      cachedAt: Date.now(),
    };

    await kv.put(cacheKey, JSON.stringify(cacheData), {
      expirationTtl: ttl,
    });

    logger.log('info', 'License cached', {
      credits,
      isValid,
      ttl: isValid ? '5 minutes' : '1 hour',
    });
  } catch (error) {
    logger.log('error', 'Failed to cache license', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // Don't throw - caching failure shouldn't break the request
  }
}

/**
 * Invalidate a license in cache (e.g., when user deactivates or buys credits)
 *
 * @param kv - KV namespace for license cache
 * @param licenseKey - License key to invalidate
 * @param logger - Logger instance
 */
export async function invalidateLicenseCache(
  kv: KVNamespace,
  licenseKey: string,
  logger: Logger
): Promise<void> {
  try {
    const cacheKey = `license:${licenseKey}`;
    await kv.delete(cacheKey);

    logger.log('info', 'License cache invalidated');
  } catch (error) {
    logger.log('error', 'Failed to invalidate license cache', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
