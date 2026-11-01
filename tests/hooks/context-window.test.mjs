/**
 * A Claude Code session above its configured compaction window is told so.
 *
 * Sessions on one machine compacted at about 965K although the user had set
 * autoCompactWindow 400000: they started before the setting, and Claude Code
 * reads the window when a session starts. Every turn re-reads the whole
 * context, so the excess is paid on every turn.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  otherSessionsNotice,
  overWindowNotice,
} from '../../hooks-core/context-window.mjs';

const ROOT = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'context-window-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;

/** A Claude config dir with these user settings, and a project dir with these project settings. */
function world({ user = {}, project = null, local = null } = {}) {
  const base = join(work, `w${++n}`);
  const config = join(base, 'claude');
  const cwd = join(base, 'repo');
  mkdirSync(join(config, 'projects', 'proj'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(config, 'settings.json'), JSON.stringify(user));
  if (project)
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify(project)
    );
  if (local)
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify(local)
    );
  return { config, cwd, env: { CLAUDE_CONFIG_DIR: config } };
}

/** A transcript whose last model response saw `tokens` of context. */
function transcript(
  w,
  name,
  tokens,
  { model = 'claude-opus-5-5', ageMs = 0 } = {}
) {
  const path = join(w.config, 'projects', 'proj', `${name}.jsonl`);
  const lines = [
    { type: 'user', cwd: w.cwd, message: { role: 'user', content: 'go' } },
    {
      type: 'assistant',
      cwd: w.cwd,
      message: {
        model,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: tokens - 1010,
          cache_creation_input_tokens: 1000,
        },
      },
    },
    // A synthetic message carries zeros and says nothing about the context.
    {
      type: 'assistant',
      cwd: w.cwd,
      message: {
        model: '<synthetic>',
        usage: { input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
  return path;
}

describe('this session', () => {
  test('above the configured window, it is told once what the excess costs', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const notice = overWindowNotice(transcript(w, 's', 520_000), {
      env: w.env,
    });
    expect(notice).toContain('520K tokens, above the 400K autoCompactWindow');
    expect(notice).toContain('about 1.3x');
    expect(notice).toContain('/compact');
  });

  test('within the window, or with the window on auto, nothing is said', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const inside = transcript(w, 'in', 380_000);
    expect(overWindowNotice(inside, { env: w.env })).toBeNull();
    const auto = world({ user: { autoCompactWindow: 'auto' } });
    expect(
      overWindowNotice(transcript(auto, 'a', 900_000), { env: auto.env })
    ).toBeNull();
    const unset = world({});
    expect(
      overWindowNotice(transcript(unset, 'u', 900_000), { env: unset.env })
    ).toBeNull();
  });

  test.each([
    ['400k', 520_000, true],
    ['1M', 520_000, false],
    ['200', 250_000, true],
    [600000, 520_000, false],
  ])(
    'the window %p is read the way Claude Code reads it',
    (value, tokens, over) => {
      const w = world({ user: { autoCompactWindow: value } });
      expect(
        overWindowNotice(transcript(w, 'v', tokens), { env: w.env }) !== null
      ).toBe(over);
    }
  );

  test('the environment variable takes precedence over settings', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const path = transcript(w, 'e', 520_000);
    expect(
      overWindowNotice(path, {
        env: { ...w.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600k' },
      })
    ).toBeNull();
  });

  test('project settings take precedence over user settings', () => {
    const w = world({
      user: { autoCompactWindow: 400000 },
      local: { autoCompactWindow: '1M' },
    });
    expect(
      overWindowNotice(transcript(w, 'p', 520_000), { env: w.env })
    ).toBeNull();
    const p = world({
      user: { autoCompactWindow: '1M' },
      project: { autoCompactWindow: 400000 },
    });
    expect(
      overWindowNotice(transcript(p, 'p', 520_000), { env: p.env })
    ).toContain('400K');
  });

  test('a per-model window applies to its model, and one for another model makes it unknowable', () => {
    const mine = world({
      user: {
        autoCompactWindow: '1M',
        modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 300000 } },
      },
    });
    expect(
      overWindowNotice(transcript(mine, 'm', 350_000), { env: mine.env })
    ).toContain('300K');
    const other = world({
      user: {
        autoCompactWindow: 400000,
        modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: 300000 } },
      },
    });
    expect(
      overWindowNotice(transcript(other, 'o', 520_000), { env: other.env })
    ).toBeNull();
  });

  test('a transcript without usage says nothing', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const path = join(w.config, 'projects', 'proj', 'empty.jsonl');
    writeFileSync(path, '{"type":"user"}\n');
    expect(overWindowNotice(path, { env: w.env })).toBeNull();
    expect(
      overWindowNotice(join(w.config, 'absent.jsonl'), { env: w.env })
    ).toBeNull();
  });
});

