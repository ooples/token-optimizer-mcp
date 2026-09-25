/**
 * THE SPEED CRITERION, AS A FUNCTION, SO THAT IT CAN BE TESTED ON READINGS
 * WHOSE RIGHT ANSWER IS KNOWN.
 *
 * This lived inline in `must-win.check.mjs`, where the only way to exercise it
 * was to run the whole harness and hope the machine misbehaved in the useful
 * way. It decided real verdicts and had never once been fed a reading with a
 * known answer -- and it was wrong: across three identical runs with no code
 * change it reported 2, then 0, then 1 regressions. `speed-verdict.check.mjs`
 * is the test it should have had.
 *
 * The verdict has three states and the third one matters. `true` and `false`
 * are claims about the code. `null` is a claim about the measurement -- this
 * run could not tell -- and the gate must never round it to either of the
 * others, least of all to a pass.
 */

/** The q-quantile by nearest rank. */
export function quantile(xs, q) {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)));
  return sorted[at];
}

/**
 * @param {object} r
 * @param {number[]|undefined} r.ourSamples every reading of our arm, pooled
 * @param {number[][]|undefined} r.ourPasses those readings kept per pass
 * @param {number[]|undefined} r.theirSamples every reading of their arm
 * @param {number|null} r.ms our published median
 * @param {number|null} r.theirMs their published median, null when unmeasured
 * @returns {{pass: boolean|null, detail: string}}
 */
export function speedVerdict({ ourSamples, ourPasses, theirSamples, ms, theirMs }) {
// OUR SLOW READINGS AGAINST THEIR FAST ONES, and nothing softer. Both arms
// are timed 31 times in one process, and the recorded samples show why a
// median-against-median test would not be enough: the first reading pays for
// the JIT (ours runs 2.2x the median on `codebase-exploration`), and beyond
// that both arms take sporadic spikes from whatever else the machine is doing
// -- theirs hit 220ms against a 45ms median on `grep-output`, ours 193ms
// against 52ms on `repeated-reads`. Comparing medians would hand us rows we
// win only when the machine is quiet.
//
// So: our 90th percentile must beat their 10th. It is the same distance from
// each median, taken in opposite directions, which makes it symmetric rather
// than merely conservative; it discards one spike per arm and no more, so a
// run where OUR timings are unstable does not get to claim the win; and it
// introduces no tuned constant -- there is no jitter allowance to argue about,
// because the spread of the readings is doing that job directly.
//
// WORST-AGAINST-BEST WAS REJECTED. `max(ours) <= min(theirs)` needs no
// percentile at all, but it lets one interference spike on either arm decide a
// criterion, and the recorded samples carry several that have nothing to do
// with either compressor.
if (theirMs === null) {
  return { pass: null, detail: `ours ${ms}ms, theirs unmeasured` };
} else if (!Array.isArray(ourSamples) || !Array.isArray(theirSamples)) {
  // A capture from before the samples were recorded cannot answer the strict
  // question, and the weaker one it can answer is not this criterion.
  return {
    pass: null,
    detail: `${ms}ms vs ${theirMs}ms - single readings, spread not recorded`,
  };
} else if (!Array.isArray(ourPasses) || ourPasses.length < 2) {
  // ONE PASS CANNOT ANSWER THIS. Five independent regenerations of the record
  // put the between-run spread of our p90 at 34.05ms and 28.10ms on the two
  // workloads whose verdict kept flipping, against a within-run bootstrap of
  // 6.91ms and 13.39ms for the same estimate. A single pass is therefore
  // consistent with verdicts on both sides of the bar, and calling it either
  // way is a coin toss wearing a percentile.
  const ourSlow = quantile(ourSamples, 0.9);
  const theirFast = quantile(theirSamples, 0.1);
  return {
    pass: null,
    detail:
      `our p90 ${ourSlow.toFixed(1)}ms vs their p10 ${theirFast.toFixed(1)}ms ` +
      `- one pass only, which cannot separate a regression from interference`,
  };
} else {
  // THE BAR IS UNCHANGED -- our p90 against their p10 -- AND THE JITTER BAND
  // IS STILL INSIDE IT: p90 is taken WITHIN a pass, so every spike that
  // happened while a pass was running still counts against us. What the
  // median ACROSS passes removes is the other thing, the one that is not
  // ours.
  //
  // WHY THAT SECOND THING IS NOT OURS, MEASURED RATHER THAN ASSUMED. In a
  // recorded run, pass 3 was inflated on grep-output (1.75x its own best
  // pass), human-authored-json (1.48x), issue-triage (1.55x), raw-build-log
  // (1.57x) and relevance-probe (1.40x), while agent-loop, agent-loop-logs,
  // browser-session, repeated-reads and sre-debugging moved by 3% or less in
  // the same pass. The five that moved are positions 6 through 10 of the
  // fixed iteration order and the ones that did not are 1-5 and 11-12: a
  // contiguous block in wall-clock time, which is what an external burst
  // looks like and is not something a compressor can do to five workloads
  // and not their neighbours.
  //
  // A REAL REGRESSION SURVIVES THE MEDIAN, which is the property that keeps
  // this strict. Code that got slower is slower in every pass, so every
  // per-pass p90 rises and the median rises with them. Interference can only
  // ADD time, never remove it, so it can only push a minority of passes UP,
  // where the median discards them. The statistic is therefore blind to the
  // noise and not to the signal -- and taking the best pass instead would
  // have been blind to both, because one lucky pass would be enough.
  const theirFast = quantile(theirSamples, 0.1);
  const perPass = ourPasses.map((xs) => quantile(xs, 0.9));
  const ourSlow = quantile(perPass, 0.5);
  const shown = perPass.map((v) => v.toFixed(1)).join(' / ');
  return {
    pass: ourSlow <= theirFast,
    detail:
      `our p90 ${ourSlow.toFixed(1)}ms vs their p10 ${theirFast.toFixed(1)}ms ` +
      `(median of ${perPass.length} passes: ${shown}; medians ${ms} / ${theirMs})`,
  };
}
}
