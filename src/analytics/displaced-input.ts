/**
 * What reading it yourself would have cost, measured here rather than reported.
 *
 * EVERY TOOL THAT STATED ITS OWN SAVING STATED A NUMBER THAT WAS NOT WHAT IT
 * SENT. Measured across the fourteen benched tools: smart_dependencies declared
 * a baseline of 0 and a saving of -11 on a call that really avoided 63% of a
 * 211-token file; smart_tsconfig claimed +8.21% where the wire said -2.9%;
 * smart_package_json printed -92% in its own footer where the wire said -20.9%;
 * smart_security printed a flat 85% for three fixtures of three different
 * sizes. None of them was lying on purpose -- each counted a payload it then
 * wrapped in more metadata, or counted a compact form it did not send.
 *
 * A number a tool reports about itself can never be better than the tool's own
 * bookkeeping. So this module does not ask: it takes the arguments the caller
 * actually passed, reads the files they name, and counts them. The other half
 * of the ratio -- what went back -- is counted off the wire text. Both sides
 * are then measured by the same party with the same counter, which is the only
 * arrangement under which the difference between them means anything.
 */

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TokenCounter } from '../core/token-counter.js';

/**
 * How many files one call may be credited with displacing.
 *
 * A tool pointed at a directory can name hundreds, and reading them all on
 * every call would make the accounting more expensive than the work. A call
 * over the cap is not measured at all rather than measured partially: half a
 * baseline is a flattering baseline.
 */
const MAX_FILES = 24;

/**
 * The largest input one call may be credited with displacing, in bytes.
 *
 * Same reasoning as the file cap, in the other dimension.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Argument names that hold a path, or a list of them.
 *
 * The first six names, and only those, are also `anchorsOf` in
 * src/server/disclosure.ts, which decides which file a reply is about. The two
 * lists answer different questions and are deliberately separate, but a name
 * that is a path to one of them is a path to the other, so they share a
 * vocabulary and a test holds them to the published schemas.
 *
 * NAMED RATHER THAN SNIFFED. Any string can look like a path, and a tool that
 * takes a glob, a package name or a git ref would then have its argument read
 * off disk on the off-chance -- so the list is explicit, and an argument that
 * is not on it is not read however path-shaped it looks.
 */
const PATH_ARGUMENTS: readonly string[] = [
  'file_path',
  'filePath',
  'path',
  'file',
  'files',
  'paths',
  'filePaths',
  'envFile',
  'configPath',
  'tsconfig',
  'packageJsonPath',
  'entryPoint',
  'entryPoints',
];

/** What the recorder measured for itself, with no tool's arithmetic in it. */
export interface DisplacedInput {
  /** Tokens the caller would have spent reading the files it named. */
  readonly tokens: number;
  /** Those files' bytes. */
  readonly bytes: number;
  /** A digest of the text that was counted, so a row can be re-derived. */
  readonly sha256: string;
  /** How many files were read. Never a path: a path is the caller's business. */
  readonly files: number;
}

const counter = new TokenCounter();

/** Every path the arguments name, in the order the argument list gives them. */
function declaredPaths(args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  for (const name of PATH_ARGUMENTS) {
    const value = record[name];
    if (typeof value === 'string') {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value)
        if (typeof entry === 'string') paths.push(entry);
    }
  }
  return paths;
}

/**
 * Measure what the caller's own read would have cost, or null if it cannot be
 * measured exactly.
 *
 * NULL IS THE IMPORTANT RETURN. A tool given content inline, pointed at a
 * directory, or pointed at something that is not there displaced an amount
 * this module cannot establish, and a missing baseline must read as missing
 * rather than as a measured zero -- a zero baseline is what produced
 * `tokensSaved: -11` for a tool that saves 63%.
 *
 * @param resolvedPaths files the arguments do not name but the tool resolved
 *   for itself and reported: a `package.json` found under a directory, every
 *   file in an `extends` chain. They are measured here exactly like the named
 *   ones -- read with the same reader, counted with the same counter -- so a
 *   tool's private resolution rule can widen the baseline without a tool's
 *   arithmetic entering it. A path named twice across the two lists is still
 *   counted once.
 */
export async function measureDisplacedInput(
  args: unknown,
  resolvedPaths: readonly string[] = []
): Promise<DisplacedInput | null> {
  const paths = [...declaredPaths(args), ...resolvedPaths];
  if (paths.length === 0 || paths.length > MAX_FILES) return null;

  const seen = new Set<string>();
  const texts: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    // A path named twice is one file, and must be counted once: two arguments
    // pointing at the same file would otherwise double the baseline.
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const stats = await stat(path);
      if (!stats.isFile()) return null;
      bytes += stats.size;
      if (bytes > MAX_BYTES) return null;
      texts.push(await readFile(path, 'utf8'));
    } catch {
      // Unreadable, absent, or not a file: this call's baseline is unknown.
      return null;
    }
  }

  if (texts.length === 0) return null;
  // Joined the way a caller reading them in sequence would see them, which is
  // also how the bench joins its own multi-file baselines.
  const text = texts.join('\n');
  return {
    tokens: counter.count(text).tokens,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    files: texts.length,
  };
}
