/**
 * Centralized cache helper functions
 * Provides consistent caching interface across all tools
 */

import { CacheEngine } from '../core/cache-engine';
import { compress, decompress } from '../tools/shared/compression-utils';

/**
 * Get cached content with automatic decompression
 */
export function cacheGet(
  cache: CacheEngine,
  key: string
): string | null {
  const cachedData = cache.get(key);
  if (!cachedData) {
    return null;
  }

  try {
    // Decompress from base64-encoded gzip
    const decompressed = decompress(Buffer.from(cachedData, 'base64'), 'gzip');
    return decompressed.toString();
  } catch (error) {
    console.error('Cache decompression failed:', error);
    return null;
  }
}

/**
 * Set cached content with automatic compression
 */
export function cacheSet(
  cache: CacheEngine,
  key: string,
  content: string
): void {
  try {
    // Compress and store as base64-encoded gzip
    const result = compress(content, 'gzip');
    cache.set(
      key,
      result.compressed.toString('base64'),
      result.originalSize,
      result.compressedSize
    );
  } catch (error) {
    console.error('Cache compression failed:', error);
  }
}
