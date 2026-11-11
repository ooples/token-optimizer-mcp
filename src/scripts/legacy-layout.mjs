/**
 * Old-layout aliases inside an INSTALLED package.
 *
 * Up to 7.10.0 the package root held plugin/, integrations/, scripts/ and
 * hooks-core/. They now live under src/. Code from older versions still names
 * the old paths in an installed package, and none of it can be changed:
 *
 *   - hooks an older installer wrote into ~/.claude/settings.json run
 *     `<package>/plugin/hooks/<event>.mjs`;
 *   - hook copies installed into a client resolve the runtime's current version
 *     through `<package>/plugin/hooks` or `<package>/integrations/<client>/hooks`
 *     (runtime-switch.mjs `entryRel`), and fall back to their own, older copy
 *     when that path is missing -- silently never updating again;
 *   - managed shell launchers run `<package>/scripts/run-client.mjs`;
 *   - an older server's hooks-core loader looks for `<package>/hooks-core`.
 *
 * So every installed copy of this package carries a link at each old path,
 * pointing into src/. A link, not a copy: there is one set of files, so an old
 * path can never run different code from the new one.
 *
 * Called from postinstall, after the plugin launcher installs a runtime version,
 * and by the repair that runs when the MCP server starts. Idempotent, never
 * throws, and never runs in a git checkout, where these paths would be clutter
 * in the working tree.
 */

import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The top-level entries older versions resolve inside an installed package. */
export const LEGACY_ENTRIES = Object.freeze([
  'plugin',
  'integrations',
  'scripts',
  'hooks-core',
]);

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Remove a link at `path` that does not resolve to `target`. A real file or
 * directory is never removed: that is an old-layout package, or something that
 * is not ours.
 */
function clearStaleLink(path, target) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return true; // Nothing there.
  }
  // lstat reports a Windows junction as a symbolic link too.
  if (!stat.isSymbolicLink()) return false;
  const resolved = real(path);
  if (resolved !== null && resolved === real(target)) return false; // Already right.
  try {
    unlinkSync(path);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Ensure each legacy entry in `packageRoot` resolves to its src/ counterpart.
 * Returns the entries it created or repaired.
 */
export function ensureLegacyLayout(packageRoot, { platform = process.platform } = {}) {
  const made = [];
  try {
    if (!packageRoot || existsSync(join(packageRoot, '.git'))) return made;
    for (const name of LEGACY_ENTRIES) {
      const target = join(packageRoot, 'src', name);
      const link = join(packageRoot, name);
      if (!existsSync(target)) continue;
      if (real(link) !== null && real(link) === real(target)) continue;
      if (!clearStaleLink(link, target)) continue;
      try {
        // Relative, so it survives the package directory being renamed.
        symlinkSync(join('src', name), link, 'dir');
      } catch {
        if (platform !== 'win32') continue;
        try {
          // Without symlink rights, a junction. Junctions hold an absolute
          // target, so a renamed package leaves one dangling; the next call
          // finds it stale and replaces it.
          symlinkSync(target, link, 'junction');
        } catch {
          continue;
        }
      }
      if (real(link) === real(target)) made.push(name);
    }
  } catch {
    // Best effort: a package without the aliases still runs; only older code
    // that names the old paths misses them.
  }
  return made;
}

// `node legacy-layout.mjs <packageRoot>`: for callers that cannot await an
// import (the plugin launcher's synchronous install, the CommonJS postinstall).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  ensureLegacyLayout(process.argv[2]);
}