describe('other sessions', () => {
  test('active sessions above the window are counted, the largest named; this one and idle ones are not', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const own = transcript(w, 'own', 900_000);
    transcript(w, 'big', 760_000);
    transcript(w, 'mid', 520_000);
    transcript(w, 'small', 300_000);
    transcript(w, 'idle', 950_000, { ageMs: 3 * 60 * 60 * 1000 });
    const notice = otherSessionsNotice(own, { env: w.env });
    expect(notice).toContain('2 other Claude Code sessions');
    expect(notice).toContain('the largest is at 760K tokens against 400K');
  });

  test('none above the window says nothing', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const own = transcript(w, 'own', 100_000);
    transcript(w, 'small', 300_000);
    expect(otherSessionsNotice(own, { env: w.env })).toBeNull();
    expect(otherSessionsNotice(null, { env: w.env })).toBeNull();
  });
});

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith('TOKEN_OPTIMIZER_') && !key.startsWith('CLAUDE_'))
      env[key] = value;
  return env;
}

function run(entry, w, payload, state) {
  const r = spawnSync(process.execPath, [join(ROOT, entry)], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: w.cwd,
    windowsHide: true,
    input: JSON.stringify({ cwd: w.cwd, ...payload }),
    env: {
      ...cleanEnv(),
      ...w.env,
      TOKEN_OPTIMIZER_STATE_DIR: state,
      TOKEN_OPTIMIZER_RUNTIME: join(state, 'runtime'),
      TOKEN_OPTIMIZER_HOME: join(state, 'home'),
      TOKEN_OPTIMIZER_LOG_DIR: join(state, 'logs'),
      TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
    },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe('the Claude Code hooks deliver it', () => {
  test('post-tool tells the session itself, once', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const path = transcript(w, 'live', 520_000);
    const state = join(w.cwd, '..', 'state');
    const call = (id) =>
      run(
        'plugin/hooks/post-tool.mjs',
        w,
        {
          hook_event_name: 'PostToolUse',
          session_id: 'live',
          transcript_path: path,
          tool_name: 'Bash',
          tool_use_id: id,
          tool_input: { command: 'echo hi' },
          tool_response: { stdout: 'hi', stderr: '' },
        },
        state
      );
    expect(call('t1')).toContain('above the 400K autoCompactWindow');
    expect(call('t2')).not.toContain('autoCompactWindow');
  });

  test('session start reports other sessions above the window', () => {
    const w = world({ user: { autoCompactWindow: 400000 } });
    const own = transcript(w, 'fresh', 20_000);
    transcript(w, 'old', 760_000);
    const out = run(
      'plugin/hooks/session-start.mjs',
      w,
      {
        hook_event_name: 'SessionStart',
        session_id: 'fresh',
        transcript_path: own,
      },
      join(w.cwd, '..', 'state')
    );
    expect(out).toContain(
      'Another Claude Code session on this machine is above the configured autoCompactWindow'
    );
  });
});
