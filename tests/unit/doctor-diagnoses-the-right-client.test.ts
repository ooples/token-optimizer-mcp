import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { detectInstall, probeVersion, checklist } from '../../hooks-core/doctor.mjs';

/**
 * Issue #307, second half: the doctor diagnosed the wrong install.
 *
 * Run from the 5.7.0 npm package to diagnose a Codex server, it reported
 * "plugin 5.5.0 -- hooks from ~/.claude/plugins/cache/.../5.5.0/hooks" and then
 * "plugin is up to date -- installed 5.5.0". Both lines were about a stale
 * CLAUDE CODE plugin sitting on the same machine. Nothing in the report named
 * the package it had just probed, so the version the user was holding never
 * appeared, and the version that did appear looked like a regression.
 *
 * Cross-client discovery is worth keeping -- a stale plugin cache beside a fresh
 * package is a real problem and one worth naming. What it must not do is
 * substitute one install's version for another's.
 */

const PLUGIN_ID = 'token-optimizer@token-optimizer';

let fixture: string;

/** A package tree at `version`, standing in for what npx/npm resolved. */
function givenPackage(version: string) {
  const root = mkdtempSync(join(fixture, 'package-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@ooples/token-optimizer-mcp', version })
  );
  mkdirSync(join(root, 'plugin', 'hooks'), { recursive: true });
  return root;
}

/** Claude Code's plugin cache, holding its own separate copy at `version`. */
function givenClaudePlugin(version: string, { installPath = '' } = {}) {
  const pluginsDir = join(fixture, '.claude', 'plugins');
  const resolvedPath =
    installPath ||
    join(pluginsDir, 'cache', 'token-optimizer', 'token-optimizer', version);
  mkdirSync(join(resolvedPath, 'hooks'), { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: {
        [PLUGIN_ID]: [{ scope: 'user', installPath: resolvedPath, version }],
      },
    })
  );
  return { pluginsDir, installPath: resolvedPath };
}

const detail = (checks: Array<{ name: string; detail?: string }>, name: string) =>
  checks.find((check) => check.name === name)?.detail ?? '';

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'doctor-client-'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('detectInstall separates this package from another client\'s plugin', () => {
  it('reads the version of the package being diagnosed', () => {
    const root = givenPackage('5.7.0');
    const { pluginsDir } = givenClaudePlugin('5.5.0');

    expect(detectInstall({ pluginsDir, root }).packageVersion).toBe('5.7.0');
  });

  it('knows the plugin record describes a different tree', () => {
    const root = givenPackage('5.7.0');
    const { pluginsDir } = givenClaudePlugin('5.5.0');

    expect(detectInstall({ pluginsDir, root }).sameTree).toBe(false);
  });

  it('knows when the plugin record IS this tree', () => {
    // Claude Code running its own plugin: one install, not two.
    const root = givenPackage('5.5.0');
    const { pluginsDir } = givenClaudePlugin('5.5.0', { installPath: root });

    expect(detectInstall({ pluginsDir, root }).sameTree).toBe(true);
  });
});

describe('probeVersion names the build it examined', () => {
  it('reports the package version, which used to appear nowhere at all', () => {
    const root = givenPackage('5.7.0');
    const { pluginsDir } = givenClaudePlugin('5.5.0');

    const checks = probeVersion({ install: detectInstall({ pluginsDir, root }) });

    expect(detail(checks, 'package under examination')).toContain('5.7.0');
  });

  it('does not call a 5.5.0 plugin "up to date" while diagnosing a 5.7.0 package', () => {
    const root = givenPackage('5.7.0');
    const { pluginsDir } = givenClaudePlugin('5.5.0');

    const checks = probeVersion({ install: detectInstall({ pluginsDir, root }) });
    const split = checks.find(
      (check: { name: string }) => check.name === 'other clients agree with this package'
    );

    expect(split.pass).toBe(false);
    expect(split.detail).toContain('5.5.0');
    expect(split.detail).toContain('5.7.0');
    // And it must say which one this run actually looked at.
    expect(split.remedy).toContain('diagnosed the package');
  });

  it('is content when the other client is on the same version', () => {
    const root = givenPackage('5.7.0');
    const { pluginsDir } = givenClaudePlugin('5.7.0');

    const checks = probeVersion({ install: detectInstall({ pluginsDir, root }) });
    const split = checks.find(
      (check: { name: string }) => check.name === 'other clients agree with this package'
    );

    expect(split.pass).toBe(true);
  });
});

describe('the install-method line says whose hooks those are', () => {
  it('attributes a foreign plugin cache to Claude Code', () => {
    const root = givenPackage('5.7.0');
    const { pluginsDir } = givenClaudePlugin('5.5.0');
    const install = detectInstall({ pluginsDir, root });

    expect(detail(checklist({ root, install }), 'install method'))
      .toContain('Claude Code plugin 5.5.0');
  });
});
