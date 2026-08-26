import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { checklist, probeClients } from '../../hooks-core/doctor.mjs';
// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { record } from '../../hooks-core/metrics.mjs';
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

describe('the limit of what the reachability guard can prove', () => {
  it('does not run the manifest check on a plugin install, and that is correct', () => {
    // FOUND BY ADVERSARIAL REVIEW OF THIS VERY CHANGE, and worth pinning rather
    // than quietly leaving true.
    //
    // `manifestSize` left the reachability allowlist by acquiring a caller. The
    // guard is satisfied -- the name is referenced by shipped code -- but the
    // reference sits inside `if (resolved.method !== 'plugin')`, and the plugin
    // path is how this product is actually distributed. So for most users the
    // function still never executes.
    //
    // That is CORRECT here: only install-hooks.* writes a manifest, so a plugin
    // install has none and there is nothing to size. But it is a live
    // demonstration that a name-based reachability scan proves a REFERENCE
    // exists, never that it RUNS -- which is exactly why `npm run wiki:census`
    // reads real logs instead of source text.
    const root = join(fixture, 'install');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    for (const f of ['pretooluse-router.mjs', 'session-start.mjs']) {
      writeFileSync(join(root, 'hooks', f), '// hook\n');
    }
    const checks = checklist({
      root,
      settingsPath: join(fixture, 'settings.json'),
      install: { method: 'plugin', sameTree: true, installedVersion: '5.7.1' },
    });
    expect(
      checks.some((c: { name: string }) => /manifest|installed files/i.test(c.name))
    ).toBe(false);
  });
});

describe('the doctor reports which MCP clients actually connected', () => {
  // `mcp-client` was written on every handshake and read by nothing. Every
  // other check in the doctor reasons about files on disk -- is the hook
  // present, is it wired, does it refuse a large read. None of them can say
  // whether the editor in front of you ever actually connected, which is the
  // most common way this product is installed and silently does nothing.
  it('names the clients seen, with the title each reports for itself', () => {
    const graphDir = join(fixture, 'graph');
    mkdirSync(graphDir, { recursive: true });
    record(graphDir, {
      kind: 'mcp-client',
      client: 'claude-code',
      clientVersion: '2.1.0',
      clientTitle: 'Claude Code',
    });

    const check = probeClients({ dir: graphDir }).find((c: { name: string }) =>
      /MCP clients/i.test(c.name)
    );
    expect(check).toBeDefined();
    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/Claude Code/);
    expect(check.detail).toMatch(/2\.1\.0/);
  });

  it('never fails on a fresh install, which has had no handshake', () => {
    // A doctor that reports red on a correct install teaches people to ignore
    // it -- the failure this file's sibling tests were written about.
    const graphDir = join(fixture, 'empty-graph');
    mkdirSync(graphDir, { recursive: true });
    const checks = probeClients({ dir: graphDir });
    expect(checks).toHaveLength(1);
    expect(checks[0].pass).toBe(true);
    expect(checks[0].detail).toMatch(/none yet/i);
  });
});
