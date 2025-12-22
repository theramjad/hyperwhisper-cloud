// LICENSE CACHE MODULE
// Caches license validation results to reduce API calls
//
// CACHE STRATEGY:
// - Cache valid licenses for 1 hour (credits page and refresh button bypass cache)
// - Cache invalid licenses for 1 hour (to prevent abuse)
// - Key format: `license:{license_key}`
//
// BENEFITS:
// - Reduces Next.js API calls significantly (cache hit for most transcription requests)
// - Faster response times (no API latency)
// - Users can force refresh via credits page or refresh button to see updated balance
//
// NOTE: Valid license TTL is 1 hour; users bypass cache when viewing credits page

import { Logger } from '../utils/logger';

// Cache configuration
// Valid licenses cached for 1 hour (users bypass cache via credits page/refresh)
// Invalid licenses cached for 1 hour (prevent brute-force)
const VALID_LICENSE_TTL = 60 * 60; // 1 hour in seconds
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
      logger.log('info', 'KV cache miss - will validate license via Next.js API');
      return null;
    }

    const cachedData = cached as CachedLicense;

    logger.log('info', 'KV cache hit - using cached license data (no API call needed)', {
      credits: cachedData.credits,
      isValid: cachedData.isValid,
      cacheAge: Math.floor((Date.now() - cachedData.cachedAt) / 1000) + 's',
    });

    return cachedData;
  } catch (error) {
    logger.log('error', 'KV cache read failed - will fallback to API validation', {
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

    logger.log('info', 'License data written to KV cache - subsequent requests will use cached data', {
      credits,
      isValid,
      ttl: '1 hour',
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  } catch (error) {
    logger.log('error', 'KV cache write failed - subsequent requests will hit API (degraded performance)', {
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

    logger.log('info', 'KV cache entry deleted - next validation will fetch fresh license data from API');
  } catch (error) {
    logger.log('error', 'KV cache deletion failed - stale data may persist until TTL expires', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
