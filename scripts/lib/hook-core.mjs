/**
 * The single composition of hooks-core into a vendored copy.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED: two consumers must agree
 * byte-for-byte -- `sync-hook-core.mjs`, which WRITES the copies committed to
 * git, and the gate in tests/unit/hook-core-vendored-copies.test.ts, which
 * recomposes them and compares. A second copy of this logic would let the
 * writer and the gate drift together and agree about the wrong bytes, which is
 * a vacuous gate rather than a loud one.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The copy Claude Code loads straight out of the installed package.
 */
export const PLUGIN_TARGETS = Object.freeze([join('plugin', 'hooks', 'lib')]);

/**
 * The ten client integrations' vendored copies. EVERY ONE OF THESE SHIPS.
 *
 * THIS IS THE EXPENSIVE PART OF THE PACKAGE AND IT CANNOT BE COMPOSED AWAY.
 * They are byte-identical copies of the same core -- 518 files carrying 96
 * distinct blobs, 10.87MB of tarball for 1.44MB of unique content -- so
 * excluding them from `files` and composing each one on the installed machine
 * looks free. It was tried (#477) and it is not: it shipped a package in which
 * all ten integrations were silently inert.
 *
 * WHY, measured rather than reasoned. Not one of these directories is executed
 * from inside the installed package. Every client runs its hooks from a copy
 * the user makes, at a path that client dictates:
 *
 *   cursor    .cursor/hooks/token-optimizer/      windsurf  .windsurf/hooks/...
 *   qwen      $QWEN_PROJECT_DIR/.qwen/hooks/...   cline     .clinerules/hooks/
 *   kilo      .kilo/hooks/token-optimizer/        copilot   .github/hooks/
 *   codex     $HOME/.codex/hooks/                 gemini    ${extensionPath}/hooks/
 *   codex plugin  ${PLUGIN_ROOT}/hooks/           opencode  its plugin directory
 *
 * A copy at any of those paths has no package tree above it, so a self-repair
 * step that walks up looking for the composer finds nothing -- and the copy it
 * was made from had no `lib/` either. The documented install then yields four
 * entry files and no core. Reproduced end to end from a real tarball: the
 * copied `pre-tool.mjs` printed nothing and exited 0 under
 * TOKEN_OPTIMIZER_MODE=enforce, where the in-place entry answered
 * `"permission":"deny"`. tests/unit/hook-core-vendored-copies.test.ts holds
 * that line now, by running an entry from a directory outside any package.
 */
export const CLIENT_TARGETS = Object.freeze([
  join('integrations', 'codex', 'hooks', 'lib'),
  join('integrations', 'codex', 'plugin', 'hooks', 'lib'),
  join('integrations', 'gemini', 'hooks', 'lib'),
  join('integrations', 'opencode', 'hooks', 'lib'),
  join('integrations', 'qwen', 'hooks', 'lib'),
  join('integrations', 'copilot', '.github', 'hooks', 'lib'),
  join('integrations', 'cline', 'hooks', 'token-optimizer', 'lib'),
  join('integrations', 'cursor', 'hooks', 'lib'),
  join('integrations', 'windsurf', 'hooks', 'lib'),
  join('integrations', 'kilo', 'hooks', 'lib'),
]);

/** Every directory that must hold an identical copy of the core. */
export const ALL_TARGETS = Object.freeze([
  ...PLUGIN_TARGETS,
  ...CLIENT_TARGETS,
]);

/** The core files, in a stable order. */
export function coreFiles(root) {
  return readdirSync(join(root, 'hooks-core'))
    .filter((f) => f.endsWith('.mjs'))
    .sort();
}

function banner(name, { stamp = false, version = '' } = {}) {
  return (
    `// GENERATED FILE -- do not edit.\n` +
    `// Source of truth: hooks-core/${name}. Regenerate with \`npm run sync:hooks\`.\n` +
    (stamp && name === 'observability.mjs'
      ? `process.env.TOKEN_OPTIMIZER_VERSION = '${version}';\n`
      : '')
  );
}

/**
 * Banners a core file, keeping any hashbang on line one.
 *
 * NODE ACCEPTS A HASHBANG ONLY AT BYTE ZERO. Anywhere else it is a syntax error,
 * so prepending the banner to an executable core file produced a vendored copy
 * that cannot parse at all -- and harvest-worker.mjs is spawned detached with
 * stdio ignored, which means that failure is completely silent.
 */
export function withBanner(name, source, options) {
  const text = String(source);
  if (!text.startsWith('#!')) return banner(name, options) + text;
  const newline = text.indexOf(String.fromCharCode(10));
  if (newline === -1)
    return text + String.fromCharCode(10) + banner(name, options);
  return (
    text.slice(0, newline + 1) + banner(name, options) + text.slice(newline + 1)
  );
}

/** The exact bytes a vendored copy of `name` must contain. */
export function composeCoreFile(root, name, options) {
  return withBanner(
    name,
    readFileSync(join(root, 'hooks-core', name), 'utf8'),
    options
  );
}
