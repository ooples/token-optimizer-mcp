import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { detectInstall, probeVersion, checklist } from '../../hooks-core/doctor.mjs';

/**
 * Issue #408: the doctor diagnosed a stale Claude Code install from a Codex session.
 *
 * The reporter asked install_doctor from Codex running plugin 7.1.0 and was told
 *   install method: Claude Code plugin 6.0.0
 *   hooks from .../.claude/plugins/cache/token-optimizer/token-optimizer/6.0.0/hooks
 *   FAIL other clients agree with this package
 * -- so the hook smoke checks never touched the Codex entry points that were the
 * thing under suspicion, and the one FAIL was about a client they were not using.
 *
 * detectInstall read ~/.claude/plugins/installed_plugins.json unconditionally. That is
 * Claude Code's registry and nobody else's.
 */

const PLUGIN_ID = 'token-optimizer@token-optimizer';

let fixture: string;

function givenPackage(version: string) {
  const root = mkdtempSync(join(fixture, 'package-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@ooples/token-optimizer-mcp', version })
  );
  mkdirSync(join(root, 'plugin', 'hooks'), { recursive: true });
  return root;
}

function givenClaudePlugin(version: string) {
  const pluginsDir = join(fixture, '.claude', 'plugins');
  const installPath = join(
    pluginsDir,
    'cache',
    'token-optimizer',
    'token-optimizer',
    version
  );
  mkdirSync(join(installPath, 'hooks'), { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath, version }] },
    })
  );
  return { pluginsDir, installPath };
}

/** Codex's own cache: ~/.codex/plugins/cache/<marketplace>/<name>/<version>/ */
function givenCodexPlugin(version: string, { marketplace = 'token-optimizer' } = {}) {
  const codexHome = join(fixture, '.codex');
  const installPath = join(
    codexHome,
    'plugins',
    'cache',
    marketplace,
    'token-optimizer',
    version
  );
  mkdirSync(join(installPath, '.codex-plugin'), { recursive: true });
  mkdirSync(join(installPath, 'hooks'), { recursive: true });
  writeFileSync(
    join(installPath, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'token-optimizer', version })
  );
  return { codexHome, installPath };
}

const named = (checks: Array<{ name: string }>, name: string) =>
  checks.find((check) => check.name === name);

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'doctor-408-'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('the install under examination is the one that asked', () => {
  it('diagnoses the Codex cache when Codex is the client', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');
    const { codexHome, installPath } = givenCodexPlugin('7.1.0');

    const install = detectInstall({ pluginsDir, root, client: 'codex', codexHome });

    expect(install.method).toBe('codex plugin');
    expect(install.installedVersion).toBe('7.1.0');
    expect(install.hooksDir).toBe(join(installPath, 'hooks'));
  });

  it('still diagnoses the Claude cache for Claude Code', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir, installPath } = givenClaudePlugin('6.0.0');
    const { codexHome } = givenCodexPlugin('7.1.0');

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'claude-code',
      codexHome,
    });

    expect(install.method).toBe('plugin');
    expect(install.hooksDir).toBe(join(installPath, 'hooks'));
  });

  it('falls back to the Claude record when Codex has no plugin cache', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'codex',
      codexHome: join(fixture, 'no-codex-here'),
    });

    expect(install.method).toBe('plugin');
  });

  it('picks the newest cached version, which is the one Codex loads', () => {
    const root = givenPackage('7.1.0');
    givenCodexPlugin('6.0.2');
    const { codexHome } = givenCodexPlugin('7.1.0');

    const install = detectInstall({ root, client: 'codex', codexHome });

    expect(install.method).toBe('codex plugin');
    expect(install.installedVersion).toBe('7.1.0');
    expect(install.hooksDir).toContain(join('token-optimizer', '7.1.0', 'hooks'));
  });

  it('finds the plugin whatever marketplace it was added from', () => {
    const root = givenPackage('7.1.0');
    const { codexHome } = givenCodexPlugin('7.1.0', { marketplace: 'personal' });

    expect(detectInstall({ root, client: 'codex', codexHome }).method).toBe(
      'codex plugin'
    );
  });
});

describe('the checks run against the entry points that install ships', () => {
  it('looks for the Codex per-event hook, not the Claude router', () => {
    const root = givenPackage('7.1.0');
    const { codexHome, installPath } = givenCodexPlugin('7.1.0');
    writeFileSync(join(installPath, 'hooks', 'pre-tool.mjs'), '');
    writeFileSync(join(installPath, 'hooks', 'session-start.mjs'), '');

    const install = detectInstall({ root, client: 'codex', codexHome });
    const checks = checklist({ root, install });

    expect(named(checks, 'hook binary present')).toMatchObject({
      pass: true,
      detail: join(installPath, 'hooks', 'pre-tool.mjs'),
    });
    expect(named(checks, 'session-start binary present')).toMatchObject({
      pass: true,
      detail: join(installPath, 'hooks', 'session-start.mjs'),
    });
  });

  it('names the Codex install in the install-method line', () => {
    const root = givenPackage('7.1.0');
    const { codexHome } = givenCodexPlugin('7.1.0');
    const install = detectInstall({ root, client: 'codex', codexHome });

    const detail = named(checklist({ root, install }), 'install method')?.detail;

    expect(detail).toContain('codex plugin');
    expect(detail).toContain(join(codexHome, 'plugins', 'cache'));
  });
});

describe("another client's cache is information, not this client's verdict", () => {
  it('warns instead of failing about a stale Claude cache under Codex', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');
    const { codexHome } = givenCodexPlugin('7.1.0');

    const install = detectInstall({ pluginsDir, root, client: 'codex', codexHome });
    const crossClient = detectInstall({ pluginsDir, root });
    const split = named(
      probeVersion({ install, crossClient }),
      'other clients agree with this package'
    );

    expect(split).toMatchObject({ pass: true, warn: true });
    expect(split?.detail).toContain('6.0.0');
    expect(split?.detail).toContain('7.1.0');
  });

  it('still fails for Claude Code, whose install that cache is', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');

    const install = detectInstall({ pluginsDir, root, client: 'claude-code' });
    const split = named(
      probeVersion({ install }),
      'other clients agree with this package'
    );

    expect(split).toMatchObject({ pass: false });
  });
});
