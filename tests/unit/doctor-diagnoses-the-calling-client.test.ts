import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import {
  detectInstall,
  probeVersion,
  checklist,
  probeProxy,
} from '../../hooks-core/doctor.mjs';
import {
  managedClientIds,
  proxyEnvFor,
} from '../../hooks-core/capabilities.mjs';

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
function givenCodexPlugin(
  version: string,
  { marketplace = 'token-optimizer' } = {}
) {
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

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'codex',
      codexHome,
    });

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

  it('does not hand Codex the Claude record when Codex has no cache', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'codex',
      codexHome: join(fixture, 'no-codex-here'),
    });

    // THIS ASSERTION USED TO READ toBe('plugin'), AND THAT WAS THE BUG STILL STANDING.
    // installed_plugins.json is Claude Code's registry and nobody else's, so a client
    // we have positively identified as something else cannot own what is in it. The
    // first half of #408 was fixed for a Codex install that EXISTS; a Codex user with
    // no cache yet still got the reporter's exact sentence -- "install method: Claude
    // Code plugin 6.0.0" -- and so did the eight other managed clients, none of which
    // has a branch of its own above.
    //
    // The record is not discarded. Returning anything but `plugin` is precisely what
    // makes diagnose() re-read it through `crossClient` and report it as ANOTHER
    // client's state, which is where it belongs.
    expect(install.method).not.toBe('plugin');
    expect(install.installedVersion).toBeNull();
    expect(install.installPath).toBeNull();
  });

  it('picks the newest cached version, which is the one Codex loads', () => {
    const root = givenPackage('7.1.0');
    givenCodexPlugin('6.0.2');
    const { codexHome } = givenCodexPlugin('7.1.0');

    const install = detectInstall({ root, client: 'codex', codexHome });

    expect(install.method).toBe('codex plugin');
    expect(install.installedVersion).toBe('7.1.0');
    expect(install.hooksDir).toContain(
      join('token-optimizer', '7.1.0', 'hooks')
    );
  });

  it('finds the plugin whatever marketplace it was added from', () => {
    const root = givenPackage('7.1.0');
    const { codexHome } = givenCodexPlugin('7.1.0', {
      marketplace: 'personal',
    });

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

    const detail = named(
      checklist({ root, install }),
      'install method'
    )?.detail;

    expect(detail).toContain('codex plugin');
    expect(detail).toContain(join(codexHome, 'plugins', 'cache'));
  });
});

describe("another client's cache is information, not this client's verdict", () => {
  it('warns instead of failing about a stale Claude cache under Codex', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');
    const { codexHome } = givenCodexPlugin('7.1.0');

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'codex',
      codexHome,
    });
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

describe('every managed client is diagnosed as itself', () => {
  /**
   * The first fix for #408 gave Codex a branch of its own. The other eight managed
   * clients never got one, so each of them still read Claude Code's registry and was
   * told it was running "Claude Code plugin 6.0.0" -- the reporter's exact sentence,
   * about an install they do not have. One case fixed, eight left; this asserts the
   * rule instead of the case, so a tenth client added to the registry cannot
   * reintroduce it by being forgotten here.
   */
  it('reports no foreign client as the Claude Code plugin', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');

    const others = managedClientIds().filter(
      (id: string) => id !== 'claude-code'
    );
    // NON-VACUITY. An empty registry would satisfy the loop below without examining
    // anything, and the registry is read, not written, by this test.
    expect(others.length).toBeGreaterThanOrEqual(9);
    expect(managedClientIds()).toContain('claude-code');

    for (const client of others) {
      const install = detectInstall({
        pluginsDir,
        root,
        client,
        codexHome: join(fixture, 'no-codex-here'),
      });
      expect([client, install.method]).not.toEqual([client, 'plugin']);
      expect([client, install.installedVersion]).toEqual([client, null]);
    }
  });

  /** The positive control: the client that DOES own that registry still reads it. */
  it('still reports the Claude Code plugin to Claude Code', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir, installPath } = givenClaudePlugin('6.0.0');

    const install = detectInstall({ pluginsDir, root, client: 'claude-code' });

    expect(install.method).toBe('plugin');
    expect(install.installPath).toBe(installPath);
  });
});

describe('a named client outranks the one that opened the session', () => {
  /**
   * install_doctor now takes `client`, because the handshake name answers a different
   * question: it says which client is TALKING, not which install is under suspicion.
   * TOKEN_OPTIMIZER_CLIENT has the same problem -- it is set by whatever launched the
   * process. A caller who names a client has already answered what both are guessing
   * at, so the answer has to win, or the argument is decoration.
   */
  it('diagnoses the named client, not TOKEN_OPTIMIZER_CLIENT', () => {
    const env = {
      TOKEN_OPTIMIZER_CLIENT: 'claude-code',
      [String(proxyEnvFor('claude-code'))]: 'http://127.0.0.1:4000',
    };

    const checks = probeProxy(env, {
      clientName: 'claude-code',
      client: 'codex',
    });

    // Codex's variable is unset in this env, so the verdict must be about Codex's
    // variable. Were the explicit name ignored, Claude's is set to a loopback URL and
    // the probe would have reported a routed install instead.
    const text = checks
      .map((c: { name: string; detail: string }) => c.name + ' ' + c.detail)
      .join('\n');
    expect(text).toContain(String(proxyEnvFor('codex')));
    expect(text).not.toContain(String(proxyEnvFor('claude-code')));
  });

  it('uses the session client when nothing is named', () => {
    const env = {
      TOKEN_OPTIMIZER_CLIENT: '',
      [String(proxyEnvFor('claude-code'))]: 'http://127.0.0.1:4000',
    };

    const checks = probeProxy(env, { clientName: 'claude-code' });

    const text = checks
      .map((c: { name: string; detail: string }) => c.name + ' ' + c.detail)
      .join('\n');
    expect(text).not.toContain(String(proxyEnvFor('codex')));
  });
});
