/**
 * The campaign loop, exercised with a fake agent.
 *
 * Every property here is one the previous harness got wrong and could only be
 * debugged by spending money. Injecting the executor makes them free to pin,
 * which is the whole reason the runner is shaped this way.
 */

import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runColdTask, runWarmSequence, campaignProvenance } from '../../bench/ledger/run.mjs';
import { validateTask, scoreWorkspace, zeroScore } from '../../bench/ledger/task.mjs';
import { TASKS, ADVERSARIAL, GOLDEN, forTrack, singleShotExtract } from '../../bench/ledger/tasks/index.mjs';
import { rowProblem } from '../../bench/ledger/provenance.mjs';

const PROV = campaignProvenance({ imageDigest: 'sha256:aaa', commitSha: 'abc1234' });

/** A task whose score is dictated by the fixture, so the loop can be steered. */
const fakeTask = (id = 't') => ({
  id,
  family: 'fake',
  adversarial: false,
  tracks: ['cold', 'warm'],
  prompt: 'do the thing',
  setup: () => {},
  checks: [{ name: 'ok', weight: 1, run: (ws) => ws?.pass === true }],
});

/** An executor that returns a scripted sequence of costs, then repeats the last. */
const scripted = (costs, { pass = true, status = 'ok' } = {}) => {
  let i = 0;
  return async () => {
    const usd = costs[Math.min(i, costs.length - 1)];
    i += 1;
    return { status, usd, turns: 5, workspace: { pass } };
  };
};

describe('the task contract', () => {
  test('every shipped task is valid', () => {
    for (const task of TASKS) expect(validateTask(task)).toEqual([]);
  });

  test('adversarial must be declared, never inferred', () => {
    const t = fakeTask();
    delete t.adversarial;
    expect(validateTask(t)).toContain('adversarial must be declared explicitly');
  });

  test('the battery actually contains adversarial families', () => {
    // The defence against "the vendor picked tasks that suit them" is only real
    // if this set is non-empty and stays that way.
    expect(ADVERSARIAL.length).toBeGreaterThan(0);
    expect(new Set(ADVERSARIAL.map((t) => t.family))).toEqual(
      new Set(['single-shot', 'generation'])
    );
  });

  test('a throwing check is errored, not silently failed', () => {
    // Conflating the two lets a broken verifier deflate every arm equally and
    // look like a finding.
    const task = {
      ...fakeTask(),
      checks: [
        { name: 'boom', weight: 1, run: () => { throw new Error('bad check'); } },
        { name: 'fine', weight: 1, run: () => true },
      ],
    };
    const out = scoreWorkspace(task, {});
    expect(out.score).toBe(0.5);
    expect(out.errored).toBe(1);
    expect(out.checks[0].errored).toMatch(/bad check/);
  });

  test('partial credit distinguishes cheaper-but-worse from done', () => {
    const task = {
      ...fakeTask(),
      checks: [
        { name: 'fixed', weight: 3, run: (ws) => ws.fixed },
        { name: 'test intact', weight: 3, run: (ws) => ws.testIntact },
      ],
    };
    const proper = scoreWorkspace(task, { fixed: true, testIntact: true });
    const cheated = scoreWorkspace(task, { fixed: true, testIntact: false });
    expect(proper.score).toBe(1);
    expect(cheated.score).toBe(0.5);
  });
});

