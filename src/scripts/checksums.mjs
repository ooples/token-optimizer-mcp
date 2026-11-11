#!/usr/bin/env node
/**
 * CHECKSUMS.sha256 for a release.
 *
 * This is the WEAKER of the two guarantees we ship, and it is worth being
 * explicit about why it is still here. A checksum file published by whoever
 * could also tamper with the artifact shares its trust root with the thing it
 * hashes: it proves the download was not corrupted in transit, not that it is
 * genuine.
 *
 * The strong guarantee is npm provenance. The package is published from CI with
 * `npm publish --provenance`, which signs an attestation binding the artifact to
 * the workflow run and the commit that produced it. Anyone can verify that with
 *
 *     npm audit signatures
 *
 * without trusting us at all. Checksums are here for offline verification and
 * for mirrors, alongside provenance rather than instead of it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const OUT = join(ROOT, 'CHECKSUMS.sha256');

/** What ships. Mirrors package.json "files", which is what users receive. */
const INCLUDE = ['dist', 'hooks-core', 'plugin', 'integrations', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'coverage', '.turbo']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

const lines = [];
for (const root of INCLUDE) {
  for (const path of walk(join(ROOT, root))) {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    // sha256sum format, so `sha256sum -c CHECKSUMS.sha256` works unmodified.
    lines.push(`${digest}  ${relative(ROOT, path).split('\\').join('/')}`);
  }
}

lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));

const header = [
  '# Verify with: sha256sum -c CHECKSUMS.sha256',
  '#',
  '# This detects a corrupted or incomplete download. It does NOT prove the',
  '# release is genuine -- this file and the artifact share a trust root. For',
  '# that, verify the npm provenance attestation instead:',
  '#',
  '#   npm audit signatures',
  '#',
  '# which ties the published package to the CI run and commit that built it.',
  '',
].join('\n');

writeFileSync(OUT, `${header}${lines.join('\n')}\n`);
const bytes = statSync(OUT).size;
console.log(`CHECKSUMS.sha256: ${lines.length} files, ${bytes} bytes`);
