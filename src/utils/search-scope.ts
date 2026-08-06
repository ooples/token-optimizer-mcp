import { statSync } from 'fs';
import { escape } from 'glob';
import { dirname, basename, isAbsolute, join, resolve, sep } from 'path';

/**
 * Turns a caller's `path` into a search root, for tools that accept either a
 * directory or a single file there.
 *
 * `path` is the one argument every caller passes, because the hook that refuses
 * the built-in Grep/Glob names these tools as the replacement and "where to
 * look" is the whole question. It was wired straight into the search root:
 *
 *     cwd: options.path ?? options.cwd ?? process.cwd()
 *
 * which is right for a directory and silently wrong for a FILE. Both tools then
 * enumerate with a glob -- `['**\/*']` in grep, the caller's pattern in glob --
 * and a glob rooted AT a file matches nothing, so a search scoped to one file
 * answered:
 *
 *     { success: true, totalMatches: 0, filesSearched: 0 }
 *
 * indistinguishable from "the pattern is not there". A wrong answer that reports
 * success is worse than an error.
 */
export interface SearchScope {
  /** Directory to search from. */
  cwd: string;
  /**
   * Glob patterns selecting the scoped file, for tools that take a file list.
   * Null when `path` named a directory or was absent.
   */
  files: string[] | null;
  /**
   * Absolute path of the scoped file, for tools whose only filter is the
   * caller's own pattern and which therefore have to filter results instead.
   */
  file: string | null;
}

/**
 * @throws {Error} when `path` names nothing that exists -- the other way to
 *   produce a confident zero, and the one a typo produces.
 */
export function resolveSearchScope(
  path: string | undefined,
  cwd: string | undefined,
  fallback: string
): SearchScope {
  const base = cwd ?? fallback;
  if (!path) return { cwd: base, files: null, file: null };

  // A relative `path` resolves against the caller's `cwd` when they gave one, so
  // passing both means what it reads like rather than one silently winning.
  const resolved = isAbsolute(path) ? path : join(base, path);

  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(
      `path does not exist: ${resolved}. Searching it would report zero matches, ` +
        `which is indistinguishable from the pattern being absent.`
    );
  }

  if (stats.isDirectory()) return { cwd: resolved, files: null, file: null };

  return {
    cwd: dirname(resolved),
    // ESCAPED, because this basename is used as a glob PATTERN, not compared as
    // a string. `a[0].ts` is a legal filename and also a glob character class,
    // so the raw name would look for `a0.ts` -- absent -- and produce exactly
    // the confident zero this helper exists to prevent. An earlier version of
    // this comment claimed a plain basename avoided glob interpretation, which
    // was wrong in the one direction that matters: it read as reassurance while
    // the code did the unsafe thing.
    files: [escape(basename(resolved))],
    file: resolved,
  };
}

/**
 * Path form for comparison. Windows paths are case-insensitive and mix
 * separators, so `C:\x\y.ts` and `C:/X/y.ts` are one file and must compare equal.
 */
function comparable(path: string): string {
  const normalized = resolve(path).split(/[\\/]/).join(sep);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Narrows glob results to the scoped file, or passes them through untouched.
 *
 * Basename equality would be wrong: with the parent as the search root, a
 * `nested/target.ts` shares a basename with `target.ts` and would survive a
 * filter meant to leave exactly one file. Full resolved paths are compared.
 */
export function limitToScopedFile(
  paths: string[],
  scope: SearchScope
): string[] {
  if (!scope.file) return paths;
  const target = comparable(scope.file);
  return paths.filter(
    (p) => comparable(isAbsolute(p) ? p : join(scope.cwd, p)) === target
  );
}
