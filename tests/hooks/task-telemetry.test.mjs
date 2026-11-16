/**
 * Task classification's evidence (task-ledger.mjs, task-report.mjs) and the
 * measure-only fold that costs Claude Code's prompts (toolprune.mjs).
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARM_CLASSIFIED,
  ARM_HOLDOUT,
  ledgerPath,
  readTaskEvents,
  recordClassified,
  recordOutcomes,
  recordSettled,
  taskArm,
} from '../../src/hooks-core/task-ledger.mjs';
import {
  MATCH_WINDOW_MS,
  MIN_ARM_PROMPTS,
  ratioInterval,
  renderTaskReport,
  taskReport,
} from '../../src/hooks-core/task-report.mjs';
import { sessionSettings, settingsFor } from '../../src/hooks-core/task-settings.mjs';
import { TaskCategory } from '../../src/hooks-core/task-class.mjs';
import { promptSubmitted } from '../../src/hooks-core/task-session.mjs';
import { runFold, scheduleFold, sessionUsage } from '../../src/hooks-core/toolprune.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, '..', '..', 'src', 'plugin', 'hooks');

let work;
let counter = 0;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'task-telemetry-'));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
const fresh = (name) => {
  const dir = join(work, `${name}-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const homeEnv = (extra = {}) => ({ TOKEN_OPTIMIZER_HOME: fresh('home'), TOKEN_OPTIMIZER_INJECTION_HOLDOUT: '0', ...extra });
const holdoutOn = (fraction) => ({ TOKEN_OPTIMIZER_INJECTION_HOLDOUT: '1', TOKEN_OPTIMIZER_INJECTION_HOLDOUT_FRACTION: String(fraction) });

/** A session id whose task arm under `env` is `arm`. */
function sessionIn(arm, env) {
  for (let i = 0; i < 10_000; i += 1) if (taskArm(`pick-${i}`, env) === arm) return `pick-${i}`;
  throw new Error(`no session lands in ${arm}`);
}

// Claude Code's transcript shape: two prompts, each answered by billed messages.
const iso = (ms) => new Date(ms).toISOString();
function transcript(dir, sessionId, t0) {
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: iso(t0), message: { role: 'user', content: 'fix the failing test' } },
    { type: 'assistant', uuid: 'a1', timestamp: iso(t0 + 1000), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 10 } } },
    // The same message id streamed twice is billed once.
    { type: 'assistant', uuid: 'a1b', timestamp: iso(t0 + 1500), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 10 } } },
    { type: 'user', uuid: 'u2', timestamp: iso(t0 + 60_000), message: { role: 'user', content: 'now summarise the repository' } },
    // A late duplicate of the FIRST prompt's message stays billed to that prompt.
    { type: 'assistant', uuid: 'a1c', timestamp: iso(t0 + 60_500), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 10 } } },
    { type: 'assistant', uuid: 'a2', timestamp: iso(t0 + 61_000), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 300, output_tokens: 40 } } },
    { type: 'assistant', uuid: 'a3', timestamp: iso(t0 + 62_000), message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 50, output_tokens: 5 } } },
  ];
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

describe('ledger', () => {
  test('records signal names, never their values, and reads back only its own generation', () => {
    const env = homeEnv();
    recordClassified(
      {
        sessionId: 's1',
        gen: 5,
        category: 'locate',
        signals: ['locate:large-input:C:/secret/project/huge.log', 'locate:where is'],
        client: 'codex',
        arm: ARM_CLASSIFIED,
      },
      env
    );
    recordSettled({ sessionId: 's1', taskClass: { category: 'fix', source: 'tool', calls: 2, gen: 5 } }, env);
    recordOutcomes('s1', [{ at: 123, costUnits: 10.6, outputTokens: 3 }, { at: 0, costUnits: 1, outputTokens: 1 }], env);
    const text = readFileSync(ledgerPath(env), 'utf8');
    expect(text).not.toMatch(/secret|huge\.log/);
    writeFileSync(ledgerPath(env), `${text}{"g":0,"k":"classified","s":"old","gen":1}\n{torn`);
    const rows = readTaskEvents(env);
    expect(rows.map((r) => r.k)).toEqual(['classified', 'settled', 'outcome']);
    expect(rows[0]).toMatchObject({ s: 's1', gen: 5, c: 'locate', client: 'codex', sig: ['locate:large-input', 'locate:where is'] });
    expect(rows[1]).toMatchObject({ c: 'fix', src: 'tool', calls: 2, arm: ARM_CLASSIFIED });
    expect(rows[2]).toMatchObject({ promptAt: 123, cu: 11, out: 3 });
  });

  test('the arm is deterministic per session, off with the holdout off, and salted apart from the injection holdout', async () => {
    const { holdoutUnit } = await import('../../src/hooks-core/injection-holdout.mjs');
    expect(taskArm('any', { TOKEN_OPTIMIZER_INJECTION_HOLDOUT: '0' })).toBe(ARM_CLASSIFIED);
    expect(taskArm('', holdoutOn(0.5))).toBe(ARM_CLASSIFIED);
    const ids = Array.from({ length: 2000 }, (_, i) => `sess-${i}`);
    const held = ids.filter((id) => taskArm(id, holdoutOn(0.1)) === ARM_HOLDOUT);
    expect(held.length).toBeGreaterThan(140);
    expect(held.length).toBeLessThan(260);
    expect(ids.every((id) => taskArm(id, holdoutOn(0.1)) === taskArm(id, holdoutOn(0.1)))).toBe(true);
    // Not the injection holdout's draw: the two experiments overlap only by chance.
    const injection = ids.filter((id) => holdoutUnit(id, 'task-class') !== holdoutUnit(id, 'injection'));
    expect(injection.length).toBe(ids.length);
  });
});

