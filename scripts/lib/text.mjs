/**
 * Line-ending-safe file comparison and writing, shared by every generator.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED. `.gitattributes` sets `* text=auto`, so
 * generated files are stored with LF and written to the working tree with CRLF
 * on Windows. Generators build their output with '\n' regardless, so a byte
 * comparison finds every line different and reports drift that does not exist.
 *
 * sync-hook-core.mjs hit that first -- `npm test` failed on a fresh Windows
 * clone while Linux CI stayed green -- and grew a local `normalize` to fix it.
 * The fix was never applied to generate-client-entries.mjs or
 * generate-client-configs.mjs, so `npm run sync:hooks:check` went on reporting
 * ten phantom drifted entry files on every Windows checkout. The bug was not a
 * wrong comparison; it was a right comparison that reached one of three call
 * sites. Copying it a third time would have left the same hole open for a
 * fourth generator, so it lives here and the generators import it.
 *
 * This matters more since sync:hooks:check became a CI gate and `verify:all`
 * became the documented pre-flight: a gate that cannot pass locally on a
 * supported platform teaches contributors to skip it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Collapses CRLF to LF so content can be compared independently of how git
 * happened to check the file out.
 *
 * Deliberately does NOT touch a lone CR. Git's autocrlf rewrites CRLF, not CR,
 * so treating a bare CR as equivalent would hide a genuine content difference.
 */
export const normalizeEol = (text) => String(text).replace(/\r\n/g, '\n');

/**
 * Is what is on disk already this content, ignoring line endings?
 *
 * `current` is null when the file is absent, which is never a match -- a missing
 * generated file is real drift.
 */
export function contentMatches(current, contents) {
  if (current === null || current === undefined) return false;
  return normalizeEol(current) === normalizeEol(contents);
}

/** Reads a file, or null when it does not exist. Never throws. */
export function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Writes only when the content actually changed, and returns whether it did.
 *
 * The write path has the same defect as the comparison, from the other side:
 * writing LF into a CRLF working tree rewrites every byte of files that were
 * already correct. On Windows that turned `npm run sync:hooks` into a ~200-file
 * diff of pure line-ending churn with the real change buried inside it, which is
 * exactly the diff a reviewer cannot read.
 */
export function writeIfChanged(path, contents) {
  if (contentMatches(readIfExists(path), contents)) return false;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return true;
}
