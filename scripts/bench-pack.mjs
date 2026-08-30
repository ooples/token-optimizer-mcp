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
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'bench', 'thol', 'pkg');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
process.stdout.write(`packing working tree at version ${version}\n`);

// BUILD EXPLICITLY. `npm pack` runs prepack/prepare/postpack -- NOT
// prepublishOnly, which is where this package defines its build. An earlier
// version of this script assumed otherwise and was wrong in the most dangerous
// direction: with a stale dist/ on disk the tarball looked fine while carrying
// compiled code that did not match the source, so the harness would grade a
// build nobody wrote. With dist/ absent it packed ZERO compiled files -- proved
// by deleting dist/ and counting `package/dist/` entries in the tarball, which
// came back 0.
//
// So the build runs here, unconditionally, before the pack.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runNpm = (args) =>
  execFileSync(npm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

runNpm(['run', 'build']);

// FAIL LOUDLY IF THE BUILD PRODUCED NOTHING. A tarball without a compiled
// server installs cleanly and fails at MCP handshake time, deep inside a
// container, where it reads as a harness fault rather than a packaging one.
const entry = join(root, 'dist', 'server', 'index.js');
if (!existsSync(entry)) {
  throw new Error(
    `build produced no ${entry}; refusing to pack a tarball with no server`
  );
}

runNpm(['pack', '--pack-destination', dest, '--loglevel', 'error']);

const packed = readdirSync(dest).filter((name) => name.endsWith('.tgz'));
if (packed.length !== 1) {
  throw new Error(
    `expected exactly one tarball in ${dest}, found ${packed.length}: ${packed.join(', ')}`
  );
}

renameSync(join(dest, packed[0]), join(dest, 'optimizer.tgz'));
process.stdout.write(`bench/thol/pkg/optimizer.tgz <- ${packed[0]}\n`);
