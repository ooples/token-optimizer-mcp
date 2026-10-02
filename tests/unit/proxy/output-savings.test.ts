/**
 * What holds the three output tiers to their own evidence classes.
 *
 * WHY THE ARITHMETIC IS PINNED BY HAND. Every figure here is a difference of
 * means with a propagated interval, and the failure mode of that kind of code
 * is not a crash -- it is a plausible number. A variance term dropped, an
 * absolute value taken, a baseline averaged unweighted: each still produces a
 * percentage and a band, and each produces the wrong one silently. So the
 * expected values below are computed longhand in the comments, and the tests
 * check the numbers rather than the shape.
 *
 * THE PROPERTIES THAT MATTER MOST ARE THE REFUSALS. That a cost is reported as
 * a cost, that a band is null rather than zero-width when it cannot be
 * estimated, that the measured tier declines to speak when no holdout ran, and
 * that the arm this module reads is the one the shaper acted on -- those are
 * what separate a measurement from marketing, and none of them are visible in
 * a result that merely looks reasonable.
 */

import { describe, it, expect } from '@jest/globals';
import {
  OUTPUT_ARM,
  OUTPUT_EVIDENCE,
  accumMean,
  accumVariance,
  assignArm,
  baselineFor,
  echoRatio,
  emptyAccum,
  emptyOutputLedger,
  estimateFromBaseline,
  estimateFromHoldout,
  inputBucket,
  mergeAccum,
  mergeOutputLedger,
  modelFamily,
  observe,
  observedWaste,
  pooledVariance,
  recordBaseline,
  recordOutput,
  stratumKey,
  turnKind,
  type OutputSavingsLedger,
} from '../../../src/proxy/output-savings.js';
import { inHoldout } from '../../../src/proxy/output-shaper.js';

/** An accumulator over a list, which is how every fixture below is built. */
function accum(values: readonly number[]) {
  const built = emptyAccum();
  for (const value of values) observe(built, value);
  return built;
}

/** A ledger from three lists of per-stratum outputs. */
function ledger(spec: {
  baseline?: Record<string, readonly number[]>;
  treatment?: Record<string, readonly number[]>;
  control?: Record<string, readonly number[]>;
}): OutputSavingsLedger {
  const built = emptyOutputLedger();
  for (const [key, values] of Object.entries(spec.baseline ?? {}))
    for (const value of values) recordBaseline(built, key, value);
  for (const [key, values] of Object.entries(spec.treatment ?? {}))
    for (const value of values)
      recordOutput(built, OUTPUT_ARM.Treatment, key, value);
  for (const [key, values] of Object.entries(spec.control ?? {}))
    for (const value of values)
      recordOutput(built, OUTPUT_ARM.Control, key, value);
  return built;
}

describe('the spread an interval is computed from', () => {
  it('reports no variance from one observation rather than no spread', () => {
    // THE DEFECT THIS PINS. Returning 0 here is the difference between "we
    // cannot estimate the spread of this stratum" and "this stratum does not
    // vary", and the second collapses the 95% band to a point -- publishing
    // certainty about a stratum seen exactly once.
    expect(accumVariance(accum([420]))).toBeNull();
    // POSITIVE CONTROL: the same function does return a number once it can.
    expect(accumVariance(accum([100, 200]))).toBe(5000);
    expect(accumMean(accum([420]))).toBe(420);
  });

  it('never returns a negative variance for a stratum that barely varies', () => {
    // sumsq - sum^2/n subtracts two large nearly-equal sums, so the
    // computational form can land a hair below zero in binary floating point.
    const spread = accumVariance(accum([1e8, 1e8, 1e8, 1e8]));
    expect(spread).not.toBeNull();
    expect(spread).toBeGreaterThanOrEqual(0);
  });

  it('folds exactly, so a day merged into totals keeps its full weight', () => {
    const whole = accum([3, 5, 11, 17]);
    const left = accum([3, 5]);
    mergeAccum(left, accum([11, 17]));
    expect(left).toEqual(whole);
    expect(accumVariance(left)).toBe(accumVariance(whole));
  });

  it('pools by degrees of freedom and refuses when nothing can be pooled', () => {
    // Two strata: [100,200] has variance 5000 on 1 degree of freedom, and
    // [1,2,3] has variance 1 on 2, so the pool is (5000*1 + 1*2)/3 = 1667.33.
    // NOT THE PLAIN MEAN OF THE TWO VARIANCES, which would be 2500.5 -- the
    // weighting is what stops a stratum of two requests outvoting one of two
    // thousand.
    expect(pooledVariance([accum([100, 200]), accum([1, 2, 3])])).toBeCloseTo(
      5002 / 3,
      9
    );
    // Nothing with two observations means no pool at all -- not a pool of zero.
    expect(pooledVariance([accum([5]), accum([9])])).toBeNull();
  });
});

