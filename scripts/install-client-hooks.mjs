#!/usr/bin/env node
/**
 * Installs one client's hook directory, composing the core INTO THE DESTINATION.
 *
 * WHY THIS EXISTS, and why the obvious cheaper design does not work. The ten
 * client integrations vendor byte-identical copies of the same core: 518 files
 * carrying 96 distinct blobs, 10.87MB of tarball for 1.44MB of unique content.
 * Dropping them from `files` and composing each copy on the installed machine
 * was tried (#477) and shipped a package in which all ten were silently inert,
 * because NO CLIENT RUNS ITS HOOKS FROM INSIDE THE INSTALLED PACKAGE. Each runs
 * them from a copy at a path the client dictates -- `.cursor/hooks/...`,
 * `$HOME/.codex/hooks/`, `.github/hooks/`, `${extensionPath}/hooks/` -- and a
 * copy there has no package tree above it, so nothing it runs can find the
 * composer, and the directory it was copied from had no `lib/` either.
 *
 * The inversion that does work: run the composer FROM the package, where it can
 * always be found, and have it write TO the destination, where the files are
 * actually needed. That is this script. It replaces the `cp -r` in every
 * documented install, which is what makes excluding the ten copies safe.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { CLIENT_HOOK_INSTALLS } from '../hooks-core/capabilities.mjs';
import { composeCoreFile, coreFiles } from './lib/hook-core.mjs';
import { contentMatches, readIfExists } from './lib/text.mjs';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The core's path RELATIVE TO THE DESTINATION, where it is not simply `lib`.
 *
 * The entries import `./lib/adapter.mjs`, so the core has to land beside
 * whichever directory holds them. Cline is the one that differs: its wrappers
 * sit at the top of `hooks/` and its .mjs entries one level down, so a core
 * written at the top would be imported by nothing.
 */
const LIB_WITHIN_DESTINATION = Object.freeze({
  cline: join('token-optimizer', 'lib'),
  'codex-plugin': join('hooks', 'lib'),
});

/**
 * The one client CLIENT_HOOK_INSTALLS has no entry for.
 *
 * EVERYTHING ELSE IS READ FROM THAT REGISTRY, deliberately. It already records
 * each client's source directory, whether the destination is project- or
 * home-relative, and the path the doctor diagnoses against -- and
 * generate-client-configs.mjs throws on any instruction that disagrees with it.
 * A second copy of those paths here would be the same fact in two places, which
 * is the arrangement that comment warns about.
 */
const UNREGISTERED = Object.freeze({
  'codex-plugin': Object.freeze({
    source: join('integrations', 'codex', 'plugin'),
    base: null,
    dir: null,
  }),
});

/** Every client this command can install. */
export const CLIENT_KEYS = Object.freeze([
  ...Object.keys(CLIENT_HOOK_INSTALLS),
  ...Object.keys(UNREGISTERED),
]);

/**
 * Resolves one client to a source, a destination and a core path.
 *
 * A null `dir` in the registry means that client chooses its own path and we
 * refuse to guess -- gemini and qwen are recorded that way on purpose, because
 * a plausible-looking guess writes a directory the client never reads and then
 * reports success. Those require --dest.
 */
export function specFor(client, { cwd = process.cwd() } = {}) {
  const registered = CLIENT_HOOK_INSTALLS[client] ?? UNREGISTERED[client];
  if (!registered) {
    throw new Error(
      `unknown client ${JSON.stringify(client)}; expected one of ${CLIENT_KEYS.join(', ')}`
    );
  }
  const base =
    registered.base === 'home'
      ? homedir()
      : registered.base === 'project'
        ? cwd
        : null;
  return {
    source: registered.source.split('/').join(sep),
    lib: LIB_WITHIN_DESTINATION[client] ?? 'lib',
    defaultDestination:
      base && registered.dir ? join(base, ...registered.dir.split('/')) : null,
  };
}

