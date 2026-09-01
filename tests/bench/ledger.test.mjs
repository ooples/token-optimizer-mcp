/**
 * The measurement instrument, tested against the defects it was built to fix.
 *
 * Every case here is a real failure from the campaigns that motivated this
 * harness, with the actual numbers. A benchmark that cannot demonstrate it
 * would have caught its predecessor's mistakes has no claim on anyone's trust.
 */

import { describe, expect, test } from '@jest/globals';
import {
  median,
  bootstrapMedianCI,
  widthRatio,
  samplingVerdict,
  ratioCI,
  significant,
  rng,
} from '../../bench/ledger/stats.mjs';
import {
  rowProblem,
  assertSingleBuild,
  newestBuildOnly,
  buildKey,
} from '../../bench/ledger/provenance.mjs';
import { taskResult, compareArm, report } from '../../bench/ledger/rank.mjs';

/** A row with everything the ledger requires, so tests vary one thing at a time. */
const row = (over = {}) => ({
  task: 'code-bugfix-py',
  arm: 'candidate',
  rep: 1,
  track: 'cold',
  status: 'ok',
  usd: 0.1,
  turns: 6,
  score: 1,
  image_digest: 'sha256:aaa',
  commit_sha: 'abc1234',
  started_at: '2026-08-31T22:05:00Z',
  ...over,
});

describe('the interval is honest about spread', () => {
  test('a tight sample converges -- but not in three reps', () => {
    // WHAT PRECISION ACTUALLY COSTS, and the reason this test is written as a
    // pair. The real arm-B sample has cv 5% and a full range of 10%, so at
    // n=5 a 10%-wide interval is not yet available: the honest verdict is
    // "keep going". It converges once there are enough reps to pin the median.
    //
    // This is the instrument reporting a true property, not a threshold to
    // loosen -- and it is the headline cost of this benchmark over a fixed n=3:
    // a clean task needs roughly 8 reps per arm, not 3.
    const tight = [0.1235, 0.1151, 0.1114, 0.1180, 0.1160];
    expect(samplingVerdict(tight).state).toBe('continue');

    const more = [...tight, 0.1170, 0.1165, 0.1175, 0.1168, 0.1172];
    expect(samplingVerdict(more).state).toBe('converged');
  });

  test('the outlier sample does NOT converge at n=3', () => {
    // The exact log-needle-zh sample whose mean moved a campaign headline from
    // -3.2% to -10.6%. A fixed n=3 called this a result; the ledger refuses to.
    const v = samplingVerdict([0.1129, 0.1112, 0.2727]);
    expect(v.state).toBe('continue');
    expect(v.width).toBeGreaterThan(0.1);
  });

  test('a bimodal task that never narrows is UNRESOLVED, not averaged', () => {
    // code-debug-pipeline-py: ~$0.24 or ~$0.35 depending on the path taken.
    const bimodal = [0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35];
    const v = samplingVerdict(bimodal);
    expect(v.state).toBe('unresolved');
    expect(v.reason).toBe('rep-cap-reached');
  });

  test('below the minimum it asks for more rather than computing anything', () => {
    expect(samplingVerdict([0.1, 0.1]).state).toBe('continue');
    expect(samplingVerdict([0.1, 0.1]).ci).toBeNull();
  });

  test('the interval is reproducible from the same rows', () => {
    // An unseeded bootstrap gives different digits every run, which nobody
    // else can check -- the entire credibility argument fails. Determinism is
    // the property that matters here.
    //
    // NOT asserting that a different seed differs: on a small sample the
    // bootstrap median takes only a few discrete values, so two seeds landing
    // on identical percentiles is ordinary and asserting otherwise would be a
    // flaky test that says nothing about correctness.
    const v = [0.11, 0.13, 0.27, 0.12, 0.14];
    expect(bootstrapMedianCI(v, { seed: 1 })).toEqual(bootstrapMedianCI(v, { seed: 1 }));

    const ci = bootstrapMedianCI(v, { seed: 1 });
    expect(ci.low).toBeLessThanOrEqual(ci.median);
    expect(ci.high).toBeGreaterThanOrEqual(ci.median);
    expect(ci.n).toBe(5);
  });

  test('the PRNG is deterministic', () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test('the median resists the outlier that moves the mean', () => {
    const clean = [0.11, 0.11, 0.12];
    const withOutlier = [0.11, 0.11, 0.27];
    const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.abs(median(withOutlier) - median(clean))).toBeLessThan(0.01);
    expect(Math.abs(mean(withOutlier) - mean(clean))).toBeGreaterThan(0.04);
  });

  test('widthRatio is infinite rather than NaN on a zero estimate', () => {
    expect(widthRatio({ low: 0, high: 0, median: 0 })).toBe(Infinity);
  });
});

