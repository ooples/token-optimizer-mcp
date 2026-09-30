/**
 * What a report says about the file it read.
 *
 * Two fields recur in every file-reading tool's metadata, and both used to be
 * emitted in their longest possible form: the sha256 of the file, all 64
 * characters of it, and the absolute path the caller had itself just passed in.
 * Measured on a 97-token .env, the pair cost 57 tokens -- a third of the whole
 * report -- and answered nothing the shorter forms do not.
 */

import * as path from 'path';

/**
 * Characters of a file digest a response carries.
 *
 * The full digest is what a cache key is built from and stays inside the tool;
 * a caller uses the value only to tell one reading of a file from another, and
 * 16 hex characters are 64 bits of that. The other 48 cost 26 tokens.
 */
export const RESPONSE_HASH_CHARS = 16;

export function shortHash(digest: string): string {
  return digest.slice(0, RESPONSE_HASH_CHARS);
}

/**
 * The shortest path that still identifies the file.
 *
 * An absolute Windows path costs about 25 tokens once JSON has escaped every
 * separator to a doubled backslash, since each escape is its own token. A file
 * inside the working directory is named relative to it with forward slashes;
 * anything outside stays absolute, because a ../../.. chain is neither shorter
 * nor clearer.
 */
export function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join('/');
}
