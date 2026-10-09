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

import { readFileSync } from 'node:fs';
import { contentMatches, readIfExists, writeIfChanged } from './lib/text.mjs';
import { ALL_TARGETS, composeCoreFile, coreFiles } from './lib/hook-core.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'hooks-core');
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
).version;

const check = process.argv.includes('--check');

/**
 * Publish-time only. The version is NOT committed into the generated copies.
 *
 * A version literal in a generated-and-committed file makes the invariant
 * "generated output == committed file" one that CANNOT hold across a release:
 * release-please bumps package.json without regenerating, so every release
 * commit is born drifted and `sync:hooks:check` fails inside `publish-npm` --
 * which checks out the tag, so a later repair on master cannot rescue it.
 *
 * This repository has now paid for that invariant three times: v5.4.0 and
 * v5.4.1 were tagged with GitHub Releases and neither reached npm, and v5.7.1
 * repeated it after the stamp was reintroduced here. scripts/pin-mcp-version.mjs
 * and scripts/generate-client-configs.mjs both carry the post-mortem, and both
 * name the remedy: pin at publish time only, so the tarball carries an exact
 * version while git carries none. Nothing in git can then go stale.
 *
 * `npm run stamp:version` applies it, and release.yml runs that after the drift
 * check and before the tarball is built.
 */
const stamp = process.argv.includes('--stamp');
const files = coreFiles(ROOT);

// The EOL-safe comparison this file used to carry locally now lives in
// scripts/lib/text.mjs, because it was needed by the other two generators and
// having it here only meant they went without it. See that module for why.

let drifted = 0;

for (const target of ALL_TARGETS) {
  for (const name of files) {
    const contents = composeCoreFile(ROOT, name, {
      stamp,
      version: PACKAGE_VERSION,
    });
    const destination = join(ROOT, target, name);

    if (check) {
      if (!contentMatches(readIfExists(destination), contents)) {
        console.error(`DRIFT: ${destination.slice(ROOT.length + 1)}`);
        drifted++;
      }
      continue;
    }

    // writeIfChanged skips files that differ only in line endings, so a sync on
    // Windows no longer rewrites every vendored file it did not need to.
    writeIfChanged(destination, contents);
  }
}

if (check && drifted > 0) {
  console.error(
    `\n${drifted} vendored hook file(s) differ from hooks-core/. Run: npm run sync:hooks`
  );
  process.exit(1);
}

console.log(
  check
    ? 'hook core in sync across all client integrations'
    : `synced ${files.length} core file(s) to ${ALL_TARGETS.length} client integration(s)`
);
