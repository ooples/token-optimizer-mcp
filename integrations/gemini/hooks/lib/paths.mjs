// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/paths.mjs. Regenerate with `npm run sync:hooks`.
/**
 * ONE canonical spelling for a path, used everywhere a path becomes an identity
 * or a filesystem access.
 *
 * WHY THIS EXISTS. The same file arrives spelled differently depending on which
 * tool touched it:
 *
 *   Read / Edit / Write   C:\Users\me\repo\src\Auth.cs
 *   Bash on Windows       /c/Users/me/repo/src/Auth.cs
 *   several MCP clients   C:/Users/me/repo/src/Auth.cs
 *   relative forms        src/Auth.cs
 *
 * Every one of those hashed to a DIFFERENT node id, and every one was a
 * different key in the session's `seen` map. The consequences were not cosmetic:
 *
 *   - Re-read detection -- the headline feature -- missed whenever a file was
 *     touched through two different tools, which is the normal case.
 *   - The wiki graph grew a separate `file` node per spelling, so findings
 *     anchored under one were invisible to traversal from another.
 *   - Staleness compared an anchor against a path that might not even resolve.
 *   - Metrics anchors fragmented, splitting holdout stratification and
 *     downstream attribution across phantom files.
 *
 * Fixing only the size check (where this first surfaced, as a `cat` that was
 * allowed while the equivalent `Read` was refused) would have left all of that
 * in place. Identity is the actual problem, so it is solved once, here.
 */

import { isAbsolute, resolve } from 'node:path';

/** `/c/Users/x` -> `C:/Users/x`. Git Bash and MSYS write paths this way. */
const MSYS = /^\/([A-Za-z])\/(.*)$/;

/**
 * Canonicalises a path for both identity and filesystem use.
 *
 * Forward slashes and an upper-case drive letter, absolute where possible.
 * Case is otherwise PRESERVED: Windows is case-insensitive but its filesystems
 * are case-preserving, and lower-casing whole paths would make every graph key
 * unreadable for a property nothing here depends on.
 */
export function canonicalPath(input, cwd) {
  if (typeof input !== 'string' || !input) return input;

  let path = input.trim();
  if (!path) return input;

  // Strip surrounding quotes a shell command may carry.
  if ((path.startsWith('"') && path.endsWith('"')) ||
      (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  }

  const msys = MSYS.exec(path);
  if (msys) path = `${msys[1].toUpperCase()}:/${msys[2]}`;

  path = path.replace(/\\/g, '/');

  // Resolve relatives against the session's cwd so `src/a.ts` and the absolute
  // form of the same file share one identity.
  if (!isAbsolute(path) && !/^[A-Za-z]:/.test(path)) {
    if (cwd) path = resolve(canonicalPath(cwd), path).replace(/\\/g, '/');
  }

  // Collapse `.` and `..` and any doubled separators, without touching a UNC
  // prefix, which needs its leading pair.
  const unc = path.startsWith('//');
  path = (unc ? path.slice(2) : path).replace(/\/{2,}/g, '/');

  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') {
      if (segments.length === 0 && segment === '') segments.push('');
      continue;
    }
    if (segment === '..' && segments.length && segments[segments.length - 1] !== '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  path = (unc ? '//' : '') + segments.join('/');

  // Upper-case a drive letter however it arrived, so `c:/x` and `C:/x` agree.
  path = path.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toUpperCase()}:`);

  // A trailing separator is not part of a file's identity.
  if (path.length > 3 && path.endsWith('/')) path = path.slice(0, -1);

  return path;
}

/**
 * Spellings to try when reading from disk, most likely first.
 *
 * Canonicalisation is right for identity but a canonical path is not always the
 * one that resolves -- a POSIX host has no drive letters, and a path that was
 * already correct should be tried as given.
 */
export function resolvableCandidates(input, cwd) {
  const seen = new Set();
  const out = [];
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };

  add(canonicalPath(input, cwd));
  add(input);
  if (cwd && typeof input === 'string' && !isAbsolute(input) && !/^[A-Za-z]:/.test(input)) {
    add(`${cwd}/${input}`);
  }
  return out;
}
