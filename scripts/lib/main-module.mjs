/**
 * Whether a module is the process entry point -- through npm's bin link too.
 *
 * WHY A BASENAME TEST AND A `resolve()` TEST BOTH FAIL HERE. npm links a bin as
 * `node_modules/.bin/<name>`, which on POSIX is a symlink to the real file.
 * Node derives `import.meta.url` from the REALPATH but leaves `process.argv[1]`
 * as the path the OS was handed, so for every linked bin the two disagree:
 * measured through a link, `pathToFileURL(resolve(argv[1])).href === meta.url`
 * is false while the realpath comparison is true. And the basename disagrees as
 * well, because the link is named for the command, not for the file.
 *
 * A guard built on either one is false when the command is run the documented
 * way, so the module's CLI block never executes: exit 0, no output, nothing
 * written. That is indistinguishable from success, which is why this is shared
 * rather than restated -- `token-optimizer-install-client` shipped with the
 * basename form and did exactly that.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The realpath of `path`, or its absolute form when it does not exist. */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `moduleUrl` names the module node was asked to run.
 *
 * Both sides are canonicalised, so this holds whether node resolved the entry
 * through the link (the default) or kept it with `--preserve-symlinks-main`.
 */
export function isMainModule(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return canonical(invoked) === canonical(fileURLToPath(moduleUrl));
}
