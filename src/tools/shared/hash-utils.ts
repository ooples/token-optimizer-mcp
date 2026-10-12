/**
 * Hashing utilities for cache invalidation and file tracking
 */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { sessionScope } from './session-scope.js';

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
 *
 * SCOPED TO THE SESSION (#488). The cache is shared by every server process, so
 * a path-only key let one session's write become another session's diff base,
 * and a reader that never saw the file was answered `// No changes`. The writer
 * and the reader of a handoff run in the same session, so both still agree.
 */
export function lastWrittenKey(path: string): string {
  return generateCacheKey('file-content', { path, session: sessionScope() });
}

/**
 * How long a written base is kept. A base only ever saves a resend, so it need
 * not outlive the session that wrote it; without an expiry, a per-process
 * session id would leave one entry per file per server process forever.
 */
export const LAST_WRITTEN_TTL_SECONDS = 3600;

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
