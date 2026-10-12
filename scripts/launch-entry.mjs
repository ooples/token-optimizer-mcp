/**
 * What a managed launcher runs: the stable forwarder when this package lives in
 * the managed runtime, its own run-client otherwise.
 *
 * Inside `<runtime>/versions/<v>/node_modules/@ooples/token-optimizer-mcp`, a
 * launcher that named this package's run-client would pin version <v>: it would
 * keep serving <v> after every refresh and break once <v> was pruned. It names
 * `<runtime>/launch-current.mjs` instead, which runs whatever `current` names.
 * A package outside the managed runtime (a global or project install) has no
 * `current` to follow, so its launchers keep naming it directly.
 */
import { copyFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

export const FORWARDER_NAME = 'launch-current.mjs';

export function runtimeDirectory(env = process.env) {
  return env.TOKEN_OPTIMIZER_RUNTIME || join(homedir(), '.token-optimizer', 'runtime');
}

/** True when `root` is a package installed under `<runtime>/versions/<v>/`. */
export function isManagedRuntimeRoot(root, runtime = runtimeDirectory()) {
  const rel = relative(resolve(runtime, 'versions'), resolve(root));
  const parts = rel.split(sep);
  return (
    !rel.startsWith('..') &&
    parts.length === 4 &&
    parts[1] === 'node_modules' &&
    parts[2] === '@ooples' &&
    parts[3] === 'token-optimizer-mcp'
  );
}

/**
 * Copies this package's forwarder to `<runtime>/launch-current.mjs` when it is
 * missing or differs, atomically, so a launcher never starts a half-written
 * file. Returns the forwarder's path.
 */
export function installForwarder(root, runtime = runtimeDirectory()) {
  const source = join(root, 'scripts', FORWARDER_NAME);
  const target = join(runtime, FORWARDER_NAME);
  const wanted = readFileSync(source);
  if (existsSync(target) && readFileSync(target).equals(wanted)) return target;
  const temporary = `${target}.tmp-${process.pid}`;
  copyFileSync(source, temporary);
  renameSync(temporary, target);
  return target;
}

/**
 * The script a launcher for this package should run. With `install`, the
 * forwarder is written first; a dry run only computes the path.
 */
export function launcherEntry(root, { runtime = runtimeDirectory(), install = true } = {}) {
  if (!isManagedRuntimeRoot(root, runtime)) return join(root, 'scripts', 'run-client.mjs');
  return install ? installForwarder(root, runtime) : join(runtime, FORWARDER_NAME);
}
