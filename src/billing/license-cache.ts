// LICENSE CACHE MODULE
// Caches license validation results to reduce Polar API calls
//
// CACHE STRATEGY:
// - Cache valid licenses for 7 days
// - Cache invalid licenses for 1 hour (to prevent abuse)
// - Key format: `license:{license_key_hash}`
//
// BENEFITS:
// - Reduces Polar API calls from 2 per request to ~0 (cache hit)
// - Faster response times (no API latency)
// - Stays within Polar rate limits (100 req/s, 300 req/min)

import { Logger } from '../utils/logger';

// Cache configuration
const VALID_LICENSE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const INVALID_LICENSE_TTL = 60 * 60; // 1 hour in seconds

interface CachedLicense {
  customerId: string;
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
  kv: any,
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

    logger.log('info', 'License cache hit', {
      customerId: cached.customerId,
      isValid: cached.isValid,
      cacheAge: Math.floor((Date.now() - cached.cachedAt) / 1000) + 's',
    });

    return cached as CachedLicense;
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
 * @param customerId - Customer ID from Polar
 * @param isValid - Whether the license is valid
 * @param logger - Logger instance
 */
export async function setLicenseInCache(
  kv: any,
  licenseKey: string,
  customerId: string | null,
  isValid: boolean,
  logger: Logger
): Promise<void> {
  try {
    const cacheKey = `license:${licenseKey}`;
    const ttl = isValid ? VALID_LICENSE_TTL : INVALID_LICENSE_TTL;

    const cacheData: CachedLicense = {
      customerId: customerId || '',
      isValid,
      cachedAt: Date.now(),
    };

    await kv.put(cacheKey, JSON.stringify(cacheData), {
      expirationTtl: ttl,
    });

    logger.log('info', 'License cached', {
      customerId: customerId || 'none',
      isValid,
      ttl: isValid ? '7 days' : '1 hour',
    });
  } catch (error) {
    logger.log('error', 'Failed to cache license', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // Don't throw - caching failure shouldn't break the request
  }
}

/**
 * Invalidate a license in cache (e.g., when user deactivates)
 *
 * @param kv - KV namespace for license cache
 * @param licenseKey - License key to invalidate
 * @param logger - Logger instance
 */
export async function invalidateLicenseCache(
  kv: any,
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
