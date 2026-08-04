#!/usr/bin/env node
/**
 * Copies the dashboard's static files and vendors the chart bundle into dist.
 *
 * WHY THIS IS A MODULE AND NOT THE ONE-LINER IT REPLACES. `copy:assets` used to
 * be an inline `node -e` that cpSync'd chart.js straight into the bundle. With
 * chart.js absent -- a stale node_modules, a pruned install, an --omit=dev
 * misconfiguration -- `npm run build` died with:
 *
 *     code: 'ENOENT', syscall: 'lstat',
 *     path: '.../node_modules/chart.js/dist/chart.umd.js'
 *
 * Nothing there says a dependency is missing, which one, or that `npm install`
 * fixes it. It also failed the build BEFORE tsc's output was usable, and took
 * dashboard-self-contained.test.ts down with it, so the visible symptom was a
 * failing test suite rather than an incomplete install. That misdirection is why
 * it was repeatedly written off as environmental instead of being fixed.
 *
 * hooks-core/doctor.mjs sets the standard this broke: "Every check returns a
 * remedy on failure. A diagnosis without a next step is a complaint." A build
 * script owes the reader the same courtesy, and a `node -e` string has nowhere
 * to put a preflight check or a decent message.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the chart bundle comes from, relative to the repo root. */
export const VENDOR_SOURCE = join('node_modules', 'chart.js', 'dist', 'chart.umd.js');

/** The name the dashboard's markup actually requests. */
const VENDOR_TARGET = join('vendor', 'chart.umd.min.js');

const PUBLIC_SOURCE = join('src', 'dashboard', 'public');
const PUBLIC_TARGET = join('dist', 'dashboard', 'public');

/**
 * Copies the dashboard assets, or throws an error that names its own remedy.
 *
 * `root` is a parameter so this is testable against a fixture tree rather than
 * only against the real repo.
 */
export function copyAssets({ root = ROOT } = {}) {
  const publicSource = join(root, PUBLIC_SOURCE);
  const publicTarget = join(root, PUBLIC_TARGET);
  const vendorSource = join(root, VENDOR_SOURCE);
  const vendorTarget = join(root, PUBLIC_TARGET, VENDOR_TARGET);

  if (!existsSync(publicSource)) {
    throw new Error(
      `Cannot build the dashboard: ${PUBLIC_SOURCE} is missing.\n` +
      'This is part of the repository, so a missing copy means an incomplete ' +
      'checkout rather than a build problem.'
    );
  }

  // PREFLIGHT, so the failure names the cause instead of a filesystem errno.
  // chart.js is a declared runtime dependency; absent, the only sane conclusion
  // is that the install is incomplete.
  if (!existsSync(vendorSource)) {
    throw new Error(
      'Cannot build the dashboard: the chart.js bundle is not installed.\n' +
      `  expected: ${VENDOR_SOURCE}\n` +
      '  fix:      npm install\n' +
      'chart.js is a declared dependency, so this means the installed tree is ' +
      'incomplete -- not that the dashboard is misconfigured. The dashboard ' +
      'vendors the bundle rather than loading it from a CDN, which is what ' +
      'dashboard-self-contained.test.ts asserts.'
    );
  }

  cpSync(publicSource, publicTarget, { recursive: true });
  mkdirSync(dirname(vendorTarget), { recursive: true });
  cpSync(vendorSource, vendorTarget);

  return { publicTarget, vendorTarget };
}

// CLI entry. Only runs when invoked directly, so importing this for a test does
// not copy anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { vendorTarget } = copyAssets();
    console.log(`copied dashboard assets; vendored ${VENDOR_TARGET}`);
    void vendorTarget;
  } catch (error) {
    // The message is the product here, so print it plainly rather than as a
    // stack trace the reader has to decode.
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
