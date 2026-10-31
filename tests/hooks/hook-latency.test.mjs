/**
 * Slow tool-call hooks are named at session start and in doctor.
 *
 * On one machine the hooks' p90 was 84 s for weeks and 64 were killed at the
 * host's 600 s timeout; the logs held all of it and nothing read them.
 */

import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  recentToolHookLatency,
  slowHookNotice,
} from '../../hooks-core/hook-latency.mjs';

const ROOT = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'hook-latency-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const NOW = Date.parse('2026-10-29T20:00:00Z');
let n = 0;

/** A log directory holding `runs` (durations in ms, optional phases) and `killed` unfinished starts. */
function logs({ runs = [], killed = 0, killedAgoMs = 30 * 60 * 1000 }) {
  const dir = join(work, `logs-${++n}`);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  runs.forEach((run, i) => {
    const at = new Date(NOW - (runs.length - i) * 1000).toISOString();
    const id = `run-${i}`;
    lines.push({
      event: 'hook.started',
      timestamp: at,
      invocationId: id,
      hookEvent: 'pre-tool',
    });
    lines.push({
      event: 'hook.completed',
      timestamp: at,
      invocationId: id,
      hookEvent: 'pre-tool',
      durationMs: run.ms,
      ...(run.phases ? { phasesMs: run.phases } : {}),
    });
  });
  for (let i = 0; i < killed; i++) {
    lines.push({
      event: 'hook.started',
      timestamp: new Date(NOW - killedAgoMs).toISOString(),
      invocationId: `killed-${i}`,
      hookEvent: 'post-tool',
    });
  }
  // A session-start run is not a tool call and does not count.
  lines.push({
    event: 'hook.completed',
    timestamp: new Date(NOW).toISOString(),
    invocationId: 's',
    hookEvent: 'session-start',
    durationMs: 999999,
  });
  writeFileSync(
    join(dir, 'hook-events-2026-10-29.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
  return dir;
}

const fast = (count) => Array.from({ length: count }, () => ({ ms: 400 }));

describe('recentToolHookLatency', () => {
  test('fast hooks raise no notice', () => {
    const latency = recentToolHookLatency({
      dir: logs({ runs: fast(100) }),
      now: NOW,
    });
    expect(latency).toMatchObject({ runs: 100, p90Ms: 400, killed: 0 });
    expect(slowHookNotice(latency)).toBeNull();
  });

  test('a slow p90 is named, with the phase slow runs spent their time in', () => {
    const slow = Array.from({ length: 20 }, () => ({
      ms: 90_000,
      phases: { resolved: 20, begun: 120, input: 85_000, completed: 90_100 },
    }));
    const latency = recentToolHookLatency({
      dir: logs({ runs: [...fast(80), ...slow] }),
      now: NOW,
    });
    expect(latency.p90Ms).toBe(90_000);
    expect(latency.slowestPhase).toMatchObject({ name: 'reading the payload' });
    const notice = slowHookNotice(latency);
    expect(notice).toContain('the p90 was 90 s');
    expect(notice).toContain('Most of a slow run went to reading the payload.');
  });

  test('hooks the host killed are counted, but only recent ones', () => {
    expect(
      slowHookNotice(
        recentToolHookLatency({
          dir: logs({ runs: fast(50), killed: 3 }),
          now: NOW,
        })
      )
    ).toContain("3 were killed by the host's timeout");
    // Still running, not yet killed.
    expect(
      recentToolHookLatency({
        dir: logs({ runs: fast(50), killed: 3, killedAgoMs: 60_000 }),
        now: NOW,
      }).killed
    ).toBe(0);
    // Days ago.
    expect(
      recentToolHookLatency({
        dir: logs({
          runs: fast(50),
          killed: 3,
          killedAgoMs: 3 * 24 * 3600 * 1000,
        }),
        now: NOW,
      }).killed
    ).toBe(0);
  });

  test('too few runs say nothing', () => {
    const latency = recentToolHookLatency({
      dir: logs({ runs: [{ ms: 90_000 }, { ms: 90_000 }] }),
      now: NOW,
    });
    expect(latency.p90Ms).toBeNull();
    expect(slowHookNotice(latency)).toBeNull();
  });

  test('a missing log directory reads as no runs', () => {
    expect(
      recentToolHookLatency({ dir: join(work, 'absent'), now: NOW })
    ).toMatchObject({ runs: 0, p90Ms: null, killed: 0 });
  });
});

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith('TOKEN_OPTIMIZER_')) env[k] = v;
  return env;
}

/** Runs a session-start entry against `logDir`, optionally under a faked Node version. */
function sessionStart(entry, logDir, node = null) {
  const dir = join(work, `ss-${++n}`);
  const args = [join(ROOT, entry)];
  if (node) {
    const preload = join(work, `fake-${n}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(node)} });
`
    );
    args.unshift('--import', pathToFileURL(preload).href);
  }
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: work,
    windowsHide: true,
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: `ss-${n}`,
      cwd: work,
    }),
    env: {
      ...cleanEnv(),
      TOKEN_OPTIMIZER_LOG_DIR: logDir,
      TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'state'),
      TOKEN_OPTIMIZER_RUNTIME: join(dir, 'runtime'),
      TOKEN_OPTIMIZER_HOME: join(dir, 'home'),
      TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
    },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe.each([
  ['plugin/hooks/session-start.mjs'],
  ['integrations/codex/hooks/session-start.mjs'],
])('%s', (entry) => {
  const slowRuns = () => [
    ...fast(50),
    ...Array.from({ length: 20 }, () => ({ ms: 90_000 })),
  ];

  test('names slow hooks', () => {
    expect(sessionStart(entry, logs({ runs: slowRuns() }))).toContain(
      "token-optimizer's hooks have been slow"
    );
  });

  test('says nothing while hooks are fast', () => {
    expect(sessionStart(entry, logs({ runs: fast(100) }))).not.toContain(
      'have been slow'
    );
  });

  test('leaves the cause to the Node floor notice when Node is below the floor', () => {
    const out = sessionStart(entry, logs({ runs: slowRuns() }), '22.2.0');
    expect(out).toContain('below the supported');
    expect(out).not.toContain('have been slow');
  });
});

describe('a real hook records where its time went', () => {
  test('phase marks from the entry start reach hook.completed', () => {
    const dir = join(work, 'real');
    const env = cleanEnv();
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs')],
      {
        encoding: 'utf8',
        timeout: 60_000,
        cwd: work,
        windowsHide: true,
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: 'ph',
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
          tool_use_id: 't1',
          cwd: work,
        }),
        env: {
          ...env,
          TOKEN_OPTIMIZER_LOG_DIR: join(dir, 'logs'),
          TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'state'),
          TOKEN_OPTIMIZER_RUNTIME: join(dir, 'runtime'),
          TOKEN_OPTIMIZER_HOME: join(dir, 'home'),
        },
      }
    );
    expect(r.status).toBe(0);
    const file = readdirSync(join(dir, 'logs')).find((f) =>
      f.startsWith('hook-events-')
    );
    const completed = readFileSync(join(dir, 'logs', file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.event === 'hook.completed');
    const phases = completed.phasesMs;
    for (const name of ['resolved', 'begun', 'input', 'completed'])
      expect(Number.isFinite(phases[name])).toBe(true);
    expect(phases.resolved).toBeLessThanOrEqual(phases.begun);
    expect(phases.begun).toBeLessThanOrEqual(phases.input);
    expect(phases.input).toBeLessThanOrEqual(phases.completed);
  });
});