describe('cold sampling', () => {
  test('stops early once the interval is tight', async () => {
    const steady = Array(12).fill(0.10);
    const { rows, verdict } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute: scripted(steady),
      provenance: PROV,
    });
    expect(verdict.state).toBe('converged');
    expect(rows.length).toBeLessThan(12);
  });

  test('spends the full cap on a bimodal task and reports UNRESOLVED', async () => {
    const bimodal = [0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35];
    const { rows, verdict } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute: scripted(bimodal),
      provenance: PROV,
    });
    expect(rows).toHaveLength(12);
    expect(verdict.state).toBe('unresolved');
  });

  test('the ROW carries the token breakdown, not just the outcome object', async () => {
    // THE WIRING, NOT THE UNIT. readOutcome was instrumented and tested, and
    // every row still came out with tokens undefined, because the row is built
    // here rather than in the executor -- a full campaign reported an output
    // ratio of NaN before anyone noticed. A unit test on the producer says
    // nothing about whether the consumer copies the field.
    const execute = async () => ({
      status: 'ok',
      usd: 0.1,
      turns: 4,
      workspace: { pass: true },
      tokens: { input: 5, output: 900, cache_creation: 100, cache_read: 7000, web_search: 1, web_fetch: 0 },
    });
    const { rows } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute,
      provenance: PROV,
      precision: { minReps: 1, maxReps: 1 },
    });
    expect(rows[0].tokens).toEqual({
      input: 5, output: 900, cache_creation: 100, cache_read: 7000, web_search: 1, web_fetch: 0,
    });
  });

  test('a failing run still produces a row that carries its cost', async () => {
    const { rows } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute: scripted([0.4], { status: 'failed' }),
      provenance: PROV,
      precision: { minReps: 1, maxReps: 1 },
    });
    expect(rows[0].usd).toBeCloseTo(0.4, 6);
    expect(rows[0].score).toBe(0);
    // And it must be a row the ledger will accept, not a discard.
    expect(rowProblem(rows[0])).toBeNull();
  });

  test('an executor that throws is a scored row, not a crash', async () => {
    const { rows } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute: async () => { throw new Error('container died'); },
      provenance: PROV,
      precision: { minReps: 1, maxReps: 1 },
    });
    expect(rows[0].status).toBe('error');
    expect(rows[0].score).toBe(0);
  });

  test('convergence is on unit cost, not raw spend', async () => {
    // Cost is perfectly steady while the score wobbles, so the WORK done per
    // dollar is not settled. Converging on usd alone would call this finished.
    let n = 0;
    const execute = async () => {
      n += 1;
      return { status: 'ok', usd: 0.1, turns: 5, workspace: { pass: n % 2 === 0 } };
    };
    const { rows } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute,
      provenance: PROV,
    });
    // Half the reps score 0 and are excluded from the unit-cost sample, so it
    // cannot reach the minimum quickly -- the loop keeps sampling.
    expect(rows.length).toBeGreaterThan(3);
  });
});

describe('warm sequencing', () => {
  test('one state directory is shared across the sequence, fresh per rep', async () => {
    const seen = [];
    const execute = async ({ stateDir, task }) => {
      seen.push({ dir: stateDir, task: task.id });
      return { status: 'ok', usd: 0.1, turns: 5, workspace: { pass: true } };
    };
    let made = 0;
    const { rows } = await runWarmSequence([fakeTask('a'), fakeTask('b')], {
      arm: 'candidate',
      execute,
      freshStateDir: async () => `dir-${++made}`,
      provenance: PROV,
    });

    // Within a rep the two tasks share a directory; across reps they differ.
    const byRep = new Map();
    for (const row of rows) {
      if (!byRep.has(row.rep)) byRep.set(row.rep, new Set());
    }
    const dirsPerRep = [];
    for (let i = 0; i < seen.length; i += 2) dirsPerRep.push([seen[i].dir, seen[i + 1].dir]);
    for (const [x, y] of dirsPerRep) expect(x).toBe(y);
    expect(new Set(dirsPerRep.map(([x]) => x)).size).toBe(dirsPerRep.length);
  });

  test('the sequence repeats as a unit, so every task shares a rep index', async () => {
    const { rows } = await runWarmSequence([fakeTask('a'), fakeTask('b')], {
      arm: 'candidate',
      execute: scripted([0.1]),
      provenance: PROV,
    });
    for (const rep of new Set(rows.map((r) => r.rep))) {
      expect(rows.filter((r) => r.rep === rep).map((r) => r.task).sort()).toEqual(['a', 'b']);
    }
  });

  test('one unresolved task does not stop the others being reported', async () => {
    // COUNTED PER TASK, not globally. A shared counter gave 'b' only even
    // values -- so it was perfectly steady and converged, and the test failed
    // for the fixture's reason rather than the code's.
    const calls = new Map();
    const execute = async ({ task }) => {
      const n = (calls.get(task.id) || 0) + 1;
      calls.set(task.id, n);
      // 'a' is steady; 'b' alternates and can never converge.
      const usd = task.id === 'a' ? 0.1 : n % 2 ? 0.24 : 0.35;
      return { status: 'ok', usd, turns: 5, workspace: { pass: true } };
    };
    const { unresolved, rows } = await runWarmSequence([fakeTask('a'), fakeTask('b')], {
      arm: 'candidate',
      execute,
      provenance: PROV,
    });
    expect(unresolved).toEqual(['b']);
    expect(rows.filter((r) => r.task === 'a').length).toBeGreaterThan(0);
  });
});

describe('provenance is not optional', () => {
  test('a campaign without a build identity refuses to start', () => {
    // Discovering this after spending the money is the failure it prevents.
    expect(() => campaignProvenance({})).toThrow(/requires imageDigest and commitSha/);
    expect(() => campaignProvenance({ imageDigest: 'sha256:a' })).toThrow();
  });

  test('every row carries the build it came from', async () => {
    const { rows } = await runColdTask(fakeTask(), {
      arm: 'candidate',
      execute: scripted([0.1]),
      provenance: PROV,
      precision: { minReps: 1, maxReps: 1 },
    });
    expect(rows[0].image_digest).toBe('sha256:aaa');
    expect(rows[0].commit_sha).toBe('abc1234');
  });
});

