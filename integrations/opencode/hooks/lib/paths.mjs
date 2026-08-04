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
function normaliseOnce(input, cwd) {
  if (typeof input !== 'string' || !input) return input;

  let path = input.trim();
  if (!path) return input;

  // Strip surrounding quotes a shell command may carry.
  // LENGTH >= 2, because `startsWith` and `endsWith` both match the SAME
  // character on a one-character string: a lone `"` looked like a quoted empty
  // path and `slice(1, -1)` turned it into one.
  if (path.length >= 2 &&
      ((path.startsWith('"') && path.endsWith('"')) ||
       (path.startsWith("'") && path.endsWith("'")))) {
    path = path.slice(1, -1);
  }

  path = path.replace(/\\/g, '/');

  // Resolve relatives against the session's cwd so `src/a.ts` and the absolute
  // form of the same file share one identity.
  //
  // JOINED BY HAND rather than through path.resolve, which is platform-specific:
  // on a POSIX host it does not recognise `C:/Users/me/repo` as absolute, so a
  // Windows cwd produced `/home/runner/.../C:/Users/me/repo/src/a.ts`. That is
  // not hypothetical -- a graph written on Windows and read anywhere else, or
  // the fleet auditor looking across machines, hits exactly this. The segment
  // loop below already collapses `.` and `..`, so a plain join is enough and is
  // the same on every host.
  if (!isAbsolute(path) && !/^[A-Za-z]:/.test(path)) {
    if (cwd) {
      const base = canonicalPath(cwd);
      path = `${base.endsWith('/') ? base.slice(0, -1) : base}/${path}`;
    }
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

  // ROOT SURVIVES THE COLLAPSE. `/` splits to ['', ''], the loop keeps only the
  // leading '' that marks absoluteness, and joining a single empty segment
  // yields '' -- so the root directory canonicalised to the empty string, and a
  // second pass could not get back.
  if (path === '' && segments.length === 1 && segments[0] === '') path = '/';

  // TRIMMED ON THE WAY OUT AS WELL AS ON THE WAY IN.
  //
  // The input is trimmed at the top because surrounding whitespace is not part
  // of a path. Collapsing segments can RE-EXPOSE it: `a /` splits to the single
  // segment `a ` and joins back to `a `, which the next call would then trim to
  // `a` -- so the same file got two identities depending on how many times its
  // path had been canonicalised, which is the fragmentation this module exists
  // to end.
  //
  // Applying the rule the function already commits to at both ends reaches the
  // fixed point in one pass. Whitespace INSIDE a path is untouched: `x /y` and
  // `C:/ x` canonicalise to themselves.
  path = path.trim();

  // MSYS TRANSLATION AFTER THE COLLAPSE, NOT BEFORE.
  //
  // Running it first made canonicalPath non-idempotent, which a generated-
  // input property caught: `/./c/Users/me/x` is not MSYS-shaped, so the first
  // pass only dropped the `.` and returned `/c/Users/me/x` -- which IS
  // MSYS-shaped, so a second pass returned `C:/Users/me/x`. The same file then
  // held two identities depending on how many times its path had been round-
  // tripped, which is precisely the fragmentation this module exists to end.
  //
  // Translating after normalisation means one pass reaches the fixed point.
  const msys = MSYS.exec(path);
  if (msys) path = `${msys[1].toUpperCase()}:/${msys[2]}`;

  // Upper-case a drive letter however it arrived, so `c:/x` and `C:/x` agree.
  path = path.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toUpperCase()}:`);

  // A trailing separator is not part of a file's identity.
  if (path.length > 3 && path.endsWith('/')) path = path.slice(0, -1);

  return path;
}

/**
 * Canonicalises to a FIXED POINT, by construction rather than by patching.
 *
 * One pass is not idempotent and cannot easily be made so. Its steps interact:
 * collapsing `a /` re-exposes whitespace the leading trim had already handled;
 * collapsing `'.'!'/` produces `'.'!'`, which the NEXT call reads as a quoted
 * path and unquotes. Generated inputs found three such shapes in a row, each
 * fixed individually and each replaced by another -- which is the signal that
 * the invariant belongs in the structure, not in another special case.
 *
 * So the pass is applied until it stops changing anything. Every step is
 * non-expanding (trim, unquote and segment-collapse only shorten; the MSYS
 * rewrite preserves length), so the sequence must reach a fixed point, and the
 * iteration cap is a backstop rather than a truncation.
 *
 * WHY IT MATTERS: this function decides file IDENTITY. A path whose canonical
 * form depends on how many times it has been canonicalised gives one file two
 * graph nodes, with findings anchored under one invisible from the other.
 */
export function canonicalPath(input, cwd) {
  let path = normaliseOnce(input, cwd);
  for (let i = 0; i < 8; i++) {
    const next = normaliseOnce(path, cwd);
    if (next === path) return path;
    path = next;
  }
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
