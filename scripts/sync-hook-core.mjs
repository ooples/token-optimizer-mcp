#!/usr/bin/env node
/**
 * Copies hooks-core/ into every client integration that ships hooks.
 *
 * WHY COPY RATHER THAN IMPORT: each client installs its hooks into a different
 * directory it controls -- ~/.codex/hooks, the Gemini extension path, the
 * Claude Code plugin root -- and executes them from there. There is no shared
 * location on a user's machine that all of them can resolve, and a relative
 * import across those trees would break on install. So the core is vendored,
 * and this script is what keeps the vendored copies honest.
 *
 * Run via `npm run sync:hooks`. CI runs it with --check, which fails the build
 * if a copy has drifted from the source -- the failure mode this replaces was
 * exactly that drift: Codex, Gemini and Claude Code each carried their own
 * threshold constant and their own guidance string, and they had already
 * diverged.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'hooks-core');

/** Every directory that must hold an identical copy of the core. */
const TARGETS = [
  join(ROOT, 'plugin', 'hooks', 'lib'),
  join(ROOT, 'integrations', 'codex', 'hooks', 'lib'),
  join(ROOT, 'integrations', 'codex', 'plugin', 'hooks', 'lib'),
  join(ROOT, 'integrations', 'gemini', 'hooks', 'lib'),
  join(ROOT, 'integrations', 'opencode', 'hooks', 'lib'),
  join(ROOT, 'integrations', 'qwen', 'hooks', 'lib'),
];

const check = process.argv.includes('--check');
const files = readdirSync(SOURCE).filter((f) => f.endsWith('.mjs'));

const banner = (name) =>
  `// GENERATED FILE -- do not edit.\n` +
  `// Source of truth: hooks-core/${name}. Regenerate with \`npm run sync:hooks\`.\n`;

let drifted = 0;

for (const target of TARGETS) {
  for (const name of files) {
    const contents = banner(name) + readFileSync(join(SOURCE, name), 'utf8');
    const destination = join(target, name);

    if (check) {
      const current = existsSync(destination) ? readFileSync(destination, 'utf8') : null;
      if (current !== contents) {
        console.error(`DRIFT: ${destination.slice(ROOT.length + 1)}`);
        drifted++;
      }
      continue;
    }

    mkdirSync(target, { recursive: true });
    writeFileSync(destination, contents);
  }
}

if (check && drifted > 0) {
  console.error(`\n${drifted} vendored hook file(s) differ from hooks-core/. Run: npm run sync:hooks`);
  process.exit(1);
}

console.log(check
  ? 'hook core in sync across all client integrations'
  : `synced ${files.length} core file(s) to ${TARGETS.length} client integration(s)`);
