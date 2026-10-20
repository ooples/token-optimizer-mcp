/**
 * Other installs still hooked beside the running one, and a mode that is off.
 *
 * Regression tests for one machine's state on 2026-10-20: a 7.4.3 plugin, a
 * 5.5.0 npm-global install wired into settings.json and a dispatcher.ps1 from
 * the first PowerShell installer all ran on every tool call, and the 5.5.0
 * router -- which predates `assist` -- refused what the plugin allowed. Separately
 * TOKEN_OPTIMIZER_MODE=off had sat in the settings `env` block for four weeks
 * with nothing ever saying so.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeStrays,
  offModeNotice,
  retireStrays,
  strayEntries,
} from '../../hooks-core/install-health.mjs';

const NPM_HOOKS = 'C:/Users/u/AppData/Roaming/npm/node_modules/@ooples/token-optimizer-mcp/plugin/hooks';
const SCRIPT_HOOKS = '/home/u/.claude-global/hooks/token-optimizer';
const cmd = (command) => ({ hooks: [{ type: 'command', command }] });

/** The settings file as that machine had it, plus a hook of the user's own. */
const observed = () => ({
  env: { TOKEN_OPTIMIZER_MODE: 'assist' },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash|Write', hooks: [{ type: 'command', command: 'python C:/Users/u/.claude/hooks/my_guard.py' }] },
      { matcher: '*', ...cmd('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\u\\.claude-global\\hooks\\dispatcher.ps1" -Phase PreToolUse') },
      { matcher: 'Read|Grep|Glob|Edit|MultiEdit|Write|Bash', ...cmd(`node "${NPM_HOOKS}/pretooluse-router.mjs"`) },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: 'python "C:/Users/u/.claude/hooks/my_gate.py" stop' },
          { type: 'command', command: `node "${NPM_HOOKS}/stop-harvest.mjs"` },
        ],
      },
    ],
    SessionStart: [cmd(`node "${NPM_HOOKS}/session-start.mjs"`)],
  },
});

const tempSettings = (settings) => {
  const dir = mkdtempSync(join(tmpdir(), 'tom-health-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(settings, null, 2));
  return { dir, path };
};

describe('strayEntries finds other installs', () => {
  test('a plugin install counts the npm entries and the dispatcher, not the user hooks', () => {
    const strays = strayEntries(observed());
    const scripts = strays.map((s) => s.script);

    expect(scripts.some((s) => s.endsWith('dispatcher.ps1'))).toBe(true);
    expect(scripts.some((s) => s.endsWith('pretooluse-router.mjs'))).toBe(true);
    expect(scripts.some((s) => s.endsWith('session-start.mjs'))).toBe(true);
    expect(JSON.stringify(strays)).not.toContain('my_guard.py');
  });

  test('our hook inside an entry shared with a user hook is still found', () => {
    // Stop holds the user's gate beside a stale stop-harvest.mjs. Whole-entry
    // ownership left that harvester running forever on the observed machine.
    const strays = strayEntries(observed()).filter((s) => s.event === 'Stop');
    expect(strays).toHaveLength(1);
    expect(strays[0].script).toContain('stop-harvest.mjs');
  });

  test("a script install's own entries are not strays of itself", () => {
    const settings = {
      hooks: {
        SessionStart: [cmd(`node "${SCRIPT_HOOKS}/session-start.mjs" --token-optimizer-hook`)],
        PreToolUse: [cmd(`node "${NPM_HOOKS}/pretooluse-router.mjs"`)],
      },
    };
    const strays = strayEntries(settings, SCRIPT_HOOKS);

    expect(strays).toHaveLength(1);
    expect(strays[0].script).toContain('@ooples/token-optimizer-mcp');
  });

  test('describeStrays names each script once', () => {
    const lines = describeStrays(strayEntries(observed()));
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.join('\n')).toContain('pretooluse-router.mjs');
  });
});

describe('retireStrays removes them and keeps a backup', () => {
  test('stray entries go, the user hooks and other keys stay', () => {
    const { dir, path } = tempSettings(observed());
    const result = retireStrays(path, { now: 1 });
    const after = JSON.parse(readFileSync(path, 'utf8'));

    expect(result.removed.length).toBeGreaterThan(0);
    expect(JSON.stringify(after)).not.toContain('dispatcher.ps1');
    expect(JSON.stringify(after)).not.toContain('pretooluse-router.mjs');
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(JSON.stringify(after)).toContain('my_guard.py');
    // The shared Stop entry keeps the user's gate and loses only our harvester.
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'python "C:/Users/u/.claude/hooks/my_gate.py" stop' }] },
    ]);
    expect(after.env).toEqual({ TOKEN_OPTIMIZER_MODE: 'assist' });
    expect(readdirSync(dir).some((f) => f.includes('token-optimizer-stray-1.bak'))).toBe(true);
    expect(JSON.parse(readFileSync(result.backup, 'utf8'))).toEqual(observed());
  });

  test('a second run finds nothing and writes nothing', () => {
    const { path } = tempSettings(observed());
    retireStrays(path, { now: 1 });
    expect(retireStrays(path, { now: 2 })).toEqual({ removed: [], backup: null });
  });

  test('TOKEN_OPTIMIZER_KEEP_STRAY_HOOKS=1 keeps them', () => {
    const { path } = tempSettings(observed());
    expect(retireStrays(path, { env: { TOKEN_OPTIMIZER_KEEP_STRAY_HOOKS: '1' } }).removed).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(observed());
  });

  test('a file that does not parse is never rewritten', () => {
    const { path } = tempSettings({});
    writeFileSync(path, '{ not json');
    expect(retireStrays(path).removed).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});

describe('offModeNotice says the product is off, once a day', () => {
  const offSettings = () => tempSettings({ env: { TOKEN_OPTIMIZER_MODE: 'off' } });

  test('it names the settings file that switched it off and suggests assist', () => {
    const { dir, path } = offSettings();
    const stampDir = join(dir, 'stamp');
    mkdirSync(stampDir);
    const notice = offModeNotice({ env: { TOKEN_OPTIMIZER_SETTINGS: path }, now: Date.UTC(2026, 9, 20), stampDir });

    expect(notice).toContain(path);
    expect(notice).toContain('TOKEN_OPTIMIZER_MODE=assist');
  });

  test('the same day stays quiet, the next day speaks again', () => {
    const { dir, path } = offSettings();
    const env = { TOKEN_OPTIMIZER_SETTINGS: path };
    const stampDir = join(dir, 'stamp');
    const day = Date.UTC(2026, 9, 20, 8);

    expect(offModeNotice({ env, now: day, stampDir })).not.toBeNull();
    expect(offModeNotice({ env, now: day + 3_600_000, stampDir })).toBeNull();
    expect(offModeNotice({ env, now: day + 86_400_000, stampDir })).not.toBeNull();
  });

  test('without a settings entry it blames the environment', () => {
    const { dir } = tempSettings({});
    const notice = offModeNotice({
      env: { TOKEN_OPTIMIZER_SETTINGS: join(dir, 'missing.json') },
      stampDir: join(dir, 'stamp'),
    });
    expect(notice).toContain('the environment');
  });
});
