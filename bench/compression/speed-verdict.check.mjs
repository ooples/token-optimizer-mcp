/**
 * THE SPEED CRITERION, CHECKED ON READINGS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The criterion decided real verdicts for a long time without ever being fed a
 * reading with a known answer, and it was wrong: three identical runs of the
 * harness, with no code change between them, reported 2 regressions, then 0,
 * then 1. Every case here is synthetic. Nothing is timed, so nothing depends on
 * what the machine was doing.
 *
 * The three that carry the weight:
 *
 *  - `a burst in one pass of three is not a regression` -- the defect itself.
 *  - `code that is genuinely slower loses in every pass, so the median catches
 *    it` -- the property that keeps the fix strict rather than merely quiet. A
 *    statistic that is blind to the noise is worth nothing if it is also blind
 *    to the signal.
 *  - `one pass cannot decide, and undecided is never a pass` -- the third state.
 */

import { quantile, speedVerdict } from './speed-verdict.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok  ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

/** `n` readings all of `ms`, so a pass's p90 is exactly `ms`. */
const flat = (ms, n = 31) => Array.from({ length: n }, () => ms);
/**
 * A pass that is clean but for `k` slow readings.
 *
 * At 31 readings the 90th percentile by nearest rank is the 28th, so the top
 * THREE sit outside it and one spike is deliberately discarded -- that is the
 * criterion's stated tolerance, not an oversight. Instability has to reach a
 * tenth of the readings before it reaches the statistic that judges it.
 */
const withSpikes = (ms, spike, k, n = 31) => [
  ...Array.from({ length: n - k }, () => ms),
  ...Array.from({ length: k }, () => spike),
];

const theirs = flat(100);
const verdict = (ourPasses, theirSamples = theirs) =>
  speedVerdict({
    ourSamples: ourPasses.flat(),
    ourPasses,
    theirSamples,
    ms: quantile(ourPasses.flat(), 0.5),
    theirMs: quantile(theirSamples, 0.5),
  });

// ---------------------------------------------------------------------------
// 1. The bar itself, on readings with no jitter at all.
// ---------------------------------------------------------------------------

check(
  verdict([flat(50), flat(50), flat(50)]).pass === true,
  'an arm that is faster in every pass wins',
  '50ms against 100ms'
);

check(
  verdict([flat(150), flat(150), flat(150)]).pass === false,
  'an arm that is slower in every pass loses',
  '150ms against 100ms'
);

{
  // The bar is `<=`, so the exact tie is a win. This is the only place the
  // direction of the comparison is pinned down, and a flipped inequality would
  // otherwise pass every other case here.
  check(verdict([flat(100), flat(100), flat(100)]).pass === true, 'a dead tie is a win, not a loss');
}

{
  // Their p10, not their median: an arm that beats their typical reading but
  // not their fast one still loses.
  const spiky = [...flat(80, 4), ...flat(200, 27)];
  const v = verdict([flat(100), flat(100), flat(100)], spiky);
  check(v.pass === false, 'their fast decile is the bar, not their median', v.detail);
}

// ---------------------------------------------------------------------------
// 2. Interference, which is the whole reason the passes exist.
// ---------------------------------------------------------------------------

{
  // THE DEFECT. A burst hits one pass of three and inflates it well past the
  // bar; the other two are clean and comfortably under it. The old criterion
  // pooled every reading and called this a regression.
  const v = verdict([flat(50), flat(160), flat(50)]);
  check(v.pass === true, 'a burst in one pass of three is not a regression', v.detail);
}

{
  // The same readings, pooled the way the criterion used to pool them. This
  // case exists to show the fix is load-bearing: if it ever starts agreeing
  // with the new one, the passes have stopped being kept apart.
  const pooled = [...flat(50), ...flat(160), ...flat(50)];
  check(
    quantile(pooled, 0.9) > 100 && quantile([50, 160, 50], 0.5) <= 100,
    'the same readings pooled would have failed, which is the bug being fixed',
    `pooled p90 ${quantile(pooled, 0.9)}ms vs median of passes ${quantile([50, 160, 50], 0.5)}ms`
  );
}