describe('the shipped verifiers actually discriminate', () => {
  test('single-shot extraction scores a right and a wrong answer differently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-task-'));
    try {
      singleShotExtract.setup(dir);
      expect(scoreWorkspace(singleShotExtract, dir).score).toBe(0);

      writeFileSync(join(dir, 'ANSWER.txt'), '9999\n');
      const wrong = scoreWorkspace(singleShotExtract, dir);
      expect(wrong.score).toBeGreaterThan(0);
      expect(wrong.score).toBeLessThan(1);

      writeFileSync(join(dir, 'ANSWER.txt'), '4500\n');
      expect(scoreWorkspace(singleShotExtract, dir).score).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deleting the test to make the suite pass does not earn full marks', () => {
    // The cheapest way to make a failing suite green, and the behaviour an
    // agent under token pressure is most likely to reach for.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-cheat-'));
    try {
      const task = TASKS.find((t) => t.id === 'debug-pipeline-py');
      task.setup(dir);
      mkdirSync(join(dir, 'pipeline'), { recursive: true });
      writeFileSync(join(dir, 'pipeline/clean.py'), 'def normalise(record):\n    record["value"] = record["value"].strip()\n    return record\n');
      writeFileSync(join(dir, 'tests/test_pipeline.py'), '# removed\n');
      const cheated = scoreWorkspace(task, dir);
      expect(cheated.score).toBeLessThan(1);
      expect(cheated.checks.find((c) => c.name === 'test still asserts the original behaviour').passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the generation verifier accepts every idiomatic doubling', () => {
    // CAUGHT BY A REAL CAMPAIGN. The first version required /(\*\s*2|...)/,
    // which cannot match `delay *= 2` because the `=` sits between the `*` and
    // the `2`. The control arm therefore completed this task 25% of the time
    // while writing correct, documented Python -- the benchmark scoring its own
    // regex. The first body below is verbatim what the agent actually wrote.
    const task = TASKS.find((t) => t.id === 'pure-generation');
    const bodies = [
      // Real agent output, captured from a campaign run.
      'MAX_DELAY_MS = 30000\n\ndef delays(attempts, base_ms):\n    result = []\n    delay = base_ms\n    for _ in range(attempts):\n        result.append(min(delay, MAX_DELAY_MS))\n        delay *= 2\n    return result\n',
      // Other correct spellings that must also pass.
      'def delays(attempts, base_ms):\n    return [min(base_ms * 2 ** i, 30000) for i in range(attempts)]\n',
      'def delays(attempts, base_ms):\n    return [min(base_ms << i, 30_000) for i in range(attempts)]\n',
    ];

    for (const body of bodies) {
      const dir = mkdtempSync(join(tmpdir(), 'ledger-gen-'));
      try {
        task.setup(dir);
        mkdirSync(join(dir, 'util'), { recursive: true });
        writeFileSync(join(dir, 'util/backoff.py'), body);
        expect(scoreWorkspace(task, dir).score).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the generation verifier still rejects a non-answer', () => {
    // Generous about spelling, strict about the two facts that matter.
    const task = TASKS.find((t) => t.id === 'pure-generation');
    const dir = mkdtempSync(join(tmpdir(), 'ledger-gen-bad-'));
    try {
      task.setup(dir);
      mkdirSync(join(dir, 'util'), { recursive: true });
      // Defined, but neither doubles nor caps.
      writeFileSync(join(dir, 'util/backoff.py'), 'def delays(attempts, base_ms):\n    return [base_ms] * attempts\n');
      expect(scoreWorkspace(task, dir).score).toBeLessThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the battery contains a repository big enough for an index to matter', () => {
    // THE LIMITATION THAT NEARLY RETIRED A FEATURE. A full campaign concluded
    // the project index bought nothing measurable -- and then the fixtures were
    // measured: the largest was THREE FILES, 342 bytes. An index over three
    // files cannot save anything, because the model reads the whole repository
    // in one turn. That was a fact about the battery, not the feature.
    const needle = TASKS.find((t) => t.id === 'needle-in-repo');
    const dir = mkdtempSync(join(tmpdir(), 'ledger-needle-'));
    try {
      needle.setup(dir);
      const files = readdirSync(join(dir, 'pkg'));
      expect(files.length).toBeGreaterThanOrEqual(60);

      // Unfixed: partial credit only, because the repository is intact.
      expect(scoreWorkspace(needle, dir).score).toBeLessThan(0.5);

      const target = join(dir, 'pkg/mod_047.py');
      writeFileSync(
        target,
        readFileSync(target, 'utf8').replace('return round(amount) * rate', 'return round(amount * rate)')
      );
      expect(scoreWorkspace(needle, dir).score).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rewriting the repository to force a match does not score full marks', () => {
    // The cheapest wrong answer on a large repo: edit broadly until something
    // matches. The collateral-damage check exists to make that unprofitable.
    const needle = TASKS.find((t) => t.id === 'needle-in-repo');
    const dir = mkdtempSync(join(tmpdir(), 'ledger-needle-bad-'));
    try {
      needle.setup(dir);
      const target = join(dir, 'pkg/mod_047.py');
      writeFileSync(
        target,
        readFileSync(target, 'utf8').replace('return round(amount) * rate', 'return round(amount * rate)')
      );
      // Correct fix, but another module gutted along the way.
      writeFileSync(join(dir, 'pkg/mod_012.py'), '# emptied\n');
      const scored = scoreWorkspace(needle, dir);
      expect(scored.score).toBeLessThan(1);
      expect(scored.checks.find((c) => c.name === 'the rest of the repository is untouched').passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(TASKS.map((t) => [t.id]))(
    'a known-correct solution scores 1.000: %s',
    (id) => {
      // THE GATE FOR A WHOLE DEFECT CLASS. Three verifiers here have shipped
      // coupled to exact source text, and the last one scored a PERFECTLY fixed
      // workspace at 0.571 for ten reps across two arms -- caught only because
      // completion came back at 0%. A check is worthless until a known-correct
      // answer passes it, so every task must declare one and clear it.
      const task = TASKS.find((t) => t.id === id);
      const golden = GOLDEN[id];
      expect(typeof golden).toBe('function');

      const dir = mkdtempSync(join(tmpdir(), 'ledger-golden-'));
      try {
        task.setup(dir);
        // Unsolved must NOT already be full marks, or the check proves nothing.
        expect(scoreWorkspace(task, dir).score).toBeLessThan(1);
        golden(dir);
        const scored = scoreWorkspace(task, dir);
        expect(scored.errored).toBe(0);
        expect(scored.score).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test('every task has a golden solution declared', () => {
    // A task added without one would silently opt out of the gate above.
    expect(Object.keys(GOLDEN).sort()).toEqual(TASKS.map((t) => t.id).sort());
  });

  test('terseness is rewarded, but terseness that drops a fact is not', () => {
    // THE WHOLE POINT OF THE PROSE TASK. The output-discipline block changes
    // prose, and every other task in the battery has a code deliverable, so the
    // most likely way that block could do harm was invisible. Here a SHORT
    // complete answer scores 1.000 while a SHORTER answer missing the cause
    // scores far less -- and the ledger charges both at full price, so cost per
    // unit delivered moves the right way with no separate quality metric.
    const task = TASKS.find((t) => t.id === 'explain-failure');
    const score = (answer) => {
      const dir = mkdtempSync(join(tmpdir(), 'ledger-prose-'));
      try {
        task.setup(dir);
        writeFileSync(join(dir, 'ANSWER.md'), answer);
        return scoreWorkspace(task, dir).score;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const terseComplete =
      'normalise in pipeline/clean.py uses .lstrip(), stripping only the left, ' +
      'so trailing whitespace survives.';
    const verboseComplete =
      'I looked at the repository and examined the test suite carefully. After some ' +
      'investigation it turns out that the function normalise, which lives in the file ' +
      'pipeline/clean.py, is calling .lstrip() rather than the method it ought to call. ' +
      'The consequence is that trailing whitespace on the right hand side survives.';
    const terseLossy = 'The whitespace handling in the pipeline is wrong.';

    // Brevity costs nothing when the facts survive.
    expect(score(terseComplete)).toBe(1);
    expect(score(verboseComplete)).toBe(1);
    // Brevity that loses the cause is penalised, heavily.
    expect(score(terseLossy)).toBeLessThan(0.4);
  });

  test('answering the explain task by editing the code does not score', () => {
    // An arm that fixes the bug has done different work than the one asked for.
    const task = TASKS.find((t) => t.id === 'explain-failure');
    const dir = mkdtempSync(join(tmpdir(), 'ledger-prose-edit-'));
    try {
      task.setup(dir);
      GOLDEN['explain-failure'](dir);
      expect(scoreWorkspace(task, dir).score).toBe(1);
      // Now also "helpfully" fix it.
      const p = join(dir, 'pipeline/clean.py');
      writeFileSync(p, readFileSync(p, 'utf8').replace('.lstrip()', '.strip()'));
      expect(scoreWorkspace(task, dir).score).toBeLessThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('forTrack only offers tasks that declare the track', () => {
    for (const t of forTrack('cold')) expect(t.tracks).toContain('cold');
    expect(forTrack('warm').map((t) => t.id)).toContain('repeat-comprehension');
    expect(forTrack('cold').map((t) => t.id)).not.toContain('repeat-comprehension');
  });
});