describe('a ratio accounts for the control\'s own spread', () => {
  test('a control that wanders widens the interval', () => {
    // The debug tasks' control spread was 34-42%. Treating control as an exact
    // constant is what made arm numbers look confident.
    const arm = [0.10, 0.10, 0.10, 0.10];
    const steady = [0.10, 0.10, 0.10, 0.10];
    const wandering = [0.07, 0.13, 0.08, 0.14];
    const tight = ratioCI(arm, steady, { seed: 3 });
    const loose = ratioCI(arm, wandering, { seed: 3 });
    expect(loose.high - loose.low).toBeGreaterThan(tight.high - tight.low);
  });

  test('parity inside the interval is not an effect', () => {
    const ci = ratioCI([0.10, 0.11, 0.09], [0.10, 0.11, 0.09], { seed: 4 });
    expect(significant(ci)).toBe(false);
  });

  test('a large separated difference is an effect', () => {
    const ci = ratioCI([0.05, 0.05, 0.05, 0.05], [0.10, 0.10, 0.10, 0.10], { seed: 5 });
    expect(significant(ci)).toBe(true);
    expect(ci.ratio).toBeCloseTo(0.5, 5);
  });
});

describe('the ledger charges failures', () => {
  test('a failed run costs money and delivers nothing', () => {
    const r = taskResult([
      row({ usd: 0.10, score: 1 }),
      row({ usd: 0.40, score: 0, status: 'failed' }),
    ]);
    // The old metric would report $0.10. The ledger reports $0.50 for one unit.
    expect(r.spend).toBeCloseTo(0.5, 6);
    expect(r.costPerUnit).toBeCloseTo(0.5, 6);
    expect(r.completion).toBe(0.5);
  });

  test('answering worse to answer cheaper gains nothing', () => {
    // THE PROPERTY THE OLD METRIC LACKED. Half the cost for half the work is
    // the same unit price, so the ranking is indifferent -- as it should be.
    const full = taskResult([row({ usd: 0.10, score: 1 }), row({ usd: 0.10, score: 1 })]);
    const half = taskResult([row({ usd: 0.05, score: 0.5 }), row({ usd: 0.05, score: 0.5 })]);
    expect(half.costPerUnit).toBeCloseTo(full.costPerUnit, 6);
    // And the completion rate exposes which one actually finished the work.
    expect(full.completion).toBe(1);
    expect(half.completion).toBe(0);
  });

  test('a task an arm never completes has an infinite unit cost', () => {
    const r = taskResult([row({ usd: 0.3, score: 0, status: 'failed' })]);
    expect(r.costPerUnit).toBe(Infinity);
  });

  test('a non-ok run claiming a score is rejected as a row', () => {
    expect(rowProblem(row({ status: 'failed', score: 0.8 }))).toMatch(/must score 0/);
  });
});

describe('provenance cannot be skipped', () => {
  test('every required field is required', () => {
    for (const field of ['task', 'arm', 'usd', 'score', 'image_digest', 'commit_sha']) {
      const bad = row();
      delete bad[field];
      expect(rowProblem(bad)).toBe(`missing ${field}`);
    }
  });

  test('a group spanning two builds refuses to summarise', () => {
    // The exact shape of the real incident: same arm, same task, two builds,
    // nothing in the rows to tell them apart except when they ran.
    const mixed = [
      row({ image_digest: 'sha256:old', started_at: '2026-08-31T17:42:05Z' }),
      row({ image_digest: 'sha256:old', started_at: '2026-08-31T17:43:34Z' }),
      row({ image_digest: 'sha256:new', started_at: '2026-08-31T22:08:54Z' }),
    ];
    expect(() => assertSingleBuild(mixed, 'cold/candidate')).toThrow(/spans 2 builds/);
  });

  test('a single-build group is fine and returns its build', () => {
    expect(assertSingleBuild([row(), row({ rep: 2 })])).toBe(buildKey(row()));
  });

  test('recovery keeps the newest build and hands back the discards', () => {
    const mixed = [
      row({ image_digest: 'sha256:old', started_at: '2026-08-31T17:42:05Z' }),
      row({ image_digest: 'sha256:new', started_at: '2026-08-31T22:08:54Z' }),
    ];
    const { kept, dropped, build } = newestBuildOnly(mixed);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(build).toContain('sha256:new');
    // Nothing is deleted -- the caller decides.
    expect(mixed).toHaveLength(2);
  });
});

