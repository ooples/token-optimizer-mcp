/**
 * The single composition of hooks-core into a vendored copy.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED: there are now two callers that
 * must produce byte-identical output -- `sync-hook-core.mjs`, which writes the
 * copies committed to git, and `rehydrate-client-hooks.mjs`, which writes them
 * into an installed package where the tarball no longer carries them. Two
 * copies of this logic would drift, and drift between vendored hook copies is
 * the exact failure `sync-hook-core.mjs` was written to end.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vendored copies that the PACKAGE SHIPS and must therefore always be present.
 *
 * `plugin/hooks/lib` is loaded straight out of the installed package by Claude
 * Code, so it cannot depend on a lifecycle script having run: package-manager
 * policy is actively disabling those, and a plugin that needs a repair command
 * before it works is broken on arrival.
 */
export const SHIPPED_TARGETS = Object.freeze([join('plugin', 'hooks', 'lib')]);

/**
 * Vendored copies REHYDRATED AFTER INSTALL instead of shipped.
 *
 * These ten held byte-identical copies of the same core: 518 files carrying 96
 * distinct blobs, 10.87MB of tarball for 1.44MB of unique content, in a package
 * whose size is what sits in npm's publish queue. A client only needs its own
 * directory, and composing it on the installed machine costs nothing that
 * shipping ten copies to everyone was buying.
 */
export const REHYDRATED_TARGETS = Object.freeze([
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
  ...SHIPPED_TARGETS,
  ...REHYDRATED_TARGETS,
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