describe('the strata a comparison is made within', () => {
  it('buckets by request-time features only, never by the response', () => {
    expect(
      stratumKey({
        model: 'claude-opus-5',
        messageCount: 3,
        inputTokens: 10_000,
        hasTools: true,
      })
    ).toBe('opus|early|m|tools');
    expect(
      stratumKey({
        model: 'some-unknown-model',
        messageCount: 99,
        inputTokens: 500,
        hasTools: false,
      })
    ).toBe('other|long|xs|notools');
  });

  it('puts bucket edges where the comparison needs them', () => {
    expect(inputBucket(1_999)).toBe('xs');
    expect(inputBucket(2_000)).toBe('s');
    expect(inputBucket(127_999)).toBe('l');
    expect(inputBucket(128_000)).toBe('xl');
    expect(turnKind(1)).toBe('first');
    expect(turnKind(2)).toBe('early');
    expect(turnKind(33)).toBe('long');
    expect(modelFamily('gpt-5-mini')).toBe('gpt');
  });

  it('merges every matching stratum when it backs off, not the first found', () => {
    // THE DEFECT THIS PINS. A back-off that returned the first candidate found
    // while iterating a map would make the estimate depend on the order rows
    // arrived in, so the same ledger would answer differently on a replay.
    const forward = ledger({
      baseline: { 'opus|early|m|tools': [100, 100], 'opus|early|m|notools': [200, 200] },
    });
    const reversed = ledger({
      baseline: { 'opus|early|m|notools': [200, 200], 'opus|early|m|tools': [100, 100] },
    });
    const asked = 'opus|early|m|unknown';
    const a = baselineFor(forward.baseline, asked);
    const b = baselineFor(reversed.baseline, asked);
    expect(a).toEqual(b);
    expect(a?.n).toBe(4);
    expect(accumMean(a ?? emptyAccum())).toBe(150);
  });

  it('returns nothing when no stratum matches at any depth', () => {
    const only = ledger({ baseline: { 'opus|early|m|tools': [100] } });
    expect(baselineFor(only.baseline, 'gemini|long|xl|notools')).toBeNull();
    // POSITIVE CONTROL: the same map does answer for a key it holds.
    expect(baselineFor(only.baseline, 'opus|early|m|tools')?.n).toBe(1);
  });
});