describe('the report', () => {
  const rows = (arm, track, usds, scores, digest = 'sha256:aaa') =>
    usds.map((usd, i) =>
      row({
        arm,
        track,
        rep: i + 1,
        usd,
        score: scores[i],
        status: scores[i] > 0 ? 'ok' : 'failed',
        image_digest: digest,
      })
    );

  test('cold and warm are never averaged together', () => {
    const out = report([
      ...rows('control', 'cold', [0.10, 0.10, 0.10, 0.10], [1, 1, 1, 1]),
      ...rows('candidate', 'cold', [0.10, 0.10, 0.10, 0.10], [1, 1, 1, 1]),
      ...rows('control', 'warm', [0.10, 0.10, 0.10, 0.10], [1, 1, 1, 1]),
      ...rows('candidate', 'warm', [0.05, 0.05, 0.05, 0.05], [1, 1, 1, 1]),
    ]);
    expect(out.tracks.cold.arms.candidate.costRatio).toBeCloseTo(1, 3);
    expect(out.tracks.warm.arms.candidate.costRatio).toBeCloseTo(0.5, 3);
  });

  test('a mixed-build arm throws instead of producing a headline', () => {
    expect(() =>
      report([
        ...rows('control', 'cold', [0.1, 0.1, 0.1], [1, 1, 1]),
        ...rows('candidate', 'cold', [0.1, 0.1], [1, 1], 'sha256:old'),
        ...rows('candidate', 'cold', [0.1], [1], 'sha256:new'),
      ])
    ).toThrow(/spans 2 builds/);
  });

  test('too many unresolved tasks withholds the headline rather than caveating it', () => {
    // A number with a footnote gets quoted without the footnote.
    const bimodal = [0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35, 0.24, 0.35];
    const ones = bimodal.map(() => 1);
    const out = report([
      ...rows('control', 'cold', bimodal, ones).map((r) => ({ ...r, task: 't1' })),
      ...rows('candidate', 'cold', bimodal, ones).map((r) => ({ ...r, task: 't1' })),
    ]);
    const c = out.tracks.cold.arms.candidate;
    expect(c.unresolved).toContain('t1');
    expect(c.trustworthy).toBe(false);
  });

  test('a task that has not converged is excluded even when it could still improve', () => {
    // THE STATE THAT WAS SLIPPING THROUGH. samplingVerdict returns 'unresolved'
    // only once the rep cap is reached; before that a wide interval returns
    // 'continue'. compareArm excluded only 'unresolved', so a task with six
    // noisy reps under a cap of twelve was folded into the headline as though
    // settled. Observed on the real warm track: four tasks the campaign itself
    // reported as not converged were averaged into "1.081 of control over 4
    // task(s)".
    //
    // For a published number, "not enough evidence yet" and "never will be" are
    // the same thing; they differ only in whether more reps would help.
    const noisy = [0.05, 0.30, 0.07, 0.28, 0.06, 0.31];
    const out = report([
      ...noisy.map((usd, i) =>
        row({ arm: 'control', task: 'wobbly', rep: i + 1, usd })
      ),
      ...noisy.map((usd, i) =>
        row({ arm: 'candidate', task: 'wobbly', rep: i + 1, usd })
      ),
    ]);
    const c = out.tracks.cold.arms.candidate;
    expect(c.unresolved).toContain('wobbly');
    expect(c.tasksCounted).toBe(0);
    expect(c.trustworthy).toBe(false);
  });

  test('malformed rows are reported, not silently dropped', () => {
    const out = report([row(), { task: 'x' }]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].problem).toMatch(/missing/);
  });
});
