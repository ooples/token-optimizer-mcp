/**
 * Hashing utilities for cache invalidation and file tracking
 */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';

/**
 * Generate a hash for file content
 */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Generate a hash for a file
 */
export function hashFile(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return hashContent(content);
  } catch (error) {
    throw new Error(`Failed to hash file ${filePath}: ${error}`);
  }
}

/**
 * Generate a hash that includes file metadata (size, mtime)
 */
export function hashFileWithMetadata(filePath: string): string {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath);
    const metadataString = `${stats.size}-${stats.mtimeMs}`;
    const combined = Buffer.concat([
      Buffer.from(metadataString),
      content instanceof Buffer ? content : Buffer.from(content),
    ]);
    return hashContent(combined);
  } catch (error) {
    throw new Error(`Failed to hash file with metadata ${filePath}: ${error}`);
  }
}

/**
 * Generate a lightweight hash based on file metadata only (fast)
 */
export function hashFileMetadata(filePath: string): string {
  try {
    const stats = statSync(filePath);
    const metadataString = `${filePath}-${stats.size}-${stats.mtimeMs}`;
    return createHash('md5').update(metadataString).digest('hex');
  } catch (error) {
    throw new Error(`Failed to hash file metadata ${filePath}: ${error}`);
  }
}

/**
 * Generate a cache key from namespace and parameters
 */
/**
 * The cache key for "the last content written to this path".
 *
 * ONE KEY BOTH SIDES AGREE ON, keyed on the path ALONE. The read key
 * (`generateCacheKey('smart-read', { path, options })`) also hashes the read
 * options, so an entry seeded under one set of options is invisible to a read
 * that uses another -- which makes it useless as a handoff between a writer and
 * a reader that never agreed on options. The write key
 * (`generateCacheKey('file-write', { path })`) is a different namespace again,
 * so a writer populating it taught the reader nothing.
 *
 * Anything written through this key must go through `cacheSet`, not
 * `cache.set`: readers use `cacheGet`, which expects base64 gzip and treats a
 * decode failure as a miss, so raw text stored here would read back as nothing.
 */
export function lastWrittenKey(path: string): string {
  return generateCacheKey('file-content', { path });
}

export function generateCacheKey(
  namespace: string,
  params: Record<string, unknown>
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = params[key];
        return acc;
      },
      {} as Record<string, unknown>
    );

  const paramString = JSON.stringify(sortedParams);
  const hash = createHash('md5').update(paramString).digest('hex');
  return `${namespace}:${hash}`;
}

/**
 * Check if two hashes match
 */
export function hashesMatch(hash1: string, hash2: string): boolean {
  return hash1 === hash2;
}

/**
 * Generate a short hash (first 8 characters) for display purposes
 */
export function shortHash(content: string | Buffer): string {
  return hashContent(content).substring(0, 8);
}
