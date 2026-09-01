/**
 * Deciding when a measurement is finished, instead of guessing a rep count.
 *
 * THE DEFECT THIS REPLACES. A fixed n=3 produced this, measured:
 *
 *   log-needle-zh, per-run USD
 *     control  [0.1441, 0.1104, 0.1091, 0.1203, 0.1107]   cv 12%
 *     arm A    [0.1129, 0.1112, 0.2727]                   cv 56%
 *     arm B    [0.1235, 0.1151, 0.1114]                   cv  5%
 *
 * One run at 2.4x its siblings moved the campaign's headline from -3.2% to
 * -10.6%. Three samples cannot tell that apart from a real effect, and a mean
 * over them is not an estimate, it is an anecdote with a decimal point.
 *
 * WHY BOOTSTRAP AND NOT A t-INTERVAL. A t-interval assumes roughly normal data.
 * These are not: `code-debug-pipeline-py` is openly BIMODAL -- about 21 turns
 * and $0.24, or about 24 turns and $0.35, depending on which path the agent
 * takes -- and a t-interval straddling two modes reports a tight interval
 * around a value the task never actually produces. A percentile bootstrap makes
 * no shape assumption, so on a bimodal sample it correctly reports a WIDE
 * interval, which is what stops us claiming a result we do not have.
 *
 * SEEDED, so a published number can be recomputed exactly from the raw rows.
 * An unseeded bootstrap gives a slightly different interval every time it is
 * run, which is indefensible in something meant to be checked by other people.
 */

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Deliberately not Math.random: the whole credibility argument for this harness
 * is that anyone can recompute our published intervals from our published rows
 * and get the same digits.
 */
export function rng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The median of a sample. Used rather than the mean throughout: see below. */
export function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Percentile bootstrap interval for the MEDIAN.
 *
 * THE MEDIAN, NOT THE MEAN, and this is the load-bearing choice. A single
 * outlier run -- an agent that wandered, a flaky network retry -- moves a mean
 * of three by a third and moves the median by nothing. We are trying to
 * estimate what this task USUALLY costs an entrant, and the mean of a heavy
 * right tail is not that number.
 *
 * The total spend is still reported separately and still charges every run,
 * outliers included: an entrant that occasionally burns $0.27 genuinely spent
 * it, and the ledger says so. What the median protects is the per-task RATIO,
 * which is what the ranking multiplies together.
 */
export function bootstrapMedianCI(values, { resamples = 2000, alpha = 0.05, seed } = {}) {
  const n = values.length;
  if (n === 0) return { low: NaN, high: NaN, median: NaN, n: 0 };
  if (n === 1) return { low: values[0], high: values[0], median: values[0], n: 1 };

  const next = rng(seed ?? 0x9e3779b9);
  const medians = new Array(resamples);
  const draw = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) draw[i] = values[(next() * n) | 0];
    medians[r] = median(draw);
  }
  medians.sort((a, b) => a - b);
  const lo = Math.floor((alpha / 2) * resamples);
  const hi = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1);
  return { low: medians[lo], high: medians[hi], median: median(values), n };
}

/** Interval width as a fraction of the estimate -- the thing we drive down. */
export function widthRatio(ci) {
  if (!Number.isFinite(ci.median) || ci.median === 0) return Infinity;
  return (ci.high - ci.low) / Math.abs(ci.median);
}

