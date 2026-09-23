import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { repairManagedInstall } from '../../scripts/repair-managed-install.mjs';
import { activateWindowsCommands } from '../../scripts/windows-commands.mjs';
import { MANAGED_CLIENTS } from '../../hooks-core/capabilities.mjs';
import { dedupeClaudePluginHooks } from '../../scripts/claude-hook-ownership.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const read = (path) => fs.readFileSync(path, 'utf8');
function installPlugin(home, settingsPath) {
  const root = join(home, 'plugins', 'optimizer');
  fs.mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'token-optimizer' })
  );
  fs.copyFileSync(
    resolve('plugin/hooks/hooks.json'),
    join(root, 'hooks', 'hooks.json')
  );
  fs.writeFileSync(join(root, 'hooks', 'stop.mjs'), '');
  fs.writeFileSync(
    join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'token-optimizer@token-optimizer': [
          { scope: 'user', installPath: root },
        ],
      },
    })
  );
  const settings = JSON.parse(read(settingsPath));
  settings.enabledPlugins = { 'token-optimizer@token-optimizer': true };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  return root;
}
function fixture(fn, command = 'claude') {
  // Refuse to run any mutation test without the native-home boundary. In
  // particular a broken CLAUDE_CONFIG_DIR resolver must only touch a sentinel.
  if (
    !process.env.TOKEN_OPTIMIZER_TEST_HOME ||
    resolve(homedir()) !== resolve(process.env.TOKEN_OPTIMIZER_TEST_HOME)
  )
    throw new Error('Native test home is not isolated');
  const home = fs.mkdtempSync(join(tmpdir(), 'optimizer upgrade résumé '));
  const old = join(home, 'old');
  const root = join(home, 'new');
  const profile = join(home, 'profile.ps1');
  const directory = join(home, 'bin');
  const settingsPath = join(home, 'settings.json');
  for (const [dir, version] of [
    [old, '7.0.0'],
    [root, '7.3.0'],
  ]) {
    fs.mkdirSync(join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(join(dir, 'plugin/hooks'), { recursive: true });
    fs.writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@ooples/token-optimizer-mcp', version })
    );
    fs.writeFileSync(join(dir, 'scripts/run-client.mjs'), '');
    fs.writeFileSync(join(dir, 'plugin/hooks/stop.mjs'), '');
  }
  const body = `function global:${command} { & 'node' '${join(old, 'scripts/run-client.mjs')}' ${command} @args }`;
  const block = `# >>> token-optimizer managed clients >>>\n${body}\n# token-optimizer sha256: ${hash(body)}\n# <<< token-optimizer managed clients <<<`;
  fs.writeFileSync(profile, `# user prefix\n${block}\n# user suffix\n`);
  const registry = { read: () => directory, write: () => {} };
  activateWindowsCommands({
    root: old,
    directory,
    platform: 'win32',
    env: {},
    clients: [command],
    registry,
  });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      model: 'keep',
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `node "${join(old, 'plugin/hooks/stop.mjs')}" --token-optimizer-hook`,
              },
              { type: 'command', command: 'echo user hook' },
            ],
          },
        ],
      },
    })
  );
  const options = {
    root,
    env: {},
    profiles: () => [profile],
    directory,
    settingsPath,
  };
  try {
    fn({ ...options, options, home, old, profile, registry });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('automatic repair after a plugin upgrade', () => {
  it('removes duplicate manual Stop registration while preserving the plugin and user hooks', () =>
    fixture(({ options, home, settingsPath }) => {
      installPlugin(home, settingsPath);
      expect(repairManagedInstall(options)).toContain(settingsPath);
      const settings = JSON.parse(read(settingsPath));
      expect(settings.hooks.Stop[0].hooks).toEqual([
        { type: 'command', command: 'echo user hook' },
      ]);
      expect(settings.enabledPlugins['token-optimizer@token-optimizer']).toBe(
        true
      );
      expect(repairManagedInstall(options)).toEqual([]);
    }));

  it.each([
    'disabled',
    'missing-entry',
    'unknown-metadata',
    'custom-command',
    'custom-timeout',
  ])('preserves manual hooks for %s', (reason) =>
    fixture(({ home, settingsPath }) => {
      const root = installPlugin(home, settingsPath);
      const settings = JSON.parse(read(settingsPath));
      if (reason === 'disabled')
        settings.enabledPlugins['token-optimizer@token-optimizer'] = false;
      if (reason === 'missing-entry')
        fs.unlinkSync(join(root, 'hooks', 'stop.mjs'));
      if (reason === 'unknown-metadata')
        fs.unlinkSync(join(home, 'plugins', 'installed_plugins.json'));
      if (reason === 'custom-command')
        settings.hooks.Stop[0].hooks[0].command += ' --custom';
      if (reason === 'custom-timeout')
        settings.hooks.Stop[0].hooks[0].timeout = 30;
      expect(dedupeClaudePluginHooks(settings, settingsPath)).toEqual({
        settings,
        removed: 0,
      });
    })
  );

  it('the installer also avoids manual plus plugin duplication', () =>
    fixture(({ home, root, settingsPath }) => {
      installPlugin(home, settingsPath);
      execFileSync(
        process.execPath,
        [
          resolve('scripts/wire-hooks.mjs'),
          settingsPath,
          join(root, 'plugin/hooks'),
        ],
        { windowsHide: true }
      );
      const settings = JSON.parse(read(settingsPath));
      expect(
        settings.hooks.Stop.flatMap((group) => group.hooks).filter((hook) =>
          hook.command.includes('--token-optimizer-hook')
        )
      ).toHaveLength(0);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('echo user hook');
    }));
  // An apostrophe is NOT in this list. The command repair writes is double-quoted,
  // so a single quote is literal inside it -- see the case below.
  it.each(['$', '%'])(
    'preserves hooks when the new path contains shell metacharacter %s',
    (character) =>
      fixture(({ options, root, settingsPath }) => {
        const unsafeRoot = `${root}${character}path`;
        fs.renameSync(root, unsafeRoot);
        const before = read(settingsPath);
        repairManagedInstall({ ...options, root: unsafeRoot });
        expect(read(settingsPath)).toBe(before);
      })
  );
  // C:\Users\O'Brien is an ordinary Windows home. Refusing it skipped the migration
  // for those users entirely, which is the one thing repair exists to do.
  it('migrates a hook path containing an apostrophe', () =>
    fixture(({ options, root, settingsPath }) => {
      const apostropheRoot = `${root}O'Brien`;
      fs.renameSync(root, apostropheRoot);
      repairManagedInstall({ ...options, root: apostropheRoot });
      const hooks = JSON.parse(read(settingsPath)).hooks.Stop[0].hooks;
      expect(hooks[0].command).toContain(apostropheRoot.replaceAll('\\', '/'));
      expect(hooks[1].command).toBe('echo user hook');
    }));

  it('repairs hooks in CLAUDE_CONFIG_DIR', () =>
    fixture(({ options, home, settingsPath }) => {
      const fallback = join(homedir(), '.claude', 'settings.json');
      fs.mkdirSync(join(homedir(), '.claude'), { recursive: true });
      const previous = fs.existsSync(fallback)
        ? fs.readFileSync(fallback)
        : null;
      const sentinel = fs.readFileSync(settingsPath);
      fs.writeFileSync(fallback, sentinel);
      try {
        expect(
          repairManagedInstall({
            ...options,
            settingsPath: undefined,
            env: { CLAUDE_CONFIG_DIR: home },
          })
        ).toContain(settingsPath);
        expect(fs.readFileSync(fallback)).toEqual(sentinel);
      } finally {
        if (previous) fs.writeFileSync(fallback, previous);
        else fs.unlinkSync(fallback);
      }
    }));
  it.each(Object.values(MANAGED_CLIENTS).map((entry) => entry.command))(
    'repairs both launcher forms for %s',
    (command) =>
      fixture(({ options, profile, directory, root }) => {
        const changed = repairManagedInstall(options);
        expect(changed).toContain(profile);
        expect(changed).toContain(join(directory, `${command}.cmd`));
        expect(read(profile)).toContain(root.replaceAll('\\', '/'));
        expect(read(join(directory, `${command}.cmd`))).toContain(
          root.replaceAll('\\', '/')
        );
      }, command)
  );
  it('migrates stale shell, cmd and hook paths, retains ownership, and is idempotent', () =>
    fixture(({ options, profile, root, directory, registry, settingsPath }) => {
      expect(repairManagedInstall(options).sort()).toEqual(
        [profile, join(directory, 'claude.cmd'), settingsPath].sort()
      );
      expect(read(profile)).toContain(root.replaceAll('\\', '/'));
      expect(read(profile)).toContain('# user prefix');
      expect(read(profile)).toContain('# user suffix');
      const settings = JSON.parse(read(settingsPath));
      expect(settings.model).toBe('keep');
      expect(settings.hooks.Stop[0].hooks[1].command).toBe('echo user hook');
      expect(settings.hooks.Stop[0].hooks[0].command).toContain(
        root.replaceAll('\\', '/')
      );
      expect(repairManagedInstall(options)).toEqual([]);
      // The normal uninstaller must still recognize the updated launcher checksum.
      expect(() =>
        activateWindowsCommands({
          root,
          directory,
          platform: 'win32',
          env: {},
          clients: ['claude'],
          registry,
          remove: true,
        })
      ).not.toThrow();
      expect(fs.existsSync(join(directory, 'claude.cmd'))).toBe(false);
    }));

  it('preserves edited launchers/hooks and does not add registrations or clients', () =>
    fixture(({ options, profile, directory, settingsPath }) => {
      fs.appendFileSync(join(directory, 'claude.cmd'), 'rem user change');
      fs.writeFileSync(
        profile,
        read(profile).replace('claude @args', 'claude --verbose @args')
      );
      const settings = JSON.parse(read(settingsPath));
      settings.hooks.Stop[0].hooks[0].command += ' --custom';
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      const before = [profile, join(directory, 'claude.cmd'), settingsPath].map(
        read
      );
      expect(repairManagedInstall(options)).toEqual([]);
      expect(
        [profile, join(directory, 'claude.cmd'), settingsPath].map(read)
      ).toEqual(before);
      fs.unlinkSync(settingsPath);
      fs.unlinkSync(profile);
      fs.unlinkSync(join(directory, 'launchers.json'));
      expect(repairManagedInstall(options)).toEqual([]);
      expect(fs.existsSync(settingsPath)).toBe(false);
      expect(fs.existsSync(profile)).toBe(false);
    }));

  it('does not downgrade newer installs or override a version pin', () =>
    fixture(({ options, old }) => {
      // Exercise opt-outs while the old install is genuinely eligible for an upgrade.
      for (const env of [
        { TOKEN_OPTIMIZER_VERSION: '7.0.0' },
        { TOKEN_OPTIMIZER_AUTO_REPAIR: '0' },
        { TOKEN_OPTIMIZER_MODE: 'off' },
      ])
        expect(repairManagedInstall({ ...options, env })).toEqual([]);
      fs.writeFileSync(
        join(old, 'package.json'),
        JSON.stringify({
          name: '@ooples/token-optimizer-mcp',
          version: '99.0.0',
        })
      );
      expect(repairManagedInstall(options)).toEqual([]);
      expect(
        repairManagedInstall({
          ...options,
          env: { TOKEN_OPTIMIZER_VERSION: '7.0.0' },
        })
      ).toEqual([]);
    }));

  it('repairs missing old packages and preserves UTF-16 profiles', () =>
    fixture(({ options, old, profile }) => {
      fs.writeFileSync(
        profile,
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(read(profile), 'utf16le'),
        ])
      );
      fs.rmSync(old, { recursive: true });
      expect(repairManagedInstall(options)).toContain(profile);
      expect(fs.readFileSync(profile).subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xfe])
      );
      expect(
        fs.readFileSync(profile).subarray(2).toString('utf16le')
      ).toContain(options.root.replaceAll('\\', '/'));
    }));
});