describe('tier 1: the estimate against rows nobody chose to leave alone', () => {
  it('propagates the baseline error into the band, not just our own spread', () => {
    // Treated [100, 200]: n=2, mean 150, var 5000.
    // Baseline [300, 500]: m=2, mean 400, var 20000.
    //   tokens         = 2 * (400 - 150)            = 500
    //   baselineTokens = 2 * 400                    = 800  -> 62.5%
    //   variance       = 2*5000 + (2^2)*20000/2     = 50000
    //   error          = 1.96 * sqrt(50000)         = 438.26932...
    const estimate = estimateFromBaseline(
      ledger({ treatment: { k: [100, 200] }, baseline: { k: [300, 500] } })
    );
    expect(estimate.evidence).toBe(OUTPUT_EVIDENCE.Estimated);
    expect(estimate.tokens).toBe(500);
    expect(estimate.baselineTokens).toBe(800);
    expect(estimate.percent).toBe(62.5);
    expect(estimate.requests).toBe(2);
    expect(estimate.strata).toBe(1);
    expect(estimate.pooledRequests).toBe(0);
    // THE SECOND VARIANCE TERM IS WHAT THIS CHECKS. Dropping it leaves
    // 1.96*sqrt(10000) = 196, a band of +/-24.5 points instead of +/-54.8 --
    // a baseline built from two requests reported as confidently as one built
    // from two thousand.
    expect(estimate.interval?.lowPercent).toBeCloseTo(7.716336, 5);
    expect(estimate.interval?.highPercent).toBeCloseTo(117.283664, 5);
  });

  it('reports output we CAUSED as a cost, never clamped up to zero', () => {
    // Treated [480, 520] mean 500 against baseline [280, 320] mean 300:
    // compression made the model write 200 more tokens per request, twice.
    const estimate = estimateFromBaseline(
      ledger({ treatment: { k: [480, 520] }, baseline: { k: [280, 320] } })
    );
    expect(estimate.tokens).toBe(-400);
    expect(estimate.percent).toBeCloseTo(-66.666667, 5);
    // POSITIVE CONTROL that the sign is read from the data and not fixed: the
    // same function on the mirrored fixture reports the saving.
    const mirrored = estimateFromBaseline(
      ledger({ treatment: { k: [280, 320] }, baseline: { k: [480, 520] } })
    );
    expect(mirrored.tokens).toBe(400);
  });

  it('borrows a pooled spread rather than claiming none, and says how often', () => {
    // Treated [100] cannot give a variance; the pooled spread across strata
    // (here, the baseline's 10000) stands in, and the one request that
    // borrowed it is disclosed.
    //   variance = 1*10000 + (1^2)*10000/3 = 13333.333...
    const estimate = estimateFromBaseline(
      ledger({ treatment: { k: [100] }, baseline: { k: [200, 300, 400] } })
    );
    expect(estimate.tokens).toBe(200);
    expect(estimate.pooledRequests).toBe(1);
    expect(estimate.interval).not.toBeNull();
    expect(estimate.interval?.lowPercent).toBeCloseTo(
      ((200 - 1.96 * Math.sqrt(40000 / 3)) / 300) * 100,
      9
    );
  });

  it('publishes no band at all when nothing anywhere can supply a spread', () => {
    // One treated and one baseline request: no stratum has two observations,
    // so the pool is empty too. The point estimate still stands; the band does
    // not, and a zero-width band here would read as certainty.
    const estimate = estimateFromBaseline(
      ledger({ treatment: { k: [100] }, baseline: { k: [200] } })
    );
    expect(estimate.interval).toBeNull();
    // POSITIVE CONTROLS: the figure itself was computed, and the reader is
    // told that every request in it leaned on a spread that did not exist.
    expect(estimate.tokens).toBe(100);
    expect(estimate.percent).toBe(50);
    expect(estimate.pooledRequests).toBe(1);
  });

  it('skips a treated stratum with no baseline at any depth', () => {
    const estimate = estimateFromBaseline(
      ledger({
        treatment: { 'opus|early|m|tools': [100], 'gpt|long|xl|notools': [900] },
        baseline: { 'opus|early|m|notools': [300, 300] },
      })
    );
    expect(estimate.strata).toBe(1);
    expect(estimate.requests).toBe(1);
    expect(estimate.tokens).toBe(200);
  });

  it('gives the same figure from a folded ledger as from the rows', () => {
    const whole = ledger({
      treatment: { a: [100, 200], b: [50, 70] },
      baseline: { a: [300, 500], b: [90, 110] },
    });
    const folded = ledger({ treatment: { a: [100] }, baseline: { a: [300] } });
    mergeOutputLedger(
      folded,
      ledger({
        treatment: { a: [200], b: [50, 70] },
        baseline: { a: [500], b: [90, 110] },
      })
    );
    expect(estimateFromBaseline(folded)).toEqual(estimateFromBaseline(whole));
  });
});

