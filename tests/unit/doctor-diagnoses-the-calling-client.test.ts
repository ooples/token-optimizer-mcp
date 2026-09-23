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
  entriesFor,
} from '../../hooks-core/doctor.mjs';
import {
  managedClientIds,
  proxyEnvFor,
  hookInstallFor,
  CLIENT_HOOK_INSTALLS,
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
        cwd: join(fixture, 'no-hooks-here'),
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
    // POSITIVE FIRST: the session client's own variable has to be the one reported, or
    // the absence of Codex's below is satisfied by a probe that examined nothing at all.
    expect(text).toContain(String(proxyEnvFor('claude-code')));
    expect(text).not.toContain(String(proxyEnvFor('codex')));
  });
});

describe('a client is diagnosed against its own installed hooks', () => {
  /**
   * Refusing Claude Code's registry stops the misreport; it does not produce a
   * diagnosis. Every managed client but Claude Code and Codex came back `unknown`
   * with no hooks directory, so the smoke checks had nothing to run -- which is the
   * same complaint #408 opened with, one indirection later. CLIENT_HOOK_INSTALLS
   * records where each integration's installer puts its hooks, so the probe that
   * opens the tap for Codex can open it for the rest.
   */
  function givenClientHooks(client: string, omit: string[] = []) {
    const entry = hookInstallFor(client);
    if (!entry?.dir) throw new Error('no registry entry for ' + client);
    const project = mkdtempSync(join(fixture, 'project-'));
    const dir = join(project, ...entry.dir.split('/'));
    mkdirSync(dir, { recursive: true });
    const names: string[] = Object.values(entry.entries);
    for (const name of names)
      if (!omit.includes(name)) writeFileSync(join(dir, name), '');
    return { project, dir, entries: entry.entries, names };
  }

  // THE REGISTRY'S KEYS, NOT MANAGED_CLIENTS. The two lists are not the same set and
  // neither contains the other: Cursor, Windsurf, Kilo and Cline ship hooks but have no
  // proxy entry, while Crush, Droid, Continue and Amp are managed and ship none. Codex
  // is excluded because it is diagnosed from its own plugin cache before this path.
  const installers = Object.keys(CLIENT_HOOK_INSTALLS).filter(
    (id: string) => hookInstallFor(id)?.dir && id !== 'codex'
  );

  // NON-VACUITY, TWICE OVER: an empty list would make every loop below pass without
  // detecting anything, and these are read from the registry, not declared here.
  it('has hook destinations recorded for the project-scoped clients', () => {
    expect(installers.length).toBeGreaterThanOrEqual(6);
  });

  for (const client of installers) {
    it(
      'finds ' + client + " hooks, and reports that client's entry points",
      () => {
        const root = givenPackage('7.1.0');
        // Claude's registry is present and populated throughout: the point is that the
        // client's own hooks are what gets diagnosed while it sits there.
        const { pluginsDir } = givenClaudePlugin('6.0.0');
        const { project, dir, entries } = givenClientHooks(client);

        const install = detectInstall({
          pluginsDir,
          root,
          client,
          cwd: project,
        });

        expect(install.method).toBe(client + ' hooks');
        expect(install.hooksDir).toBe(dir);
        expect(install.installPath).toBe(dir);
        // No version: hooks are copied files with nothing stamped on them, and Claude's
        // number belongs to Claude.
        expect(install.installedVersion).toBeNull();
        // Cline's entry points are the extensionless PreToolUse/TaskStart, not ours;
        // entriesFor has to hand back what the client actually runs.
        expect(entriesFor(install)).toEqual(entries);
      }
    );
  }

  it('does not claim a half-copied install', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');
    const { project, names } = givenClientHooks('cursor', ['post-tool.mjs']);
    expect(names).toContain('post-tool.mjs');

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'cursor',
      cwd: project,
    });

    expect(install.method).not.toBe('cursor hooks');
    expect(install.installPath).toBeNull();
  });

  /** The control: a project full of Cursor hooks is still not Claude Code's answer. */
  it('leaves the Claude Code diagnosis alone', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir, installPath } = givenClaudePlugin('6.0.0');
    const { project } = givenClientHooks('cursor');

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'claude-code',
      cwd: project,
    });

    expect(install.method).toBe('plugin');
    expect(install.installPath).toBe(installPath);
  });

  /**
   * checklist() gated its settings-and-manifest section on `method !== 'plugin'`,
   * which is a test for "not Claude Code's plugin" standing in for "installed by our
   * own script". A Cursor install satisfies it, so the doctor went on to grade that
   * user against ~/.claude/settings.json and the install-hooks manifest: on a machine
   * that also runs Claude Code it reports Claude's wiring as Cursor's, and on one that
   * does not it fails a check no Cursor user could ever pass.
   */
  it('does not grade a client install against Claude Code settings', () => {
    const root = givenPackage('7.1.0');
    const { pluginsDir } = givenClaudePlugin('6.0.0');
    const { project } = givenClientHooks('cursor');
    // A settings file that IS wired, so a leaked check would read as a pass and the
    // absence below cannot be explained by the fixture simply having nothing to find.
    const settingsPath = join(project, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: 'token-optimizer' }] }] },
      })
    );

    const install = detectInstall({
      pluginsDir,
      root,
      client: 'cursor',
      cwd: project,
    });
    const checks = checklist({ root, settingsPath, install });

    expect(named(checks, 'hooks wired into settings')).toBeUndefined();
    expect(named(checks, 'settings file present')).toBeUndefined();
    // The checks that ARE about this install still run, so the section was scoped
    // rather than the whole checklist shortened.
    expect(named(checks, 'install method')?.detail).toContain('cursor hooks');
    expect(named(checks, 'hook binary present')?.pass).toBe(true);
  });

  /** The control: a script install still answers for settings and the manifest. */
  it('still grades a script install against Claude Code settings', () => {
    const root = givenPackage('7.1.0');
    const settingsPath = join(fixture, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));

    const install = detectInstall({
      pluginsDir: join(fixture, 'no-claude-here'),
      root,
      client: 'claude-code',
      cwd: join(fixture, 'no-hooks-here'),
    });
    const checks = checklist({ root, settingsPath, install });

    expect(install.method).not.toBe('plugin');
    expect(named(checks, 'hooks wired into settings')).toBeDefined();
  });
});
