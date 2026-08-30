#!/usr/bin/env node
/**
 * Packs the working tree into the benchmark image's build context.
 *
 * WHY THE HARNESS MUST NOT INSTALL FROM THE REGISTRY. The point of keeping
 * bench/ in this repo is that a behaviour change and its measured effect land
 * together. An image that installed the published package could not measure
 * anything unreleased -- and would fail SILENTLY rather than loudly: a benchmark
 * arm pinning a mode the published build does not recognise falls back to the
 * default, so two arms become identical and the campaign yields a meaningless
 * comparison instead of an error.
 *
 * The tarball is written to a fixed name so the Dockerfile does not have to know
 * the version, and is gitignored so a build artifact never lands in a commit.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'bench', 'thol', 'pkg');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
process.stdout.write(`packing working tree at version ${version}\n`);

// `npm pack` runs prepublishOnly, which builds dist/ -- so the tarball carries a
// compiled server rather than bare TypeScript. That is deliberate: the image
// installs this exactly as a user installs the published package.
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--pack-destination', dest, '--loglevel', 'error'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
);

const packed = readdirSync(dest).filter((name) => name.endsWith('.tgz'));
if (packed.length !== 1) {
  throw new Error(
    `expected exactly one tarball in ${dest}, found ${packed.length}: ${packed.join(', ')}`
  );
}

renameSync(join(dest, packed[0]), join(dest, 'optimizer.tgz'));
process.stdout.write(`bench/thol/pkg/optimizer.tgz <- ${packed[0]}\n`);
