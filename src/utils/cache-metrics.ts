/**
 * Shared cache metrics utilities
 *
 * This module provides common calculation functions for cache statistics
 * to prevent code duplication across the codebase.
 */

/**
 * Calculate cache hit rate as a percentage
 * @param cacheHits Number of cache hits
 * @param cacheMisses Number of cache misses
 * @returns Hit rate as a percentage (0-100), or 0 if no cache operations
 */
export function calculateCacheHitRate(
  cacheHits: number,
  cacheMisses: number
): number {
  const total = cacheHits + cacheMisses;

  if (total === 0) {
    return 0;
  }

  return (cacheHits / total) * 100;
}

/**
 * Calculate cache miss rate as a percentage
 * @param cacheHits Number of cache hits
 * @param cacheMisses Number of cache misses
 * @returns Miss rate as a percentage (0-100), or 0 if no cache operations
 */
export function calculateCacheMissRate(
  cacheHits: number,
  cacheMisses: number
): number {
  const total = cacheHits + cacheMisses;

  if (total === 0) {
    return 0;
  }

  return (cacheMisses / total) * 100;
}
