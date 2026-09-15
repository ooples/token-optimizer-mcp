/**
 * The session-length prior, and why it is a dial rather than a measurement.
 *
 * Rewriting a cached prefix spends a 1.25x write now to buy 0.1x reads later,
 * so it repays only if enough turns follow. Turns REMAINING is unobservable, so
 * the threshold rests on a prior: `1.25 / 0.1 / assumedSessionTurns`.
 *
 * THE REJECTED ALTERNATIVE IS THE INTERESTING PART. Deriving the threshold from
 * turns-so-far looks strictly better -- it uses real evidence instead of a
 * guess -- and it is wrong, because the value then differs between two
 * consecutive turns of one conversation. A conversation near the boundary
 * declines the rewrite on one turn and accepts it on the next, and that flip
 * re-sends the whole prefix at 1.25x instead of re-reading it at 0.1x.
 * Measured: it broke `proof.mjs`'s STEADY gate on three of six workloads.
 *
 * So these tests pin the property that makes the dial safe -- the threshold
 * depends on configuration ONLY -- alongside the arithmetic.
 */

import { minRewriteShare } from '../../../src/compress/strategy.js';
import { DEFAULT_TUNING, resolveTuning } from '../../../src/compress/options.js';

describe('the threshold is the break-even share for the assumed length', () => {
  test('the default prior reproduces the 12.5% constant it replaced', () => {
    // 1.25 / 0.1 / 100. Pinned because changing it silently changes every
    // rewrite decision the proxy makes.
    expect(minRewriteShare(DEFAULT_TUNING)).toBeCloseTo(0.125, 10);
  });

  test('a short-session prior demands a reduction nothing achieves', () => {
    // 1.25 / 0.1 / 13 = 96%. That is the honest answer for a 13-turn workload:
    // do not rewrite the prefix at all. THOL's tasks run 6-27 turns and were
    // measured losing money on cache writes below about 13.
    const tuning = resolveTuning({ assumedSessionTurns: 13 });
    expect(minRewriteShare(tuning)).toBeCloseTo(0.9615, 3);
  });

  test('a long-session prior lets a small reduction pay', () => {
    // This project's own transcripts run 184-2,319 turns, where a 1.25% rewrite
    // repays comfortably.
    const tuning = resolveTuning({ assumedSessionTurns: 1000 });
    expect(minRewriteShare(tuning)).toBeCloseTo(0.0125, 10);
  });

  test('the share falls as the assumed length rises, without exception', () => {
    const shares = [10, 50, 100, 500, 2000].map((turns) =>
      minRewriteShare(resolveTuning({ assumedSessionTurns: turns }))
    );
    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i]).toBeLessThan(shares[i - 1]);
    }
  });
});

describe('the threshold cannot move under a conversation', () => {
  test('it is a function of tuning alone, so two turns agree', () => {
    // THE SAFETY PROPERTY, asserted directly. `minRewriteShare` takes no
    // request, no message count and no turn index -- there is nothing a growing
    // conversation could change. Called repeatedly with the same tuning it must
    // return the identical value, which is what keeps turn N's decision equal
    // to turn N+1's and therefore keeps the cached prefix intact.
    const tuning = resolveTuning({ assumedSessionTurns: 40 });
    const first = minRewriteShare(tuning);
    for (let turn = 0; turn < 50; turn += 1) {
      expect(minRewriteShare(tuning)).toBe(first);
    }
  });

  test('two separately resolved tunings with the same prior agree', () => {
    // A proxy resolves tuning once, but a caller may resolve twice; the
    // threshold must not depend on which object it was handed.
    expect(minRewriteShare(resolveTuning({ assumedSessionTurns: 250 }))).toBe(
      minRewriteShare(resolveTuning({ assumedSessionTurns: 250 }))
    );
  });
});

describe('a nonsensical prior falls back rather than disabling the guard', () => {
  test('zero, negative and non-finite all yield the default share', () => {
    // A prior of zero would make the share infinite and forbid every rewrite;
    // a negative one would make it negative and permit every rewrite,
    // including ones that cannot repay. Neither is a safe reading of "the
    // operator typed something wrong", so both fall back to the measured
    // default.
    for (const turns of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tuning = { ...DEFAULT_TUNING, assumedSessionTurns: turns };
      expect(minRewriteShare(tuning)).toBeCloseTo(0.125, 10);
    }
  });

  test('an absent tuning yields the default share', () => {
    expect(minRewriteShare(undefined)).toBeCloseTo(0.125, 10);
  });
});
