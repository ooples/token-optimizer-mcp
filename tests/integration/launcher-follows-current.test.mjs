/**
 * Managed launchers follow `<runtime>/current` instead of pinning a version.
 *
 * THE INCIDENT. `~/.token-optimizer/bin/codex.cmd` was written by 7.3.0 with
 * 7.3.0's run-client path in it. It kept serving 7.3.0 through every refresh,
 * and when 7.4.4 made a fourth version, retention pruned 7.3.0 and every
 * `codex` launch died on `Cannot find module ...\versions\7.3.0\...\
 * run-client.mjs` (2026-10-12). Launchers now name a stable forwarder,
 * `<runtime>/launch-current.mjs`, and existing ones are migrated by repair.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { activateWindowsCommands } from '../../scripts/windows-commands.mjs';
import { activateShells } from '../../scripts/managed-shell.mjs';
import { repairManagedInstall } from '../../scripts/repair-managed-install.mjs';
import {
  FORWARDER_NAME,
  isManagedRuntimeRoot,
  launcherEntry,
} from '../../scripts/launch-entry.mjs';

const FORWARDER_SOURCE = resolve('scripts', FORWARDER_NAME);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

/** A managed runtime whose versions each have a run-client reporting who ran. */
function runtimeWith(versions, current) {
  const runtime = fs.mkdtempSync(join(tmpdir(), 'optimizer-runtime-'));
  dirs.push(runtime);
  const report = join(runtime, 'ran.json');
  versions.forEach((version, index) => {
    const root = packageRoot(runtime, version);
    fs.mkdirSync(join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@ooples/token-optimizer-mcp', version })
    );
    fs.writeFileSync(
      join(root, 'scripts', 'run-client.mjs'),
      `import fs from 'node:fs';\n` +
        `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2) }));\n` +
        `process.exitCode = 7;\n`
    );
    fs.copyFileSync(FORWARDER_SOURCE, join(root, 'scripts', FORWARDER_NAME));
    fs.copyFileSync(resolve('scripts', 'launch-entry.mjs'), join(root, 'scripts', 'launch-entry.mjs'));
    // Older first, so the newest-by-mtime fallback has a defined answer.
    const when = new Date(Date.now() - (versions.length - index) * 60_000);
    fs.utimesSync(join(runtime, 'versions', version), when, when);
  });
  if (current) fs.writeFileSync(join(runtime, 'current'), current);
  return { runtime, report };
}

const packageRoot = (runtime, version) =>
  join(runtime, 'versions', version, 'node_modules', '@ooples', 'token-optimizer-mcp');

/** Run the forwarder as a launcher would, from its copy in the runtime. */
function forward(runtime, args) {
  const forwarder = join(runtime, FORWARDER_NAME);
  fs.copyFileSync(FORWARDER_SOURCE, forwarder);
  const env = { ...process.env };
  delete env.TOKEN_OPTIMIZER_RUNTIME;
  return spawnSync(process.execPath, [forwarder, ...args], { encoding: 'utf8', env });
}

