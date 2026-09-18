/**
 * Which managed clients this machine can actually launch.
 *
 * WHY DETECTION AND NOT A FIXED LIST. Activation puts a wrapper in front of a command name -- a
 * shell function, or a `.cmd` on a PATH directory of ours that comes first. Writing a wrapper for
 * every client we support would therefore claim names for tools the user has never installed, so
 * typing `qwen` on a machine without it would answer with our diagnostic instead of the shell's
 * "command not found". A wrapper is only ever created for a command that already resolves.
 *
 * OUR OWN LAUNCHER DIRECTORY IS EXCLUDED from the search, because after the first activation it is
 * on PATH and holds exactly the names we are deciding about: counting it would make every client
 * look installed from then on.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import {
  MANAGED_CLIENTS,
  managedClientIds,
} from '../hooks-core/capabilities.mjs';

/** The commands older versions wrapped unconditionally, before this file existed. */
export const LEGACY_LAUNCHER_COMMANDS = Object.freeze([
  'claude',
  'codex',
  'opencode',
]);

export function launcherDirectory() {
  return join(homedir(), '.token-optimizer', 'bin');
}

/** Is `command` on PATH, ignoring anything we installed ourselves? */
export function commandExists(
  command,
  {
    env = process.env,
    platform = process.platform,
    directory = launcherDirectory(),
  } = {}
) {
  const ours = directory
    .replaceAll('/', '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
  const names =
    platform === 'win32'
      ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
      : [command];
  return (env.PATH || env.Path || '')
    .split(delimiter)
    .filter(
      (entry) =>
        entry &&
        entry.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase() !== ours
    )
    .some((entry) => names.some((name) => existsSync(join(entry, name))));
}

/**
 * The command names to wrap on this machine.
 *
 * TOKEN_OPTIMIZER_MANAGED_CLIENTS is the escape hatch: a comma-separated list of command names, or
 * `all` for every supported one. It exists for a user whose client is installed somewhere PATH does
 * not show at install time, and for tests that must not depend on what happens to be on the box.
 */
export function launcherCommands({
  env = process.env,
  platform = process.platform,
  directory = launcherDirectory(),
} = {}) {
  const all = managedClientIds().map((id) => MANAGED_CLIENTS[id].command);
  const configured = String(env.TOKEN_OPTIMIZER_MANAGED_CLIENTS || '').trim();
  if (configured) {
    if (configured.toLowerCase() === 'all') return all;
    const wanted = new Set(
      configured
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    );
    return all.filter((command) => wanted.has(command));
  }
  return all.filter((command) =>
    commandExists(command, { env, platform, directory })
  );
}
