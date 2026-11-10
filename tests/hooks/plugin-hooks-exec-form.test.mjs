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
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isPluginHookFor } from '../../scripts/claude-hook-ownership.mjs';
import {
  CLAUDE_CODE_EXEC_FORM_FLOOR,
  parseClaudeCodeVersion,
  probeClaudeCodeHooks,
} from '../../hooks-core/doctor.mjs';

const pluginRoot = join(process.cwd(), 'plugin');
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
  const plugin = { method: 'plugin' };

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

  it('says nothing when the version is unknown, or the install is not the plugin', () => {
    expect(probeClaudeCodeHooks({ install: plugin, versionText: null })).toEqual([]);
    expect(probeClaudeCodeHooks({ install: { method: 'script' }, versionText: '2.0.0' })).toEqual([]);
  });

  it('pins the floor to the release that added exec form', () => {
    expect(CLAUDE_CODE_EXEC_FORM_FLOOR).toBe('2.1.139');
  });
});