describe('the stable forwarder', () => {
  it("runs the run-client `current` names, with the caller's arguments and exit code", () => {
    const { runtime, report } = runtimeWith(['7.3.0', '7.4.4'], '7.4.4');
    const result = forward(runtime, ['codex', '--flag', 'two words', '']);
    expect(result.status).toBe(7);
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({
      version: '7.4.4',
      args: ['codex', '--flag', 'two words', ''],
    });
  });

  it('follows an update without the launcher changing', () => {
    const { runtime, report } = runtimeWith(['7.4.4', '7.4.5'], '7.4.4');
    forward(runtime, ['codex']);
    expect(JSON.parse(fs.readFileSync(report, 'utf8')).version).toBe('7.4.4');
    fs.writeFileSync(join(runtime, 'current'), '7.4.5');
    forward(runtime, ['codex']);
    expect(JSON.parse(fs.readFileSync(report, 'utf8')).version).toBe('7.4.5');
  });

  it('falls back to the newest installed runtime when `current` names a missing one', () => {
    const { runtime, report } = runtimeWith(['7.4.2', '7.4.3'], '7.3.0');
    expect(forward(runtime, ['codex']).status).toBe(7);
    expect(JSON.parse(fs.readFileSync(report, 'utf8')).version).toBe('7.4.3');
  });

  it('fails with a usable message when no runtime is installed', () => {
    const { runtime } = runtimeWith([], null);
    const result = forward(runtime, ['codex']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no installed runtime');
    expect(result.stderr).toContain('install');
  });
});

describe('what a launcher names', () => {
  it('is the forwarder for a package in the managed runtime, its own run-client otherwise', () => {
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    const managed = packageRoot(runtime, '7.4.4');
    expect(isManagedRuntimeRoot(managed, runtime)).toBe(true);
    expect(launcherEntry(managed, { runtime })).toBe(join(runtime, FORWARDER_NAME));
    expect(fs.readFileSync(join(runtime, FORWARDER_NAME))).toEqual(
      fs.readFileSync(FORWARDER_SOURCE)
    );
    // A global or project install has no `current` to follow (positive control).
    const elsewhere = resolve('.');
    expect(isManagedRuntimeRoot(elsewhere, runtime)).toBe(false);
    expect(launcherEntry(elsewhere, { runtime })).toBe(join(elsewhere, 'scripts', 'run-client.mjs'));
  });

  it('a dry run computes the forwarder path without writing it', () => {
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    expect(launcherEntry(packageRoot(runtime, '7.4.4'), { runtime, install: false })).toBe(
      join(runtime, FORWARDER_NAME)
    );
    expect(fs.existsSync(join(runtime, FORWARDER_NAME))).toBe(false);
  });

  it('the Windows installer writes launchers that name the forwarder', () => {
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    const directory = join(runtime, 'bin');
    let path = 'existing';
    activateWindowsCommands({
      root: packageRoot(runtime, '7.4.4'),
      directory,
      platform: 'win32',
      env: { TOKEN_OPTIMIZER_MANAGED_CLIENTS: 'codex', TOKEN_OPTIMIZER_RUNTIME: runtime },
      registry: { read: () => path, write: (value) => { path = value; } },
    });
    const launcher = fs.readFileSync(join(directory, 'codex.cmd'), 'utf8');
    expect(launcher).toContain(join(runtime, FORWARDER_NAME));
    expect(launcher).not.toMatch(/versions[\\/]7\.4\.4/);
    expect(fs.existsSync(join(runtime, FORWARDER_NAME))).toBe(true);
  });

  (process.platform === 'win32' ? it : it.skip)(
    'a real cmd launch reaches the current runtime, before and after an update',
    () => {
      const { runtime, report } = runtimeWith(['7.4.4', '7.4.5'], '7.4.4');
      const directory = join(runtime, 'bin');
      let path = 'existing';
      activateWindowsCommands({
        root: packageRoot(runtime, '7.4.4'),
        directory,
        platform: 'win32',
        env: { TOKEN_OPTIMIZER_MANAGED_CLIENTS: 'codex', TOKEN_OPTIMIZER_RUNTIME: runtime },
        registry: { read: () => path, write: (value) => { path = value; } },
      });
      // Reached through PATH, as users reach it, with verbatim arguments -- the
      // same invocation the existing launcher test uses, since node's own
      // quoting of a full path is not something cmd parses.
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
      const env = { ...process.env, [pathKey]: `${directory};${process.env[pathKey] || ''}` };
      delete env.TOKEN_OPTIMIZER_RUNTIME;
      const run = () => {
        let status = 0;
        try {
          execFileSync('cmd.exe', ['/d', '/s', '/c', 'codex "a b"'], {
            cwd: directory,
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: 'ignore',
          });
        } catch (error) {
          status = error.status;
        }
        expect(status).toBe(7); // the run-client's own exit code, passed through
        return JSON.parse(fs.readFileSync(report, 'utf8'));
      };
      expect(run()).toEqual({ version: '7.4.4', args: ['codex', 'a b'] });
      fs.writeFileSync(join(runtime, 'current'), '7.4.5');
      expect(run()).toEqual({ version: '7.4.5', args: ['codex', 'a b'] });
    }
  );
});

describe('shell profiles', () => {
  it('recognises an unedited legacy block and moves it onto the forwarder', () => {
    // Older installs wrote a checksum-free block naming the package's own
    // run-client. It is recognised by exact text, so building that text with
    // the forwarder's invocation would call it a user edit and refuse.
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    const root = packageRoot(runtime, '7.4.4');
    const profile = join(runtime, '.bashrc');
    const q = (text) => `'${text.replaceAll("'", "'\\''")}'`;
    const old = `${q(process.execPath)} ${q(join(root, 'scripts', 'run-client.mjs'))}`;
    const legacy = [
      '# >>> token-optimizer managed clients >>>',
      ...['claude', 'codex', 'opencode'].map((c) => `${c}() { ${old} ${c} "$@"; }`),
      '# <<< token-optimizer managed clients <<<',
    ].join('\n');
    fs.writeFileSync(profile, `export KEEP=1\n${legacy}\n`);

    expect(() =>
      activateShells({
        root,
        clients: ['codex'],
        env: {
          TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify([profile]),
          TOKEN_OPTIMIZER_RUNTIME: runtime,
        },
      })
    ).not.toThrow();
    const after = fs.readFileSync(profile, 'utf8');
    expect(after).toContain('export KEEP=1');
    expect(after).toContain(q(join(runtime, FORWARDER_NAME)));
    expect(after).not.toContain('run-client.mjs');
  });
});

(process.platform === 'win32' ? describe.skip : describe)('signals through the forwarder', () => {
  /**
   * A runtime whose run-client is `body(runtime)`. A function, because the
   * client needs the runtime's own path -- which does not exist until here.
   */
  function signalRuntime(body) {
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    fs.writeFileSync(
      join(packageRoot(runtime, '7.4.4'), 'scripts', 'run-client.mjs'),
      body(runtime)
    );
    const forwarder = join(runtime, FORWARDER_NAME);
    fs.copyFileSync(FORWARDER_SOURCE, forwarder);
    return { runtime, forwarder };
  }

  /** The environment a launcher runs in: no override pointing at another runtime. */
  function launchEnv() {
    const env = { ...process.env };
    delete env.TOKEN_OPTIMIZER_RUNTIME;
    return env;
  }

  it('passes a SIGINT sent to the forwarder on to the client', async () => {
    const { runtime, forwarder } = signalRuntime(
      (dir) =>
        `import fs from 'node:fs';\n` +
        `process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(join(dir, 'got-sigint'))}, ''); process.exit(130); });\n` +
        `fs.writeFileSync(${JSON.stringify(join(dir, 'ready'))}, '');\n` +
        `setInterval(() => {}, 1000);\n`
    );
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [forwarder], { stdio: 'ignore', env: launchEnv() });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(join(runtime, 'ready')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGINT');
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    expect(fs.existsSync(join(runtime, 'got-sigint'))).toBe(true);
    expect(code).toBe(130);
  });

  it("ends with the client's signal, not an ordinary exit status", () => {
    const { forwarder } = signalRuntime(
      () => `process.kill(process.pid, 'SIGTERM');\nsetInterval(() => {}, 1000);\n`
    );
    const result = spawnSync(process.execPath, [forwarder], { env: launchEnv(), timeout: 10_000 });
    expect(result.signal).toBe('SIGTERM');
    expect(result.status).toBeNull();
  });
});

describe('the refresh runs the launcher repair', () => {
  /** Call launch.mjs's repairManagedLaunchers in a fresh process, as the refresh does. */
  function repairFromRefresh(root) {
    const launch = new URL('../../plugin/launch.mjs', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { repairManagedLaunchers } = await import(${JSON.stringify(launch)}); process.stdout.write(String(repairManagedLaunchers(${JSON.stringify(root)})));`,
      ],
      { encoding: 'utf8', env: { ...process.env, TOKEN_OPTIMIZER_LAUNCH_IMPORT_ONLY: '1' } }
    );
    return result.stdout.trim();
  }

  it("runs the new package's repair in launcher scope", () => {
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    const root = packageRoot(runtime, '7.4.4');
    const seen = join(runtime, 'repair-env.json');
    fs.writeFileSync(
      join(root, 'scripts', 'repair-managed-install.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ scope: process.env.TOKEN_OPTIMIZER_REPAIR_SCOPE }));`
    );
    expect(repairFromRefresh(root)).toBe('true');
    expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toEqual({ scope: 'launchers' });
  });

  it('skips a package that predates the forwarder, leaving launchers as they were', () => {
    const { runtime } = runtimeWith(['7.4.4'], '7.4.4');
    const root = packageRoot(runtime, '7.4.4');
    fs.rmSync(join(root, 'scripts', FORWARDER_NAME));
    const seen = join(runtime, 'repair-ran');
    fs.writeFileSync(
      join(root, 'scripts', 'repair-managed-install.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(seen)}, '');`
    );
    expect(repairFromRefresh(root)).toBe('false');
    expect(fs.existsSync(seen)).toBe(false);
  });
});

describe('repair migrates a launcher that pins a runtime version', () => {
  function pinnedLauncher(runtime, version) {
    const directory = join(runtime, 'bin');
    fs.mkdirSync(directory, { recursive: true });
    const pinned = join(packageRoot(runtime, version), 'scripts', 'run-client.mjs').replaceAll('\\', '/');
    const text = `@echo off\r\nrem token-optimizer managed launcher v1\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${pinned}" codex %*\r\nexit /b %errorlevel%\r\n`;
    fs.writeFileSync(join(directory, 'codex.cmd'), text);
    fs.writeFileSync(
      join(directory, 'launchers.json'),
      JSON.stringify({ 'codex.cmd': digest(Buffer.from(text)) }, null, 2)
    );
    return directory;
  }

  it('moves it to the forwarder, keeps ownership, and is idempotent', () => {
    const { runtime } = runtimeWith(['7.3.0', '7.4.4'], '7.4.4');
    const directory = pinnedLauncher(runtime, '7.3.0');
    const repair = () =>
      repairManagedInstall({
        root: packageRoot(runtime, '7.4.4'),
        env: { TOKEN_OPTIMIZER_RUNTIME: runtime },
        profiles: () => [],
        directory,
        settingsPath: join(runtime, 'no-settings.json'),
      });

    expect(repair()).toEqual([join(directory, 'codex.cmd')]);
    const launcher = fs.readFileSync(join(directory, 'codex.cmd'));
    expect(launcher.toString()).toContain(join(runtime, FORWARDER_NAME).replaceAll('\\', '/'));
    expect(launcher.toString()).not.toContain('7.3.0');
    expect(fs.existsSync(join(runtime, FORWARDER_NAME))).toBe(true);
    // Ownership is kept: the record matches the rewritten launcher, so later
    // installs and uninstall still recognise it as ours.
    const record = JSON.parse(fs.readFileSync(join(directory, 'launchers.json'), 'utf8'));
    expect(record['codex.cmd']).toBe(digest(launcher));
    expect(repair()).toEqual([]);
  });

  it("in launcher scope, migrates the launcher and leaves Claude's settings untouched", () => {
    const { runtime } = runtimeWith(['7.3.0', '7.4.4'], '7.4.4');
    const directory = pinnedLauncher(runtime, '7.3.0');
    const settingsPath = join(runtime, 'settings.json');
    // A hook command the full repair would upgrade to the new version.
    const hook = join(packageRoot(runtime, '7.3.0'), 'plugin', 'hooks', 'stop.mjs').replaceAll('\\', '/');
    fs.mkdirSync(join(packageRoot(runtime, '7.4.4'), 'plugin', 'hooks'), { recursive: true });
    fs.writeFileSync(join(packageRoot(runtime, '7.4.4'), 'plugin', 'hooks', 'stop.mjs'), '');
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${hook}" --token-optimizer-hook` }] }] },
    });
    fs.writeFileSync(settingsPath, settings);

    const changed = repairManagedInstall({
      root: packageRoot(runtime, '7.4.4'),
      env: { TOKEN_OPTIMIZER_RUNTIME: runtime, TOKEN_OPTIMIZER_REPAIR_SCOPE: 'launchers' },
      profiles: () => [],
      directory,
      settingsPath,
    });

    expect(changed).toEqual([join(directory, 'codex.cmd')]);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settings);
  });

  it('leaves a launcher it did not write alone', () => {
    const { runtime } = runtimeWith(['7.3.0', '7.4.4'], '7.4.4');
    const directory = pinnedLauncher(runtime, '7.3.0');
    fs.appendFileSync(join(directory, 'codex.cmd'), 'rem my change\r\n');
    const before = fs.readFileSync(join(directory, 'codex.cmd'));
    repairManagedInstall({
      root: packageRoot(runtime, '7.4.4'),
      env: { TOKEN_OPTIMIZER_RUNTIME: runtime },
      profiles: () => [],
      directory,
      settingsPath: join(runtime, 'no-settings.json'),
    });
    expect(fs.readFileSync(join(directory, 'codex.cmd'))).toEqual(before);
  });
});