describe('the holdout runs the UNKNOWN row', () => {
  test('sessionSettings for a held-out session ignores its category; a classified one keeps it', () => {
    const env = holdoutOn(0.5);
    const state = { taskClass: { category: TaskCategory.SURVEY, source: 'prompt', calls: 0, gen: 1 } };
    const held = sessionIn(ARM_HOLDOUT, env);
    const kept = sessionIn(ARM_CLASSIFIED, env);
    expect(settingsFor(TaskCategory.SURVEY, env)).not.toEqual(settingsFor(TaskCategory.UNKNOWN, env));
    expect(sessionSettings(state, env, { sessionId: held })).toEqual(settingsFor(TaskCategory.UNKNOWN, env));
    expect(sessionSettings(state, env, { sessionId: kept })).toEqual(settingsFor(TaskCategory.SURVEY, env));
  });

  test('promptSubmitted records the category, the client and the arm, and a held-out survey still gets discipline', () => {
    const stateDir = fresh('state');
    const env = { ...homeEnv(), ...holdoutOn(0.5), TOKEN_OPTIMIZER_STATE_DIR: stateDir, TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '' };
    const saved = process.env.TOKEN_OPTIMIZER_STATE_DIR;
    process.env.TOKEN_OPTIMIZER_STATE_DIR = stateDir;
    try {
      const held = sessionIn(ARM_HOLDOUT, env);
      const kept = sessionIn(ARM_CLASSIFIED, env);
      const survey = 'give me an overview of how this repository is structured';
      const heldText = promptSubmitted({ sessionId: held, prompt: survey, cwd: work, agent: null, client: 'claude-code', env });
      const keptText = promptSubmitted({ sessionId: kept, prompt: survey, cwd: work, agent: null, client: 'claude-code', env });
      // Survey turns discipline off; the UNKNOWN row keeps it on.
      expect(heldText.context).toMatch(/\S/);
      expect(keptText.context).toBe('');
      const rows = readTaskEvents(env).filter((r) => r.k === 'classified');
      expect(rows).toEqual([
        expect.objectContaining({ s: held, c: 'survey', client: 'claude-code', arm: ARM_HOLDOUT }),
        expect.objectContaining({ s: kept, c: 'survey', client: 'claude-code', arm: ARM_CLASSIFIED }),
      ]);
    } finally {
      if (saved === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
      else process.env.TOKEN_OPTIMIZER_STATE_DIR = saved;
    }
  });
});

describe('the fold costs each prompt', () => {
  test('sessionUsage splits billed usage by the prompt it answered, counting a re-streamed message once', () => {
    const t0 = Date.UTC(2026, 10, 1, 10, 0);
    const usage = sessionUsage(transcript(fresh('t'), 'x', t0));
    expect(usage.segments).toEqual([
      { at: t0, costUnits: 100 + 10 * 5, outputTokens: 10 },
      { at: t0 + 60_000, costUnits: 350 + 45 * 5, outputTokens: 45 },
    ].map((s) => expect.objectContaining({ at: s.at, outputTokens: s.outputTokens })));
    expect(usage.segments[0].costUnits + usage.segments[1].costUnits).toBe(usage.costUnits);
    expect(usage.segments[1].costUnits).toBeGreaterThan(usage.segments[0].costUnits);
  });

  test('a measure-only fold records outcomes for ledger sessions only, and writes no deny list or holdout outcome', () => {
    const env = { ...homeEnv(), TOKEN_OPTIMIZER_INJECTION_HOLDOUT: '1' };
    const transcripts = fresh('transcripts');
    const root = fresh('root');
    const dir = fresh('learned');
    const t0 = Date.UTC(2026, 10, 1, 10, 0);
    transcript(transcripts, 'known', t0);
    transcript(transcripts, 'stranger', t0);
    recordClassified({ sessionId: 'known', gen: t0, category: 'fix', signals: [], client: 'claude-code', arm: ARM_CLASSIFIED }, env);
    const summary = runFold({ dir, root, transcriptDir: transcripts, env, measureOnly: true });
    expect(summary).toEqual({ mode: 'measure', folded: 2 });
    const outcomes = readTaskEvents(env).filter((r) => r.k === 'outcome');
    expect(outcomes.map((r) => [r.s, r.promptAt])).toEqual([
      ['known', t0],
      ['known', t0 + 60_000],
    ]);
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false);
    expect(readFileSync(join(dir, 'toolprune.json'), 'utf8')).toMatch(/known/);
    // Positive control: the same fold not measure-only does record the injection holdout's outcome.
    const other = fresh('learned');
    runFold({ dir: other, root, transcriptDir: transcripts, env });
    const holdoutFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.startsWith('holdout')) : []);
    expect(holdoutFiles(dir)).toEqual([]);
    expect(holdoutFiles(other).length).toBeGreaterThan(0);
  });

  test('scheduleFold measure-only spawns nothing until something was classified', () => {
    const env = homeEnv({ TOKEN_OPTIMIZER_TOOLPRUNE: 'off' });
    const args = { dir: fresh('d'), root: fresh('r'), transcriptPath: join(fresh('t'), 'x.jsonl'), sessionId: 'x', env };
    expect(scheduleFold({ ...args, measureOnly: true })).toBe(false);
    expect(scheduleFold(args)).toBe(false);
    recordClassified({ sessionId: 'x', gen: 1, category: 'fix', signals: [], arm: ARM_CLASSIFIED }, env);
    expect(scheduleFold({ ...args, measureOnly: true })).toBe(true);
    expect(scheduleFold({ ...args, measureOnly: true, env: { ...env, TOKEN_OPTIMIZER_SIDECALL: '1' } })).toBe(false);
  });

  test("Claude Code's own SessionStart runs the measure-only fold end to end", () => {
    const home = fresh('home');
    // The injection holdout ON: a fold that is not measure-only would record its outcome.
    const wiki = fresh('wk');
    const env = { ...process.env, TOKEN_OPTIMIZER_HOME: home, TOKEN_OPTIMIZER_INJECTION_HOLDOUT: '1', TOKEN_OPTIMIZER_STATE_DIR: fresh('st'), TOKEN_OPTIMIZER_WIKI_DIR: wiki };
    const transcripts = fresh('transcripts');
    const t0 = Date.now() - 3 * 60 * 60 * 1000;
    transcript(transcripts, 'finished', t0);
    recordClassified({ sessionId: 'finished', gen: t0, category: 'fix', signals: [], client: 'claude-code', arm: ARM_CLASSIFIED }, env);
    const cwd = fresh('ws');
    const out = spawnSync(process.execPath, [join(HOOKS, 'session-start.mjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd, session_id: 'live', transcript_path: join(transcripts, 'live.jsonl') }),
      encoding: 'utf8',
      timeout: 30_000,
      env,
    });
    expect(out.status).toBe(0);
    // Detached: give it up to 20 s to land.
    const deadline = Date.now() + 20_000;
    let outcomes = [];
    while (Date.now() < deadline) {
      outcomes = readTaskEvents(env).filter((r) => r.k === 'outcome');
      if (outcomes.length) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    expect(outcomes.map((r) => r.s)).toEqual(['finished', 'finished']);
    const files = readdirSync(wiki, { recursive: true }).map(String);
    expect(files.some((f) => /toolprune\.json$/.test(f))).toBe(true);
    expect(files.filter((f) => /holdout/.test(f))).toEqual([]);
  }, 40_000);

  test('through the shipped hooks, a prompt is recorded as classified and its Stop as settled', () => {
    const home = fresh('home');
    const env = { ...process.env, TOKEN_OPTIMIZER_HOME: home, TOKEN_OPTIMIZER_INJECTION_HOLDOUT: '0', TOKEN_OPTIMIZER_STATE_DIR: fresh('st'), TOKEN_OPTIMIZER_WIKI_DIR: fresh('wk') };
    const cwd = fresh('ws');
    const base = { cwd, session_id: 'hooked', transcript_path: join(fresh('t'), 'hooked.jsonl') };
    const run = (script, payload) =>
      spawnSync(process.execPath, [join(HOOKS, script)], { input: JSON.stringify({ ...base, ...payload }), encoding: 'utf8', timeout: 30_000, env });
    expect(run('user-prompt-submit.mjs', { hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing test in parser.js' }).status).toBe(0);
    expect(run('stop.mjs', { hook_event_name: 'Stop' }).status).toBe(0);
    const rows = readTaskEvents(env);
    const made = rows.find((r) => r.k === 'classified');
    expect(made).toMatchObject({ s: 'hooked', c: 'fix', client: 'claude-code', arm: ARM_CLASSIFIED });
    expect(rows.find((r) => r.k === 'settled')).toMatchObject({ s: 'hooked', gen: made.gen, c: 'fix' });
  });
});

describe('report', () => {
  const T = Date.UTC(2026, 10, 1);
  const classified = (s, gen, c, arm = ARM_CLASSIFIED, at = gen, client = 'claude-code') => ({ k: 'classified', s, gen, c, arm, at, client });
  const settled = (s, gen, c) => ({ k: 'settled', s, gen, c });
  const outcome = (s, promptAt, cu, at = promptAt + 3_600_000) => ({ k: 'outcome', s, promptAt, cu, at });

  test('counts corrections from the LAST settle of a generation, never a re-sent classification twice', () => {
    const rows = [
      classified('a', T, 'fix'),
      classified('a', T, 'build'),
      settled('a', T, 'survey'),
      settled('a', T, 'fix'),
      classified('b', T + 1, 'fix'),
      settled('b', T + 1, 'build'),
      classified('c', T + 2, 'survey'),
    ];
    const report = taskReport(rows);
    expect(report.prompts).toBe(3);
    expect(report.mix).toEqual({ fix: 2, survey: 1 });
    expect(report.corrections.fix).toEqual({ settled: 2, corrected: 1, to: { build: 1 } });
    expect(report.corrections.survey).toEqual({ settled: 0, corrected: 0, to: {} });
  });

  test('an outcome joins the nearest classification inside the window, by its settled category, keeping the latest re-fold', () => {
    const rows = [
      classified('a', T, 'fix'),
      settled('a', T, 'build'),
      classified('a', T + 600_000, 'survey', ARM_CLASSIFIED, T + 600_000),
      outcome('a', T + 5_000, 999),
      outcome('a', T + 5_000, 40),
      outcome('a', T + 600_000 - 1_000, 70),
      outcome('a', T + 600_000 + MATCH_WINDOW_MS + 1, 5),
    ];
    const report = taskReport(rows);
    expect(report.cost.build.classified).toEqual({ prompts: 1, median: 40 });
    expect(report.cost.survey.classified).toEqual({ prompts: 1, median: 70 });
    expect(report.unmatched).toBe(1);
    expect(report.matched).toBe(2);
  });

  test('a ratio needs MIN_ARM_PROMPTS in both arms, and its interval covers the true effect', () => {
    const rand = (() => {
      let x = 7;
      return () => ((x = (x * 48271) % 2147483647) / 2147483647);
    })();
    const control = Array.from({ length: 200 }, () => 1000 + 400 * rand());
    const treated = Array.from({ length: 200 }, () => 800 + 320 * rand());
    expect(ratioInterval(treated.slice(0, MIN_ARM_PROMPTS - 1), control)).toBeNull();
    const effect = ratioInterval(treated, control);
    expect(effect.ratio).toBeCloseTo(0.8, 1);
    expect(effect.low).toBeLessThan(0.8);
    expect(effect.high).toBeGreaterThan(0.8);
    expect(effect.high).toBeLessThan(1);
    expect(ratioInterval(treated, control)).toEqual(effect);
  });

  test('renders nothing for an empty ledger and says why a cost has no ratio yet', () => {
    expect(renderTaskReport(taskReport([]))).toEqual([]);
    const text = renderTaskReport(
      taskReport([classified('a', T, 'fix'), settled('a', T, 'fix'), outcome('a', T, 10)])
    ).join('\n');
    expect(text).toMatch(/prompts classified : 1 — fix 1/);
    expect(text).toMatch(/fix +corrected by tool calls: 0\/1 \(0%\)/);
    expect(text).toMatch(/no ratio below 20 prompts per arm/);
    expect(text).not.toMatch(/\$/);
  });

  test('scoped to one session, it reports only that session', () => {
    const rows = [classified('a', T, 'fix'), classified('b', T, 'survey')];
    expect(taskReport(rows, { sessionId: 'b' }).mix).toEqual({ survey: 1 });
  });
});