describe('tier 2: the only figure that earns the word measured', () => {
  it('says nothing when no holdout ran, rather than reporting no effect', () => {
    const none = estimateFromHoldout(
      ledger({ treatment: { k: [100, 200] }, baseline: { k: [300, 500] } })
    );
    expect(none).toBeNull();
    // POSITIVE CONTROL: the same rows plus a control arm do produce a figure,
    // so the null above is the absent experiment and not a broken estimator.
    const ran = estimateFromHoldout(
      ledger({ treatment: { k: [100, 200] }, control: { k: [300, 500] } })
    );
    expect(ran?.evidence).toBe(OUTPUT_EVIDENCE.Measured);
  });

  it('differences the two arms and carries both their standard errors', () => {
    // Treated [100, 200]: n=2, mean 150, var 5000.
    // Control [300, 500]: n=2, mean 400, var 20000.
    //   tokens   = 2 * (400 - 150)                  = 500   -> 62.5% of 800
    //   variance = (2^2) * (20000/2 + 5000/2)       = 50000
    const estimate = estimateFromHoldout(
      ledger({ treatment: { k: [100, 200] }, control: { k: [300, 500] } })
    );
    expect(estimate?.tokens).toBe(500);
    expect(estimate?.baselineTokens).toBe(800);
    expect(estimate?.percent).toBe(62.5);
    expect(estimate?.pooledRequests).toBe(0);
    expect(estimate?.interval?.lowPercent).toBeCloseTo(7.716336, 5);
  });

  it('refuses to fill a missing control arm from the observational baseline', () => {
    // THE SUBSTITUTION THIS FORBIDS. Stratum `b` has a rich baseline and no
    // control; reaching for it would relabel an observational comparison as a
    // measured one, which is the single worst thing this module could do.
    const estimate = estimateFromHoldout(
      ledger({
        treatment: { a: [100, 200], b: [100, 200] },
        control: { a: [300, 500] },
        baseline: { b: [300, 500, 400, 400] },
      })
    );
    expect(estimate?.strata).toBe(1);
    expect(estimate?.requests).toBe(2);
    expect(estimate?.tokens).toBe(500);
  });

  it('reads the arm the shaper acted on, never a second opinion about it', () => {
    // THE DEFECT THIS PINS. A separate hash here -- however uniform and stable
    // -- would label some shaped requests as controls and some unshaped ones
    // as treated, and the comparison would be between two arms that never
    // existed. So the assignment must agree with `inHoldout` on every key.
    let controls = 0;
    for (let index = 0; index < 400; index += 1) {
      const key = `conversation-${index}`;
      const arm = assignArm(key, 0.25);
      expect(arm === OUTPUT_ARM.Control).toBe(inHoldout(key, 0.25));
      if (arm === OUTPUT_ARM.Control) controls += 1;
    }
    // AND IT HAS TO ACTUALLY SPLIT: an assignment that agreed with `inHoldout`
    // by always answering "treatment" would pass the loop above and measure
    // nothing. A quarter of 400 is 100; the band is generous on purpose.
    expect(controls).toBeGreaterThan(60);
    expect(controls).toBeLessThan(145);
  });

  it('treats every request when no experiment is configured', () => {
    expect(assignArm('anything', 0)).toBe(OUTPUT_ARM.Treatment);
    expect(assignArm(undefined, 0.5)).toBe(OUTPUT_ARM.Treatment);
    // POSITIVE CONTROL: a full holdout does reach the other arm.
    expect(assignArm('anything', 1)).toBe(OUTPUT_ARM.Control);
  });

  it('keeps a conversation in one arm across its turns', () => {
    const first = assignArm('session-abc', 0.5);
    for (let turn = 0; turn < 20; turn += 1) {
      expect(assignArm('session-abc', 0.5)).toBe(first);
    }
  });
});

describe('tier 3: waste with no counterfactual in it at all', () => {
  it('reports the share of the reply that was already on screen', () => {
    // Three bigrams in the reply ("a b", "b c", "c d"); one of them is in the
    // context, so a third of the reply restated what it had been shown.
    expect(echoRatio('a b c d', 'a b z z', 2)).toBeCloseTo(1 / 3, 12);
    expect(echoRatio('a b c d', 'a b c d', 2)).toBe(1);
    expect(echoRatio('q r s t', 'a b c d', 2)).toBe(0);
  });

  it('reports zero rather than a ratio it cannot form', () => {
    // Fewer words than the window means no n-gram exists, and any figure
    // derived from zero of them would be invented.
    expect(echoRatio('three short words', 'three short words', 8)).toBe(0);
    expect(echoRatio('', 'anything at all here', 2)).toBe(0);
    expect(echoRatio('a b c d e f g h i', '', 2)).toBe(0);
    // POSITIVE CONTROL: the same text at a window it can fill reads as a full
    // echo, so the zeros above are the refusal and not a dead function.
    expect(echoRatio('three short words', 'three short words', 3)).toBe(1);
  });

  it('is insensitive to how the two sides were whitespaced', () => {
    expect(echoRatio('a  b\n c\td', 'a b c d', 2)).toBe(1);
  });
});