/** Every file under `from`, as destination-relative paths, skipping any lib dir. */
function entryFiles(from, prefix = '') {
  const out = [];
  for (const item of readdirSync(from, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (item.name === 'lib') continue;
      out.push(...entryFiles(join(from, item.name), join(prefix, item.name)));
      continue;
    }
    out.push(join(prefix, item.name));
  }
  return out;
}

/**
 * Writes `contents` to `path` so no reader ever sees a partial file.
 *
 * A client can fire several hooks at once -- parallel pre-tool calls are normal
 * -- and a plain writeFileSync onto the live path lets one process import an
 * `adapter.mjs` the other is halfway through writing. That import throws inside
 * a catch block that is deliberately silent, so the hook fails open and says
 * nothing. Writing a temporary file in the SAME directory and renaming it is
 * atomic on both platforms; a different directory would not be.
 */
function writeAtomic(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The rename already failed; the caller is told about that, not this.
    }
    throw error;
  }
}

/**
 * Installs one client, returning what it wrote.
 *
 * ADAPTER.MJS IS WRITTEN LAST, deliberately. Every generated entry tests for it
 * before importing, so "adapter.mjs exists" has to mean "the whole core landed"
 * rather than "a write was in progress". Ordering it last is what makes that
 * check honest at no cost.
 */
export function installClientHooks({
  root = ROOT,
  client,
  destination,
  cwd = process.cwd(),
  check = false,
} = {}) {
  const spec = specFor(client, { cwd });
  if (!destination && !spec.defaultDestination) {
    throw new Error(
      `${client} chooses its own hook directory, so --dest is required`
    );
  }
  const target = destination ?? spec.defaultDestination;

  const from = join(root, spec.source);
  const libraryDirectory = join(target, spec.lib);
  const names = coreFiles(root);
  const last = 'adapter.mjs';
  const ordered = [...names.filter((n) => n !== last), last];
  const written = [];
  const pending = [];

  for (const name of entryFiles(from)) {
    const source = join(from, name);
    const destinationPath = join(target, name);
    if (
      contentMatches(readIfExists(destinationPath), readIfExists(source) ?? '')
    )
      continue;
    pending.push({ kind: 'entry', source, destinationPath, name });
  }
  for (const name of ordered) {
    const contents = composeCoreFile(root, name);
    const destinationPath = join(libraryDirectory, name);
    if (contentMatches(readIfExists(destinationPath), contents)) continue;
    pending.push({ kind: 'core', contents, destinationPath, name });
  }

  if (check) return { client, destination: target, written, pending };

  for (const item of pending) {
    mkdirSync(dirname(item.destinationPath), { recursive: true });
    if (item.kind === 'entry') {
      copyFileSync(item.source, item.destinationPath);
    } else {
      writeAtomic(item.destinationPath, item.contents);
    }
    written.push(relative(target, item.destinationPath));
  }
  return { client, destination: target, written, pending };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const client = valueOf('--client');
  if (!client || argv.includes('--help')) {
    console.log(
      `usage: token-optimizer-install-client --client <${CLIENT_KEYS.join('|')}> [--dest <dir>] [--check]`
    );
    process.exit(client ? 0 : 1);
  }
  try {
    const result = installClientHooks({
      client,
      destination: valueOf('--dest'),
      check: argv.includes('--check'),
    });
    if (argv.includes('--check')) {
      console.log(
        result.pending.length === 0
          ? `${client} hooks already current in ${result.destination}`
          : `${client} would write ${result.pending.length} file(s) to ${result.destination}`
      );
      process.exit(result.pending.length === 0 ? 0 : 1);
    }
    console.log(
      result.written.length === 0
        ? `${client} hooks already current in ${result.destination}`
        : `installed ${client} hooks: ${result.written.length} file(s) in ${result.destination}`
    );
  } catch (error) {
    console.error(
      `could not install ${client} hooks: ${error && error.message ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
