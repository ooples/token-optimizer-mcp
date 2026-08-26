import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { checklist } from '../../hooks-core/doctor.mjs';
// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { writeManifest, manifestSize, readManifest } from '../../hooks-core/manifest.mjs';

/**
 * The doctor reports what the install manifest actually covers.
 *
 * `manifestSize` computed exactly this and had no caller anywhere in the
 * repository -- correct, untested, and unreachable, which is the defect class
 * `tests/hooks/reachability.test.mjs` exists to catch. It listed the function
 * as an orphan with the note "Verified orphaned, and untested as well."
 *
 * WHY THE NUMBER IS WORTH PRINTING rather than deleting the function. A file
 * COUNT says how many entries the manifest has; it says nothing about what
 * uninstall will remove, and it cannot distinguish a manifest describing a real
 * install from one whose files are all gone -- a missing file still counts as an
 * entry, but contributes zero bytes. The footprint is the only line in the
 * report that separates those two states.
 */

let fixture: string;
let manifestFile: string;
const savedManifestEnv = process.env.TOKEN_OPTIMIZER_MANIFEST;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'doctor-manifest-'));
  manifestFile = join(fixture, 'install.json');
  process.env.TOKEN_OPTIMIZER_MANIFEST = manifestFile;
});

afterEach(() => {
  if (savedManifestEnv === undefined) delete process.env.TOKEN_OPTIMIZER_MANIFEST;
  else process.env.TOKEN_OPTIMIZER_MANIFEST = savedManifestEnv;
  rmSync(fixture, { recursive: true, force: true });
});

/** A script-style install with `count` real files of `bytes` bytes each. */
function givenScriptInstall(count: number, bytes: number) {
  const root = join(fixture, 'install');
  const hooksDir = join(root, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const f of ['pretooluse-router.mjs', 'session-start.mjs']) {
    writeFileSync(join(hooksDir, f), '// hook\n');
  }

  const files: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const path = join(root, `installed-${i}.mjs`);
    writeFileSync(path, 'x'.repeat(bytes));
    files.push(path);
  }
  // writeManifest takes PATHS and hashes them as it writes.
  writeManifest({ files, entries: [] }, manifestFile);
  return { root, files };
}

/** The manifest check, whatever its exact name. */
function manifestCheck(root: string) {
  const checks = checklist({
    root,
    settingsPath: join(fixture, 'settings.json'),
    install: { method: 'script', sameTree: true, installedVersion: null },
  });
  return checks.find((c: { name: string }) => /manifest|installed files/i.test(c.name));
}

describe('the doctor reports what the install manifest covers', () => {
  it('names the manifest footprint, not only the file count', () => {
    const { root } = givenScriptInstall(3, 2048);
    const check = manifestCheck(root);

    expect(check).toBeDefined();
    // The count is still there...
    expect(check.detail).toMatch(/3 file/);
    // ...and so is the size, which nothing reported before.
    expect(check.detail).toMatch(/\b6 KB\b/);
  });

  it('distinguishes a real install from a manifest whose files are gone', () => {
    // THE CASE THE FILE COUNT CANNOT SEE. verifyManifest reports these as
    // `missing` rather than `intact`, but the manifest still has three entries
    // either way -- so without the footprint the report reads identically for an
    // install that is present and one that has been deleted out from under it.
    const { root, files } = givenScriptInstall(3, 2048);
    for (const f of files) rmSync(f, { force: true });

    expect(manifestSize(readManifest(manifestFile))).toBe(0);
    const check = manifestCheck(root);
    expect(check.detail).toMatch(/size unknown/);
  });

  it('says something rather than crashing when there is no manifest at all', () => {
    // A plugin install writes none, and that is not a failure of this check.
    const root = join(fixture, 'install');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    for (const f of ['pretooluse-router.mjs', 'session-start.mjs']) {
      writeFileSync(join(root, 'hooks', f), '// hook\n');
    }
    expect(() => manifestCheck(root)).not.toThrow();
    expect(manifestCheck(root)).toBeDefined();
  });
});