describe('the waste tier, averaged over the replies that were scanned', () => {
  const accum = (values: readonly number[]) => {
    const made = emptyAccum();
    for (const value of values) observe(made, value);
    return made;
  };

  it('reports the mean share and a band around it', () => {
    const waste = observedWaste(accum([0.2, 0.4]));
    expect(waste?.evidence).toBe(OUTPUT_EVIDENCE.ObservedWaste);
    expect(waste?.meanRatio).toBeCloseTo(0.3, 10);
    expect(waste?.requests).toBe(2);
    // Sample variance of [0.2, 0.4] is 0.02; the standard error of the mean is
    // sqrt(0.02/2) = 0.1, so the band is 0.3 +/- 1.96 * 0.1 -- clamped at 0.
    expect(waste?.interval?.lowRatio).toBeCloseTo(0.104, 3);
    expect(waste?.interval?.highRatio).toBeCloseTo(0.496, 3);
  });

  it('clamps the band to the unit interval it is a share of', () => {
    // A mean near 1 with real spread puts the normal-approximation upper bound
    // past 1, and a printed 112% would read as an arithmetic error rather than
    // as the approximation being coarse at the edge.
    const waste = observedWaste(accum([0.9, 1, 1, 1]));
    expect(waste?.interval?.highRatio).toBe(1);
    const low = observedWaste(accum([0, 0, 0, 0.1]));
    expect(low?.interval?.lowRatio).toBe(0);
    // POSITIVE CONTROL: an interior mean keeps both bounds strictly inside, so
    // the clamp is not simply pinning every band to 0 and 1.
    const middle = observedWaste(accum([0.4, 0.5, 0.6]));
    expect(middle?.interval?.lowRatio).toBeGreaterThan(0);
    expect(middle?.interval?.highRatio).toBeLessThan(1);
  });

  it('has no band at all from a single reply', () => {
    const waste = observedWaste(accum([0.42]));
    expect(waste?.meanRatio).toBe(0.42);
    expect(waste?.interval).toBeNull();
  });

  it('reports nothing when nothing was scanned', () => {
    expect(observedWaste(emptyAccum())).toBeNull();
    // POSITIVE CONTROL: a reply that echoed NOTHING is still a scanned reply,
    // and zero waste is a finding -- not the same as no figure.
    const none = observedWaste(accum([0, 0]));
    expect(none).not.toBeNull();
    expect(none?.meanRatio).toBe(0);
  });

  it('folds to the same figure a pruned day would have reported', () => {
    // TO DOUBLE PRECISION, NOT TO THE BIT. The fold is exact in arithmetic --
    // n, sum and sumsq are additive -- but float addition is not associative, so
    // summing 0.09 + 0.16 before adding it lands one ulp away from adding each
    // in turn. The invariant worth pinning is that a prune cannot move a
    // published figure, and one part in 1e15 cannot.
    const whole = observedWaste(accum([0.1, 0.2, 0.3, 0.4]));
    const first = accum([0.1, 0.2]);
    mergeAccum(first, accum([0.3, 0.4]));
    const folded = observedWaste(first);
    expect(folded?.requests).toBe(whole?.requests);
    expect(folded?.meanRatio).toBeCloseTo(whole?.meanRatio ?? -1, 12);
    expect(folded?.interval?.lowRatio).toBeCloseTo(
      whole?.interval?.lowRatio ?? -1,
      12
    );
    expect(folded?.interval?.highRatio).toBeCloseTo(
      whole?.interval?.highRatio ?? -1,
      12
    );
    // POSITIVE CONTROL: a sample that genuinely differs fails at this
    // precision, so the agreement above is not the tolerance swallowing it.
    const different = observedWaste(accum([0.1, 0.2, 0.3, 0.5]));
    expect(different?.meanRatio).not.toBeCloseTo(whole?.meanRatio ?? -1, 12);
  });
});
