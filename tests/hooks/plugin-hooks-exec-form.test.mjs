/**
 * The plugin's hooks must not need a shell, and must not lock the session when
 * they cannot run.
 *
 * A shell-form hook (`"command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs\""`)
 * is run through a shell. On Windows that shell is Git Bash. When Git Bash, or
 * `node` itself, is not on the Claude Code process's PATH (a fresh install not
 * yet in this session's PATH, a machine without Git for Windows), the hook
 * cannot launch, and Claude Code then BLOCKS every matching tool call: Read,
 * Grep, Glob, Edit, Write, Bash and PowerShell. The session can do nothing.
 *
 * The exec form ("command": "node", "args": [script]) spawns node directly with
 * no shell. "onFailure": "continue" makes a hook that cannot launch let the
 * call through: an optimizer that is unavailable must cost tokens, not the
 * session.
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { isPluginHookFor } from '../../src/scripts/claude-hook-ownership.mjs';
import {
  CLAUDE_CODE_EXEC_FORM_FLOOR,
  hooksUseExecForm,
  parseClaudeCodeVersion,
  probeClaudeCodeHooks,
  readClaudeCodeVersion,
  resolveClaudeExecutable,
} from '../../src/hooks-core/doctor.mjs';

const pluginRoot = join(process.cwd(), 'src', 'plugin');
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
const hooks = Object.entries(manifest.hooks).flatMap(([event, groups]) =>
  groups.flatMap((group) => group.hooks.map((hook) => ({ event, hook })))
);

describe('plugin hooks.json', () => {
  it('declares hooks', () => {
    expect(hooks.length).toBeGreaterThan(0);
  });

  it.each(hooks.map(({ event, hook }) => [event, hook.args?.[0], hook]))(
    '%s %s runs node directly (no shell) and fails open',
    (_event, _script, hook) => {
      expect(hook.type).toBe('command');
      expect(hook.command).toBe('node');
      expect(Array.isArray(hook.args)).toBe(true);
      expect(hook.args).toHaveLength(1);
      expect(hook.args[0]).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.mjs$/);
      expect(hook.onFailure).toBe('continue');
    }
  );

  it.each(hooks.map(({ hook }) => [hook.args?.[0]]))('%s exists in the plugin', (script) => {
    const relative = script.replace('${CLAUDE_PLUGIN_ROOT}/', '');
    expect(existsSync(join(pluginRoot, relative))).toBe(true);
  });
});

describe('isPluginHookFor', () => {
  const file = 'pretooluse-router.mjs';

  it('recognizes the exec form', () => {
    expect(
      isPluginHookFor(
        { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-router.mjs'] },
        file
      )
    ).toBe(true);
  });

  it('still recognizes the shell form earlier versions shipped', () => {
    expect(
      isPluginHookFor({ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-router.mjs"' }, file)
    ).toBe(true);
  });

  it('rejects another script, extra arguments and non-command hooks', () => {
    expect(
      isPluginHookFor({ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs'] }, file)
    ).toBe(false);
    expect(
      isPluginHookFor(
        { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-router.mjs', '--x'] },
        file
      )
    ).toBe(false);
    expect(isPluginHookFor({ type: 'prompt', command: 'node' }, file)).toBe(false);
    expect(isPluginHookFor(null, file)).toBe(false);
  });
});

// Claude Code added exec-form hooks in 2.1.139. An older one ignores `args`, runs bare `node`,
// and every plugin hook silently does nothing. hooks.json cannot declare a minimum client
// version, so the doctor has to say so.
describe('the doctor checks Claude Code can run exec-form hooks', () => {
  // The plugin under test ships exec-form hooks; probeClaudeCodeHooks reads the INSTALLED copy.
  const plugin = { method: 'plugin', hooksDir: join(pluginRoot, 'hooks') };

  it('reads the version `claude --version` prints', () => {
    expect(parseClaudeCodeVersion('2.1.322 (Claude Code)\n')).toBe('2.1.322');
    expect(parseClaudeCodeVersion('not a version')).toBeNull();
    expect(parseClaudeCodeVersion(null)).toBeNull();
  });

  it('fails a Claude Code older than the exec-form release, and says how to fix it', () => {
    const [check] = probeClaudeCodeHooks({ install: plugin, versionText: '2.1.138 (Claude Code)' });
    expect(check.pass).toBe(false);
    expect(check.detail).toContain(CLAUDE_CODE_EXEC_FORM_FLOOR);
    expect(check.remedy).toMatch(/claude update/);
  });

  it('passes the exec-form release itself and anything newer', () => {
    for (const version of [CLAUDE_CODE_EXEC_FORM_FLOOR, '2.1.322', '2.2.0', '3.0.0']) {
      const [check] = probeClaudeCodeHooks({ install: plugin, versionText: version });
      expect(check.pass).toBe(true);
      expect(check.warn).toBeUndefined();
    }
  });

  it('warns, rather than staying silent, when the version cannot be read', () => {
    const [check] = probeClaudeCodeHooks({ install: plugin, versionText: null });
    expect(check.pass).toBe(true);
    expect(check.warn).toBe(true);
    expect(check.detail).toMatch(/unverified/);
    expect(check.remedy).toContain('claude --version');
  });

  it('says nothing for an install that is not the plugin', () => {
    expect(probeClaudeCodeHooks({ install: { method: 'script' }, versionText: '2.0.0' })).toEqual([]);
  });

  it('judges the installed manifest: an older shell-form plugin cache runs on any version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-form-'));
    try {
      const write = (hook) =>
        writeFileSync(
          join(dir, 'hooks.json'),
          JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', ...hook }] }] } })
        );
      const installed = { method: 'plugin', hooksDir: dir };
      write({ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs"' });
      expect(hooksUseExecForm(dir)).toBe(false);
      expect(probeClaudeCodeHooks({ install: installed, versionText: '2.0.0' })).toEqual([]);
      write({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs'] });
      expect(hooksUseExecForm(dir)).toBe(true);
      const [check] = probeClaudeCodeHooks({ install: installed, versionText: '2.0.0' });
      expect(check.pass).toBe(false);
      expect(hooksUseExecForm(join(dir, 'missing'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the floor to the release that added exec form', () => {
    expect(CLAUDE_CODE_EXEC_FORM_FLOOR).toBe('2.1.139');
  });
});

// The doctor runs `claude --version`. Windows looks in the current directory before PATH, so a
// repository carrying claude.cmd would run if the doctor resolved `claude` the default way.
describe('the doctor resolves claude outside the working directory', () => {
  const withSandbox = (body) => {
    const root = mkdtempSync(join(tmpdir(), 'claude-resolve-'));
    const dir = (name) => {
      const path = join(root, name);
      mkdirSync(path);
      return path;
    };
    try {
      body({ root, dir });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const touch = (path) => writeFileSync(path, '');

  it('never picks a claude in the working directory, even when PATH lists it', () => {
    withSandbox(({ dir }) => {
      const repo = dir('repo');
      const bin = dir('bin');
      touch(join(repo, 'claude.cmd'));
      touch(join(bin, 'claude.exe'));
      const found = resolveClaudeExecutable({
        env: { PATH: [repo, '.', '', bin].join(';') },
        platform: 'win32',
        cwd: repo,
      });
      expect(found).toBe(join(bin, 'claude.exe'));
    });
  });

  it('skips relative PATH entries, and finds nothing rather than falling back', () => {
    withSandbox(({ root, dir }) => {
      const repo = dir('repo');
      touch(join(repo, 'claude.cmd'));
      // A relative entry that DOES lead to a claude.cmd from this process's directory: only the
      // absolute-path rule keeps it out, since `cwd` here is a different directory.
      const relativeToProcess = relative(process.cwd(), repo);
      expect(existsSync(join(relativeToProcess, 'claude.cmd'))).toBe(true);
      expect(
        resolveClaudeExecutable({ env: { PATH: `.;${relativeToProcess}` }, platform: 'win32', cwd: root })
      ).toBeNull();
    });
  });

  it('prefers the native claude.exe over the npm claude.cmd shim in the same directory', () => {
    withSandbox(({ root, dir }) => {
      const bin = dir('bin');
      touch(join(bin, 'claude.cmd'));
      expect(resolveClaudeExecutable({ env: { PATH: bin }, platform: 'win32', cwd: root })).toBe(
        join(bin, 'claude.cmd')
      );
      touch(join(bin, 'claude.exe'));
      expect(resolveClaudeExecutable({ env: { PATH: bin }, platform: 'win32', cwd: root })).toBe(
        join(bin, 'claude.exe')
      );
    });
  });

  // cmd.exe /s strips the outermost quote pair, so a shim under "C:\Program Files\..." was cut
  // at the space and the version read failed. Windows only: a .cmd needs cmd.exe.
  (process.platform === 'win32' ? it : it.skip)(
    'reads the version from a .cmd shim whose path has spaces',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'claude-shim-'));
      try {
        const dir = join(root, 'Program Files', 'npm');
        mkdirSync(dir, { recursive: true });
        const shim = join(dir, 'claude.cmd');
        writeFileSync(shim, '@echo off\r\necho 2.1.322 (Claude Code)\r\n');
        const text = await readClaudeCodeVersion({ executable: shim });
        expect(parseClaudeCodeVersion(text)).toBe('2.1.322');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('reads no version when no claude was found, instead of running a bare name', async () => {
    await expect(readClaudeCodeVersion({ executable: null })).resolves.toBeNull();
  });
});
