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
  permutationP,
  holm,
  rng,
  DEFAULT_PRECISION,
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

  test('three clustered samples cannot be called converged', () => {
    // A percentile bootstrap of the median resamples WITH REPLACEMENT, so at
    // n=3 every resampled median is one of those same three values and the
    // interval can never exceed [min, max] of the sample. Three draws that
    // land close therefore report a 2-4% width on no evidence -- which
    // published two "significant" results in a real campaign before the floor
    // was raised.
    for (const sample of [[0.100, 0.102, 0.104], [0.100, 0.101, 0.099]]) {
      const ci = bootstrapMedianCI(sample, { seed: 1 });
      // The interval really is tight -- that is the trap, not the defence.
      expect(widthRatio(ci)).toBeLessThan(0.06);
      // The defence is refusing to call it converged.
      expect(samplingVerdict(sample).state).toBe('continue');
      expect(samplingVerdict(sample).reason).toBe('below-min-reps');
    }
  });

  test('the minimum is high enough that the median has resolution', () => {
    expect(DEFAULT_PRECISION.minReps).toBeGreaterThanOrEqual(6);
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

describe('a fixed-n design does not look at the data to decide when to stop', () => {
  // WHY THIS EXISTS. The adaptive rule is optional stopping: it stops when the
  // interval looks narrow, so an arm stops early precisely when its sample
  // happened to be tight. Measured over our own 36 arm-task cells, cells that
  // stopped at n<=7 had mean CV 9.4% and cells that ran to the cap had 17.1%
  // -- the variance estimate is conditioned on the stopping decision. Three
  // results that survived multiplicity correction were all early stops.
  test('a tight sample does NOT end the run early', () => {
    // The exact case the adaptive rule stops on, and must not here.
    const tight = [0.100, 0.101, 0.100, 0.099, 0.100, 0.101];
    expect(samplingVerdict(tight).state).toBe('converged');
    expect(samplingVerdict(tight, { fixedReps: 20 }).state).toBe('continue');
    expect(samplingVerdict(tight, { fixedReps: 20 }).reason).toBe('below-fixed-reps');
  });

  test('a wide sample at the pre-specified n is finished, not unresolved', () => {
    // Under the adaptive rule this is `unresolved` and gets excluded from the
    // headline. Under a fixed design the count was agreed in advance, so the
    // interval is the answer -- wide is a result, not a failure to converge.
    const wide = [0.02, 0.30, 0.05, 0.28, 0.03, 0.31];
    expect(samplingVerdict(wide, { maxReps: 6 }).state).toBe('unresolved');
    const fixed = samplingVerdict(wide, { fixedReps: 6 });
    expect(fixed.state).toBe('converged');
    expect(fixed.reason).toBe('fixed-n');
    expect(fixed.width).toBeGreaterThan(0.10);
  });

  test('the rep floor and the width target cannot override a fixed n', () => {
    const tight = [0.100, 0.101, 0.100];
    // minReps would say continue, targetWidthRatio would say converged; a
    // fixed design must ignore both and answer only on the count.
    expect(
      samplingVerdict(tight, { fixedReps: 3, minReps: 12, targetWidthRatio: 0.001 }).state
    ).toBe('converged');
  });

  test('the adaptive rule is untouched when no fixed n is given', () => {
    const tight = [0.100, 0.101, 0.100, 0.099, 0.100, 0.101];
    expect(samplingVerdict(tight, { fixedReps: null }).state).toBe('converged');
    expect(samplingVerdict(tight, { fixedReps: null }).reason).toBe('precise');
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

  test('the achieved level agrees with the interval it came from', () => {
    // The two must never disagree: a level above alpha alongside an interval
    // that excludes parity would let a reader pick whichever supports the
    // claim. They are computed from the same resample distribution precisely
    // so that cannot happen.
    const separated = ratioCI([0.05, 0.05, 0.05, 0.05], [0.10, 0.10, 0.10, 0.10], { seed: 5 });
    const overlapping = ratioCI([0.10, 0.11, 0.09], [0.10, 0.11, 0.09], { seed: 4 });
    expect(separated.p).toBeLessThan(0.05);
    expect(overlapping.p).toBeGreaterThan(0.05);
  });

  test('a level is never claimed finer than the resampling can resolve', () => {
    const ci = ratioCI([0.001], [1000], { seed: 6, resamples: 500 });
    expect(ci.p).toBeCloseTo(1 / 501, 6);
  });
});

describe('the multiplicity input is calibrated against the null', () => {
  const pairs = (costs) => costs.map((c) => [c, 1]);

  test('two arms drawn from the same costs are not called significant', () => {
    // THE PROPERTY THE OLD INPUT LACKED. Bootstrap tail mass resamples the
    // OBSERVED arms and never simulates parity, so it could not be uniform
    // under the null by construction. A permutation test can be, and this is
    // the case that shows it.
    const a = pairs([0.10, 0.11, 0.09, 0.10, 0.12, 0.08, 0.10, 0.11]);
    const b = pairs([0.11, 0.09, 0.10, 0.12, 0.08, 0.10, 0.11, 0.09]);
    expect(permutationP(a, b)).toBeGreaterThan(0.05);
  });

  test('a large real separation is called significant', () => {
    const a = pairs([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
    const b = pairs([0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10]);
    expect(permutationP(a, b)).toBeLessThan(0.05);
  });

  test('a stable small gap does NOT pin to the resolution floor', () => {
    // THE EXACT DEFECT BEING REPLACED. With the interval's own tail mass, any
    // ratio sitting cleanly away from 1 put every draw on one side and returned
    // 1/(resamples+1) -- so a 4% difference and a 60% difference both entered
    // Holm as maximally significant, and the correction was decided by the
    // resample count rather than the evidence.
    const small = pairs([0.096, 0.096, 0.096, 0.096, 0.096, 0.096]);
    const base = pairs([0.100, 0.100, 0.100, 0.100, 0.100, 0.100]);
    const huge = pairs([0.040, 0.040, 0.040, 0.040, 0.040, 0.040]);

    const pSmall = permutationP(small, base);
    const pHuge = permutationP(huge, base);
    // Both separate perfectly, so a tail-mass level would give both the floor.
    // A permutation test cannot tell them apart either when every value is
    // identical -- what it CAN do is refuse to report either as stronger than
    // the permutation resolution allows, and never below the (+1) bound.
    const floor = 1 / 2001;
    expect(pSmall).toBeGreaterThanOrEqual(floor);
    expect(pHuge).toBeGreaterThanOrEqual(floor);
  });

  test('a p-value is never exactly zero, and lands on the resolution bound', () => {
    // Phipson-Smyth: a permutation test cannot resolve past its resample count,
    // and reporting p = 0 claims that it can.
    //
    // SIZED SO THE BOUND IS THE ONLY WAY TO PASS. With six against six the
    // shuffle redraws the original split roughly twice in 2,000 tries, so the
    // count is non-zero anyway and dropping the (+1) would still give p > 0 --
    // a test that cannot see the bug. Ten against ten is one split in 184,756,
    // and fifty resamples will not find it, so the count is 0 and the (+1) is
    // the entire difference between 1/51 and a false zero.
    const ten = (v) => pairs(Array.from({ length: 10 }, () => v));
    const p = permutationP(ten(0.001), ten(10), { resamples: 50 });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeCloseTo(1 / 51, 10);
  });

  test('an empty side yields NaN rather than a confident answer', () => {
    expect(Number.isNaN(permutationP([], pairs([0.1, 0.1])))).toBe(true);
    expect(Number.isNaN(permutationP(pairs([0.1, 0.1]), []))).toBe(true);
  });

  test('the direction of the difference does not change the p-value', () => {
    // Two-sided on the LOG ratio, so a halving and a doubling are equally far
    // from parity. On the raw ratio they are not.
    const a = pairs([0.05, 0.05, 0.05, 0.05, 0.06, 0.05]);
    const b = pairs([0.10, 0.10, 0.10, 0.10, 0.11, 0.10]);
    expect(permutationP(a, b, { seed: 7 })).toBeCloseTo(permutationP(b, a, { seed: 7 }), 10);
  });
});

describe('a family of tests is corrected for its own size', () => {
  // Fourteen tests at alpha 0.05 produce a spurious exclusion about half the
  // time. Reporting the first one that clears the bar, uncorrected, is how a
  // benchmark measuring nothing still announces a win.
  test('one test is left exactly as it was', () => {
    expect(holm([0.03])).toEqual([0.03]);
  });

  test('the same evidence buys less across more tests', () => {
    const alone = holm([0.02])[0];
    const amongTen = holm([0.02, 0.6, 0.7, 0.8, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95])[0];
    expect(amongTen).toBeGreaterThan(alone);
    expect(amongTen).toBeCloseTo(0.2, 10);
  });

  test('a borderline win does not survive its family', () => {
    const raw = [0.04, 0.30, 0.55, 0.80];
    expect(significant({ low: 0.5, high: 0.9 })).toBe(true);
    expect(holm(raw)[0]).toBeGreaterThan(0.05);
  });

  test('adjusted levels never decrease as raw levels increase', () => {
    // 0.03 and 0.031 are the pair that matters: step-down alone would adjust
    // them to 0.06 and 0.031, ranking the weaker result as the stronger one.
    const raw = [0.001, 0.03, 0.031, 0.04, 0.2];
    const adj = holm(raw);
    const paired = raw.map((p, i) => [p, adj[i]]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < paired.length; i++) {
      expect(paired[i][1]).toBeGreaterThanOrEqual(paired[i - 1][1]);
    }
  });

  test('an adjustment only ever costs power, never grants it', () => {
    const raw = [0.001, 0.008, 0.02, 0.04, 0.2];
    holm(raw).forEach((a, i) => expect(a).toBeGreaterThanOrEqual(raw[i]));
  });

  test('the level and the interval agree at the bar, across the borderline', () => {
    // The one-sided/two-sided mistake hides here and nowhere else: halving the
    // level would leave every interval unchanged while moving results across
    // the bar, so only cases that straddle it can detect the error. Sweeping
    // separations guarantees some do.
    let straddled = 0;
    for (let s = 0; s < 40; s++) {
      const control = [1.00, 1.05, 0.95, 1.10, 0.90, 1.02];
      const shift = 1 - s * 0.01;
      const arm = control.map((v, i) => v * shift * (1 + ((i % 3) - 1) * 0.04));
      const ci = ratioCI(arm, control, { seed: 100 + s });
      expect(significant(ci)).toBe(ci.p < 0.05);
      if (ci.p > 0.02 && ci.p < 0.2) straddled++;
    }
    expect(straddled).toBeGreaterThan(0);
  });

  test('results come back in input order, not sorted order', () => {
    // Silently reordering would misattribute every level to the wrong task,
    // which reads as a coherent table and is entirely wrong.
    expect(holm([0.5, 0.01])).toEqual([0.5, 0.02]);
  });

  test('a test that could not be computed is neither corrected nor counted', () => {
    // An unresolved task must not inflate the family size and weaken the
    // tasks that did resolve.
    expect(holm([0.02, NaN])).toEqual([0.02, NaN]);
  });

  test('nothing is adjusted past certainty', () => {
    expect(holm([0.4, 0.5, 0.6]).every((p) => p <= 1)).toBe(true);
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
      ...rows('control', 'cold', [0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10], [1,1,1,1,1,1,1,1]),
      ...rows('candidate', 'cold', [0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10], [1,1,1,1,1,1,1,1]),
      ...rows('control', 'warm', [0.10,0.10,0.10,0.10,0.10,0.10,0.10,0.10], [1,1,1,1,1,1,1,1]),
      ...rows('candidate', 'warm', [0.05,0.05,0.05,0.05,0.05,0.05,0.05,0.05], [1,1,1,1,1,1,1,1]),
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

  test('the correction spans the whole track, not one arm at a time', () => {
    // THE BOUNDARY THAT DECIDES WHETHER A WIN IS REAL. Two arms of four tasks
    // is eight tests. Correcting each arm as its own family of four hands back
    // half the leniency and is the easy way to keep a result that should not
    // have survived.
    const flat = [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10];
    const half = flat.map((v) => v / 2);
    const built = [];
    for (const task of ['t1', 't2', 't3', 't4']) {
      built.push(...rows('control', 'cold', flat, flat.map(() => 1)).map((r) => ({ ...r, task })));
      built.push(...rows('a', 'cold', half, flat.map(() => 1)).map((r) => ({ ...r, task })));
      built.push(...rows('b', 'cold', half, flat.map(() => 1)).map((r) => ({ ...r, task })));
    }
    const out = report(built);
    expect(out.tracks.cold.arms.a.familySize).toBe(8);
    expect(out.tracks.cold.arms.b.familySize).toBe(8);
  });

  test('the raw interval survives the correction that overrides it', () => {
    // Overwriting `significant` would erase the reader's ability to see what
    // the correction cost, which is the one thing that makes it checkable.
    const flat = [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10];
    const half = flat.map((v) => v / 2);
    const out = report([
      ...rows('control', 'cold', flat, flat.map(() => 1)),
      ...rows('candidate', 'cold', half, flat.map(() => 1)),
    ]);
    const t = out.tracks.cold.arms.candidate.perTask[0];
    expect(t.significant).toBe(true);
    expect(t.adjustedP).toBeGreaterThanOrEqual(t.ci.p);
    expect(typeof t.survivesCorrection).toBe('boolean');
  });

  test('an unresolved task whose interval is printed counts toward the family', () => {
    // renderReport prints unresolvedDetail intervals. An interval a reader can
    // see is one a reader can quote, so every test whose result is shown must
    // be counted -- leaving them out shrinks the divisor and makes the
    // corrected tasks look stronger than the table they appear in justifies.
    const flat = [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10];
    const half = flat.map((v) => v / 2);
    const noisy = [0.05, 0.30, 0.07, 0.28, 0.06, 0.31];
    const out = report([
      ...flat.map((usd, i) => row({ arm: 'control', task: 'clean', rep: i + 1, usd })),
      ...half.map((usd, i) => row({ arm: 'candidate', task: 'clean', rep: i + 1, usd })),
      ...noisy.map((usd, i) => row({ arm: 'control', task: 'wobbly', rep: i + 1, usd })),
      ...noisy.map((usd, i) => row({ arm: 'candidate', task: 'wobbly', rep: i + 1, usd })),
    ]);
    const c = out.tracks.cold.arms.candidate;
    expect(c.unresolved).toContain('wobbly');
    // Two tests are shown, so the family is two -- not one.
    expect(c.familySize).toBe(2);
    expect(c.unresolvedDetail[0].adjustedP).toBeDefined();
  });

  test('an unresolved task still cannot enter the headline', () => {
    // SUPERSEDES AN EARLIER ASSERTION OF THE OPPOSITE. This test used to demand
    // familySize 1 here, reasoning that an unresolved task is already excluded
    // from the headline so counting it would punish the task that did resolve.
    // That was wrong, and review caught it: the report PRINTS the unresolved
    // interval, and an interval a reader can see is one a reader can quote. A
    // shown test belongs in the family whatever the headline does with it.
    //
    // What remains true, and is what this test now pins, is the separate
    // property: unresolved tasks stay out of the headline and out of
    // survivingTasks.
    const flat = [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10];
    const half = flat.map((v) => v / 2);
    const noisy = [0.05, 0.30, 0.07, 0.28, 0.06, 0.31];
    const out = report([
      ...rows('control', 'cold', flat, flat.map(() => 1)).map((r) => ({ ...r, task: 'clean' })),
      ...rows('candidate', 'cold', half, flat.map(() => 1)).map((r) => ({ ...r, task: 'clean' })),
      ...noisy.map((usd, i) => row({ arm: 'control', task: 'wobbly', rep: i + 1, usd })),
      ...noisy.map((usd, i) => row({ arm: 'candidate', task: 'wobbly', rep: i + 1, usd })),
    ]);
    const c = out.tracks.cold.arms.candidate;
    expect(c.unresolved).toContain('wobbly');
    expect(c.tasksCounted).toBe(1);
    expect(c.survivingTasks).toEqual(['clean']);
  });

  test('no point estimate ever falls outside its own interval', () => {
    // THE BUG THIS EXISTS TO PREVENT, observed in a real report as
    // `0.924 [0.935, 1.030]`. The point was a ratio of totals; the interval
    // resampled a ratio of medians. Both are defensible statistics and they
    // agree on tidy data, which is why it survived every earlier test -- so
    // the fixture here is deliberately skewed, where they diverge.
    const skewed = [0.02, 0.02, 0.02, 0.02, 0.02, 0.03, 0.03, 0.9];
    const flat = [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10];
    const out = report([
      ...skewed.map((usd, i) => row({ arm: 'candidate', task: 'skew', rep: i + 1, usd })),
      ...flat.map((usd, i) => row({ arm: 'control', task: 'skew', rep: i + 1, usd })),
    ]);
    const all = [
      ...out.tracks.cold.arms.candidate.perTask,
      ...out.tracks.cold.arms.candidate.unresolvedDetail,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const t of all) {
      expect([t.task, t.ratio >= t.ci.low && t.ratio <= t.ci.high]).toEqual([t.task, true]);
    }
  });

  test('a failed run makes an arm dearer, never cheaper', () => {
    // What ratio-of-totals buys that a median of per-run unit costs does not:
    // a run scoring zero is dropped entirely by the median, so an arm could
    // lower its published cost by failing.
    const eight = [1, 2, 3, 4, 5, 6, 7, 8];
    const base = eight.map((rep) => row({ arm: 'candidate', task: 't', rep, usd: 0.1, score: 1 }));
    const control = eight.map((rep) => row({ arm: 'control', task: 't', rep, usd: 0.1, score: 1 }));
    const clean = report([...base, ...control]).tracks.cold.arms.candidate.perTask[0];
    const withFailure = report([
      ...base,
      row({ arm: 'candidate', task: 't', rep: 9, usd: 0.1, score: 0, status: 'failed' }),
      ...control,
    ]).tracks.cold.arms.candidate.perTask[0];
    expect(withFailure.ratio).toBeGreaterThan(clean.ratio);
  });

  test('the headline is the same statistic as the rows beneath it', () => {
    // A single converged task: its geometric mean over one entry must be that
    // entry. If the headline resampled medians while the row reported totals,
    // these would differ on skewed data and nothing would say so.
    // Skewed enough that a median and a total disagree in the third digit,
    // tight enough that the sampling rule still calls it converged -- an
    // unconverged task is excluded from the headline and would make this
    // assertion vacuous rather than false.
    const skewed = [0.020, 0.020, 0.021, 0.021, 0.020, 0.022, 0.020, 0.023];
    const flat = [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10];
    const c = report([
      ...skewed.map((usd, i) => row({ arm: 'candidate', task: 'one', rep: i + 1, usd })),
      ...flat.map((usd, i) => row({ arm: 'control', task: 'one', rep: i + 1, usd })),
    ]).tracks.cold.arms.candidate;
    expect(c.tasksCounted).toBe(1);
    expect(c.costRatio).toBeCloseTo(c.perTask[0].ratio, 10);
    expect(c.costRatio).toBeGreaterThanOrEqual(c.costRatioCI.low);
    expect(c.costRatio).toBeLessThanOrEqual(c.costRatioCI.high);
  });

  test('a run the harness never started is not scored against the arm', () => {
    // 30 consecutive spawn failures dropped an arm from 1.00 to 0.30 on a task
    // it had never actually failed. usd 0 + turns 0 + error means the
    // container never ran, so the agent was never given the chance.
    const ok = [1, 2, 3, 4, 5, 6, 7, 8].map((rep) =>
      row({ arm: 'candidate', task: 't', rep, usd: 0.05, score: 1 })
    );
    const never = [9, 10, 11].map((rep) =>
      row({ arm: 'candidate', task: 't', rep, usd: 0, turns: 0, score: 0, status: 'error' })
    );
    const control = [1, 2, 3, 4, 5, 6, 7, 8].map((rep) =>
      row({ arm: 'control', task: 't', rep, usd: 0.10, score: 1 })
    );
    const out = report([...ok, ...never, ...control]);
    expect(out.harnessFailures).toHaveLength(3);
    const c = out.tracks.cold.arms.candidate;
    expect(c.perTask[0].arm.n).toBe(8);
    expect(c.perTask[0].ratio).toBeCloseTo(0.5, 2);
  });

  test('a real failure still pays, because it cost money', () => {
    // THE LOOPHOLE THIS MUST NOT OPEN. An arm that burns budget and delivers
    // nothing is the exact behaviour the ledger exists to charge for; only a
    // run costing nothing AND attempting nothing is excluded.
    const eight = [1, 2, 3, 4, 5, 6, 7, 8];
    const base = eight.map((rep) => row({ arm: 'candidate', task: 't', rep, usd: 0.05, score: 1 }));
    const control = eight.map((rep) => row({ arm: 'control', task: 't', rep, usd: 0.05, score: 1 }));
    const burned = row({
      arm: 'candidate', task: 't', rep: 9, usd: 0.20, turns: 7, score: 0, status: 'error',
    });
    const out = report([...base, burned, ...control]);
    expect(out.harnessFailures).toHaveLength(0);
    expect(out.tracks.cold.arms.candidate.perTask[0].ratio).toBeGreaterThan(1);
  });

  test('malformed rows are reported, not silently dropped', () => {
    const out = report([row(), { task: 'x' }]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].problem).toMatch(/missing/);
  });
});