/** Default stopping rule. Tuned to the observed spread, not to a round number. */
export const DEFAULT_PRECISION = {
  // A 10% interval is narrow enough to call a 10% effect, which is the size of
  // claim this benchmark exists to adjudicate.
  targetWidthRatio: 0.10,
  // SIX, NOT THREE, AND THIS IS A CORRECTNESS FLOOR RATHER THAN A PREFERENCE.
  //
  // A percentile bootstrap of the median resamples WITH REPLACEMENT, so with
  // three observations every resampled median is one of those same three
  // values and the interval can never be wider than [min, max] of the sample.
  // Three draws that happen to land close therefore report a 2-4% interval and
  // a "converged" verdict on no evidence whatever:
  //
  //   [0.100, 0.102, 0.104] -> CI [0.100, 0.104], width 4%, CONVERGED
  //   [0.100, 0.101, 0.099] -> CI [0.099, 0.101], width 2%, CONVERGED
  //
  // That is not a tight estimate, it is three samples agreeing by chance. It
  // produced two "significant" results in a real campaign -- flooded-symbol at
  // 0.879 [0.789, 0.988] and pure-generation at 0.660 [0.549, 0.945], both at
  // n=3 -- which should never have been published as intervals.
  //
  // Six is cheap given the measured cost of precision here: a clean task needs
  // roughly eight reps to reach the 10% target anyway, so this floor rarely
  // binds on anything that was going to converge honestly.
  minReps: 6,
  // The cap is a SPEND control, and it is the reason UNRESOLVED exists: some
  // tasks will not converge at any affordable n, and the honest report says so
  // rather than quietly averaging them in.
  maxReps: 12,
};

/**
 * Should this task get another rep?
 *
 * Returns a verdict rather than a boolean so the caller can distinguish
 * "finished, precise" from "finished, out of budget" -- which the report must
 * render differently. Collapsing those two is how a benchmark ends up
 * publishing a number nobody should act on.
 */
export function samplingVerdict(values, precision = DEFAULT_PRECISION) {
  const { targetWidthRatio, minReps, maxReps } = { ...DEFAULT_PRECISION, ...precision };

  if (values.length < minReps) {
    return { state: 'continue', reason: 'below-min-reps', ci: null, width: Infinity };
  }

  const ci = bootstrapMedianCI(values, { seed: 0x5eed });
  const width = widthRatio(ci);

  if (width <= targetWidthRatio) return { state: 'converged', reason: 'precise', ci, width };
  if (values.length >= maxReps) {
    // NOT an error, and not silently dropped either. A task that will not
    // converge inside its budget is a fact ABOUT THE TASK -- usually that it is
    // bimodal -- and hiding it behind a mean is the failure this replaces.
    return { state: 'unresolved', reason: 'rep-cap-reached', ci, width };
  }
  return { state: 'continue', reason: 'interval-too-wide', ci, width };
}

/**
 * Is one arm's per-task ratio distinguishable from parity?
 *
 * Applied to the RATIO of arm to control, resampled jointly, so it accounts for
 * the control's own spread. Reporting an arm's interval against a control
 * treated as an exact constant is how a 34-42% control spread on the debug
 * tasks turned into confident-looking arm numbers.
 */
export function ratioCI(armValues, controlValues, { resamples = 2000, alpha = 0.05, seed } = {}) {
  if (!armValues.length || !controlValues.length) return { low: NaN, high: NaN, ratio: NaN };
  const next = rng(seed ?? 0xbeef);
  const ratios = new Array(resamples);
  const a = new Array(armValues.length);
  const c = new Array(controlValues.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < a.length; i++) a[i] = armValues[(next() * armValues.length) | 0];
    for (let i = 0; i < c.length; i++) c[i] = controlValues[(next() * controlValues.length) | 0];
    const cm = median(c);
    ratios[r] = cm === 0 ? NaN : median(a) / cm;
  }
  const clean = ratios.filter(Number.isFinite).sort((x, y) => x - y);
  if (!clean.length) return { low: NaN, high: NaN, ratio: NaN };
  const lo = Math.floor((alpha / 2) * clean.length);
  const hi = Math.min(clean.length - 1, Math.ceil((1 - alpha / 2) * clean.length) - 1);
  const point = median(controlValues) === 0 ? NaN : median(armValues) / median(controlValues);
  return { low: clean[lo], high: clean[hi], ratio: point };
}

/** Does the interval exclude parity? The only basis for claiming an effect. */
export function significant(ci) {
  return Number.isFinite(ci.low) && Number.isFinite(ci.high) && (ci.high < 1 || ci.low > 1);
}
