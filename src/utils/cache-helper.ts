/**
 * Centralized cache helper functions
 * Provides consistent caching interface across all tools
 */

import { CacheEngine } from '../core/cache-engine.js';
import { compress, decompress } from '../tools/shared/compression-utils.js';

/**
 * Get cached content with automatic decompression
 */
export function cacheGet(cache: CacheEngine, key: string): string | null {
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
 * Reads a compressed JSON value out of the cache, or null.
 *
 * AN UNREADABLE CACHE ENTRY IS A MISS, NEVER AN ERROR.
 *
 * Several tools stored gzip with `buffer.toString()` -- no encoding, so utf8,
 * which replaces every invalid byte sequence and cannot be reversed. Measured:
 * 154 gzip bytes become 263 different ones. The entry was then unreadable for
 * ever, and because the read path let the exception escape, the tool returned
 * "incorrect header check" on every subsequent call. Fixing the WRITE was not
 * enough: existing installations kept the poisoned entry, and nothing ever
 * replaced it.
 *
 * So this decodes base64, and on any failure forgets the entry and reports a
 * miss, letting the caller recompute and overwrite it. A cache exists to make
 * a correct answer cheaper; it must never make one impossible.
 *
 * @param raw the value already read from the cache (callers usually have it)
 * @param key the key it came from, so a bad entry can be dropped
 */
export function readCompressedJson<T>(
  cache: CacheEngine,
  raw: string | null | undefined,
  key: string
): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(
      decompress(Buffer.from(raw, 'base64'), 'gzip').toString()
    ) as T;
  } catch {
    try {
      cache.delete(key);
    } catch {
      // A cache that will not forget is still better than a thrown error.
    }
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