{
  // THE OTHER DIRECTION, and the one that keeps this strict. Code that is
  // genuinely slower is slower in every pass, so the median rises with them.
  // Interference can only ADD time, never remove it, so it can never turn a
  // real regression into a minority of slow passes.
  const v = verdict([flat(150), flat(150), flat(155)]);
  check(v.pass === false, 'code that is genuinely slower loses in every pass', v.detail);
}

{
  // Two contaminated passes out of three: the median is contaminated too and
  // the verdict is a loss. That is the safe direction -- the criterion gives
  // up the win it cannot demonstrate rather than keeping it on one clean pass.
  const v = verdict([flat(50), flat(160), flat(160)]);
  check(v.pass === false, 'a majority of contaminated passes is not rescued by one clean one', v.detail);
}

{
  // And the best pass is NOT what is taken, which is the rule this could most
  // easily have been mistaken for. One lucky pass under the bar decides
  // nothing.
  const v = verdict([flat(50), flat(150), flat(150)]);
  check(v.pass === false, 'one lucky pass does not carry the claim', v.detail);
}

{
  // JITTER INSIDE A PASS STILL COUNTS AGAINST US, because p90 is taken within
  // the pass before the median is taken across passes. An arm whose typical
  // reading is fast but whose top decile is over the bar loses, in every pass.
  const unstable = () => withSpikes(50, 300, 5);
  const v = verdict([unstable(), unstable(), unstable()]);
  check(
    v.pass === false,
    'an arm unstable in its own top decile loses, every pass',
    v.detail
  );
}

{
  // And the stated tolerance, pinned so it cannot drift: three slow readings
  // in a pass of 31 stay outside p90, a fourth does not. This is the jitter
  // allowance, and it comes from the rank rather than from a tuned constant.
  const three = () => withSpikes(50, 300, 3);
  const four = () => withSpikes(50, 300, 4);
  check(
    verdict([three(), three(), three()]).pass === true &&
      verdict([four(), four(), four()]).pass === false,
    'three slow readings of 31 are tolerated, four are not',
    'the tolerance is the nearest-rank p90 of 31, not a chosen allowance'
  );
}

// ---------------------------------------------------------------------------
// 3. The third state -- what the criterion says when it cannot say.
// ---------------------------------------------------------------------------

{
  const v = speedVerdict({
    ourSamples: flat(50),
    ourPasses: [flat(50)],
    theirSamples: theirs,
    ms: 50,
    theirMs: 100,
  });
  check(
    v.pass === null,
    'one pass cannot decide, and undecided is never a pass',
    'even though 50ms beats 100ms on the single pass there is'
  );
}

{
  // Unmeasured on their side is the state this file already had, and it has to
  // survive: a missing opponent is not a walkover.
  const v = speedVerdict({
    ourSamples: flat(1),
    ourPasses: [flat(1), flat(1), flat(1)],
    theirSamples: null,
    ms: 1,
    theirMs: null,
  });
  check(v.pass === null, 'an unmeasured opponent is not a win', v.detail);
}

{
  // A capture from before the samples were recorded carries two medians and
  // nothing else. The strict question cannot be asked of it.
  const v = speedVerdict({
    ourSamples: undefined,
    ourPasses: undefined,
    theirSamples: undefined,
    ms: 1,
    theirMs: 1000,
  });
  check(v.pass === null, 'a capture with no samples cannot answer the strict question', v.detail);
}

{
  // The detail is what a human reads when the gate goes red, so every pass has
  // to be in it -- a verdict that hid the disagreement would be the same
  // failure as reporting a saturated fit's zero residual.
  const v = verdict([flat(50), flat(160), flat(50)]);
  check(
    v.detail.includes('50.0') && v.detail.includes('160.0'),
    'the detail shows every pass, including the one the median discarded',
    v.detail
  );
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
