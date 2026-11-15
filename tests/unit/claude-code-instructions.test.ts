import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  claudeCodeHooksWired,
  instructionsFor,
  PLUGIN_INSTRUCTIONS,
} from '../../src/server/plugin-instructions.js';
// The installer's own merge, so the test recognises exactly what it writes.
// @ts-expect-error -- plain .mjs module without type declarations
import { wire } from '../../src/hooks-core/wire.mjs';

const HOOKS_DIR = '/opt/token-optimizer/src/plugin/hooks';

describe('Claude Code instructions follow the hooks, not only the plugin', () => {
  let dir: string;
  let userDir: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'to-instructions-'));
    userDir = path.join(dir, 'user');
    project = path.join(dir, 'project');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(path.join(project, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: userDir,
    CLAUDE_PROJECT_DIR: project,
    ...extra,
  });
  const writeSettings = (file: string, settings: unknown) =>
    writeFileSync(file, JSON.stringify(settings));

  it('a script install wired into the user settings gets the short text', async () => {
    writeSettings(path.join(userDir, 'settings.json'), wire({}, HOOKS_DIR));
    const e = env();
    expect(await claudeCodeHooksWired(e)).toBe(true);
    expect(instructionsFor(e, await claudeCodeHooksWired(e))).toBe(
      PLUGIN_INSTRUCTIONS
    );
  });

  it('project settings, shared or local, count too', async () => {
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(project, '.claude', name);
      writeSettings(file, wire({}, HOOKS_DIR));
      expect(await claudeCodeHooksWired(env())).toBe(true);
      rmSync(file);
    }
  });

  it('another client on the same machine keeps the long text', async () => {
    writeSettings(path.join(userDir, 'settings.json'), wire({}, HOOKS_DIR));
    const cursor = env({ CLAUDECODE: undefined });
    expect(await claudeCodeHooksWired(cursor)).toBe(false);
    expect(instructionsFor(cursor, false)).not.toBe(PLUGIN_INSTRUCTIONS);
  });

  it('Claude Code without our hooks keeps the long text', async () => {
    writeSettings(path.join(userDir, 'settings.json'), {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'node /home/me/my-hook.mjs' }],
          },
        ],
      },
    });
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('missing or malformed settings mean not wired, never a throw', async () => {
    expect(await claudeCodeHooksWired(env())).toBe(false);
    writeFileSync(path.join(userDir, 'settings.json'), '{not json');
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('only a PreToolUse entry of ours counts: the short text promises compaction', async () => {
    const wired = wire({}, HOOKS_DIR) as { hooks: Record<string, unknown> };
    writeSettings(path.join(userDir, 'settings.json'), {
      hooks: { SessionStart: wired.hooks.SessionStart },
    });
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('a plugin install keeps the short text whatever the settings say', () => {
    expect(instructionsFor({ CLAUDE_PLUGIN_ROOT: '/p' }, false)).toBe(
      PLUGIN_INSTRUCTIONS
    );
  });
});
