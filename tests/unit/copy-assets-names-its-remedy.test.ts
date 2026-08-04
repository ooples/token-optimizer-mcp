import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- scripts ship as plain ESM with no type declarations.
import { copyAssets, VENDOR_SOURCE } from '../../scripts/copy-assets.mjs';

/**
 * `npm run build` failed with a bare ENOENT that named neither the cause nor a
 * remedy.
 *
 * copy:assets was an inline `node -e` one-liner that cpSync'd
 * node_modules/chart.js/dist/chart.umd.js into the dashboard bundle. With
 * chart.js absent -- a stale node_modules, a pruned install, an --omit=dev
 * misconfiguration -- the whole build died with:
 *
 *     code: 'ENOENT', syscall: 'lstat',
 *     path: '.../node_modules/chart.js/dist/chart.umd.js'
 *     Node.js v22.15.0
 *
 * Nothing in that says a dependency is missing, which one, or that `npm install`
 * fixes it. It also took dashboard-self-contained.test.ts down with it, so the
 * visible symptom was a failing test suite rather than an incomplete install --
 * which is how it survived long enough to be dismissed as environmental more
 * than once.
 *
 * hooks-core/doctor.mjs states the standard this violated: "Every check returns a
 * remedy on failure. A diagnosis without a next step is a complaint." A build
 * script owes the same.
 *
 * The one-liner also could not be fixed in place: there is nowhere in a
 * `node -e` string to put a preflight check or a decent message, which is why
 * this is a module with an entry point rather than a longer one-liner.
 */

let root: string;

/** A source tree shaped like the repo's, minus whatever the test omits. */
function givenTree({ withVendor }: { withVendor: boolean }) {
  mkdirSync(join(root, 'src', 'dashboard', 'public'), { recursive: true });
  writeFileSync(join(root, 'src', 'dashboard', 'public', 'index.html'), '<html></html>');

  if (withVendor) {
    const dir = join(root, VENDOR_SOURCE, '..');
    mkdirSync(join(root, VENDOR_SOURCE).replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    writeFileSync(join(root, VENDOR_SOURCE), '/* chart.js umd */');
    void dir;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copy-assets-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('copyAssets when the vendored dependency is missing', () => {
  it('names the missing package rather than throwing ENOENT', () => {
    givenTree({ withVendor: false });

    expect(() => copyAssets({ root })).toThrow(/chart\.js/);
  });

  it('names the remedy', () => {
    givenTree({ withVendor: false });

    // The whole point: a contributor should not have to guess that a build
    // failure means their install is incomplete.
    expect(() => copyAssets({ root })).toThrow(/npm install/);
  });

  it('does not leak a raw filesystem error code to the user', () => {
    givenTree({ withVendor: false });

    let message = '';
    try {
      copyAssets({ root });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toMatch(/ENOENT|lstat/);
  });
});

describe('copyAssets on a complete tree', () => {
  it('copies the dashboard public files', () => {
    givenTree({ withVendor: true });

    copyAssets({ root });

    expect(existsSync(join(root, 'dist', 'dashboard', 'public', 'index.html'))).toBe(true);
  });

  it('vendors the chart bundle under the name the dashboard loads', () => {
    givenTree({ withVendor: true });

    copyAssets({ root });

    const vendored = join(root, 'dist', 'dashboard', 'public', 'vendor', 'chart.umd.min.js');
    expect(readFileSync(vendored, 'utf8')).toBe('/* chart.js umd */');
  });
});

describe('the build wiring', () => {
  it('uses the script rather than an inline one-liner', () => {
    // An inline `node -e` has nowhere to put a preflight check or a remedy, so
    // reverting to one would silently reintroduce the bare ENOENT.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

    expect(pkg.scripts['copy:assets']).toContain('scripts/copy-assets.mjs');
    expect(pkg.scripts['copy:assets']).not.toContain('node -e');
  });
});
