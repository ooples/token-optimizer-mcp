/**
 * The ledger: what an entrant spent, and what it actually delivered for it.
 *
 * THE METRIC THIS REPLACES. The published leaderboard averages `total_cost_usd`
 * over runs with `status = 'ok'`. That filter drops failed runs AND the money
 * they burned, so failing a task is free and, worse, PROFITABLE: an entrant
 * that fails the expensive half of a battery is scored only on the cheap half.
 * Nothing in that number penalises answering worse in order to answer cheaper,
 * which is the exact failure mode a token optimizer is prone to.
 *
 * So the ledger charges every run and divides by work delivered:
 *
 *     costPerUnit = sum(usd over ALL runs) / sum(score over ALL runs)
 *
 * A failed run contributes its cost and a score of zero. An entrant that halves
 * its spend by producing half-right answers moves the numerator and the
 * denominator together and gains nothing, which is the property the old metric
 * lacked.
 *
 * SCORE IS DETERMINISTIC AND TASK-LOCAL, never a model's opinion. Each task
 * ships its own verifier returning [0, 1] from concrete checks -- a test that
 * passes, a file that contains the required symbol, an answer matching a known
 * value. That is what keeps a graded benchmark defensible: a rubric argument is
 * unfalsifiable, a failing assertion is not.
 */

import { median, ratioCI, ratioOfTotalsCI, significant, samplingVerdict, holm, rng } from './stats.mjs';
import { assertSingleBuild, rowProblem } from './provenance.mjs';

/** Groups rows by track, then arm, then task. Rejected rows are reported. */
export function organise(rows) {
  const good = [];
  const rejected = [];
  for (const row of rows) {
    const problem = rowProblem(row);
    if (problem) rejected.push({ row, problem });
    else good.push(row);
  }

  const tracks = new Map();
  for (const row of good) {
    if (!tracks.has(row.track)) tracks.set(row.track, new Map());
    const arms = tracks.get(row.track);
    if (!arms.has(row.arm)) arms.set(row.arm, new Map());
    const tasks = arms.get(row.arm);
    if (!tasks.has(row.task)) tasks.set(row.task, []);
    tasks.get(row.task).push(row);
  }
  return { tracks, rejected };
}

/**
 * What a run cost, in the unit the report is ranking on.
 *
 * `usd` is the endpoint that matters and stays the default. `output` exists
 * because both products under comparison target output tokens specifically,
 * and a null on cost has two very different explanations: the instructions did
 * nothing, or they did what they claim and output is too small a share of the
 * bill for it to show. Only a direct measurement separates those, and it has to
 * come through the same ranking machinery -- the same medians, the same
 * resampling, the same convergence rule -- or it is not comparable to the
 * headline it is explaining.
 *
 * A row from before token capture has no breakdown; it yields NaN rather than 0
 * so it is dropped from the sample instead of dragging every median toward
 * zero.
 */
function metricOf(row, endpoint) {
  if (endpoint === 'output') {
    const t = row.tokens?.output;
    return Number.isFinite(t) ? t : NaN;
  }
  return row.usd;
}

/**
 * One arm's result on one task.
 *
 * `costPerUnit` charges every run. `completion` is the share of runs that
 * cleared the threshold, reported BESIDE the cost rather than folded into it,
 * because a reader deciding whether to adopt a tool needs to see a cheap tool
 * that fails a third of the time for what it is.
 */
export function taskResult(rows, { completionThreshold = 0.999, precision, endpoint = 'usd' } = {}) {
  const usable = endpoint === 'usd' ? rows : rows.filter((r) => Number.isFinite(metricOf(r, endpoint)));
  if (!usable.length) {
    return {
      n: 0,
      spend: 0,
      delivered: 0,
      costPerUnit: Infinity,
      completion: 0,
      medianUnitCost: Infinity,
      sampling: samplingVerdict([], precision),
      turns: NaN,
    };
  }
  rows = usable;
  const usd = rows.map((r) => metricOf(r, endpoint));
  const score = rows.map((r) => r.score);
  const spend = usd.reduce((a, b) => a + b, 0);
  const delivered = score.reduce((a, b) => a + b, 0);

  // Per-run cost of a unit of work, which is what the ratio and the CI use.
  // Runs that delivered nothing are included at their full cost via `spend`,
  // and contribute no denominator -- so a task an arm never completes has an
  // infinite unit cost, which is the honest answer rather than a missing row.
  const perRun = rows.map((r) => (r.score > 0 ? metricOf(r, endpoint) / r.score : Infinity));
  const finite = perRun.filter(Number.isFinite);

  return {
    n: rows.length,
    spend,
    delivered,
    costPerUnit: delivered > 0 ? spend / delivered : Infinity,
    completion: rows.filter((r) => r.score >= completionThreshold).length / rows.length,
    medianUnitCost: finite.length ? median(finite) : Infinity,
    sampling: samplingVerdict(finite.length ? finite : usd, precision),
    turns: median(rows.map((r) => r.turns)),
  };
}

/**
 * The geometric mean of per-task ratios, with tasks that never converged
 * excluded from the headline and listed separately.
 *
 * GEOMETRIC, because an arithmetic mean of ratios is dominated by whichever
 * task happened to be most expensive, and the question is proportional cost.
 *
 * EXCLUDED RATHER THAN AVERAGED, which is the departure. A task whose interval
 * never narrowed is not evidence at either value it straddles; folding its
 * point estimate into the headline manufactures precision the data does not
 * have. It is reported, by name, as unresolved -- and if too many are, the
 * comparison itself is marked untrustworthy rather than published.
 */
export function compareArm(armTasks, controlTasks, options = {}) {
  const { maxUnresolvedShare = 0.34, endpoint = 'usd' } = options;
  const perTask = [];
  const unresolved = [];

  for (const [task, rows] of armTasks) {
    const controlRows = controlTasks.get(task);
    if (!controlRows?.length) continue;

    const arm = taskResult(rows, options);
    const control = taskResult(controlRows, options);

    // Same endpoint on both sides of the ratio, and only runs that recorded
    // it. Falling back to usd on one side would produce a ratio of dollars to
    // tokens, which is a number and means nothing.
    //
    // Pairs, not unit costs: a failed run keeps its cost in the numerator and
    // contributes nothing to the denominator, which is the ledger's whole
    // point and what a per-run unit cost quietly discards.
    const pairsOf = (rs) =>
      rs
        .map((r) => [metricOf(r, endpoint), r.score])
        .filter(([c]) => Number.isFinite(c));
    const armUnits = pairsOf(rows);
    const ctlUnit = pairsOf(controlRows);
    const ci = ratioOfTotalsCI(armUnits, ctlUnit);

    const entry = {
      task,
      // Taken FROM the interval rather than computed alongside it, so the two
      // cannot be different statistics wearing the same label.
      ratio: ci.ratio,
      ci,
      significant: significant(ci),
      arm,
      control,
      armUnits,
      controlUnits: ctlUnit,
    };

    // ONLY A CONVERGED TASK MAY ENTER THE HEADLINE. Excluding just the
    // `unresolved` state was wrong: a task that has neither converged nor hit
    // the rep cap returns `continue`, and those were being folded in as though
    // settled. Observed on the warm track -- four tasks the campaign itself had
    // reported as not converged were averaged into "1.081 of control over 4
    // task(s)". `continue` means "not enough evidence yet", which is the same
    // thing as `unresolved` as far as a published number is concerned; the two
    // differ only in whether more reps would help.
    const settled =
      arm.sampling.state === 'converged' && control.sampling.state === 'converged';
    if (settled) perTask.push(entry);
    else {
      entry.samplingState =
        arm.sampling.state === 'converged' ? control.sampling.state : arm.sampling.state;
      unresolved.push(entry);
    }
  }

  const usable = perTask.filter((e) => Number.isFinite(e.ratio) && e.ratio > 0);
  const total = perTask.length + unresolved.length;
  const share = total ? unresolved.length / total : 0;

  const geo = usable.length
    ? Math.exp(usable.reduce((s, e) => s + Math.log(e.ratio), 0) / usable.length)
    : NaN;

  // THE HEADLINE NEEDS ITS OWN INTERVAL, and shipping it without one was this
  // report's own version of the defect it exists to prevent. The first real
  // campaign printed "1.143 of control" while EVERY per-task interval spanned
  // parity -- a bare point estimate, which is exactly what gets quoted as a
  // fact. Resampling the underlying runs and recomputing the whole geometric
  // mean gives the headline a spread, so a reader can see that +14.3% and
  // "indistinguishable from control" are the same result.
  const headlineCI = geometricRatioCI(usable);

  return {
    costRatio: geo,
    costRatioCI: headlineCI,
    costRatioSignificant: significant(headlineCI),
    tasksCounted: usable.length,
    unresolved: unresolved.map((e) => e.task),
    unresolvedDetail: unresolved.sort((a, b) => b.ratio - a.ratio),
    // The headline is withheld, not caveated, when too much of the battery
    // failed to converge. A number with a footnote gets quoted without it.
    trustworthy: total > 0 && share <= maxUnresolvedShare && usable.length > 0,
    unresolvedShare: share,
    perTask: perTask.sort((a, b) => b.ratio - a.ratio),
  };
}

/**
 * A confidence interval for the geometric mean of the per-task ratios.
 *
 * Resamples the RUNS inside every task and recomputes the whole statistic, so
 * the interval carries both sources of spread: how noisy each task is, and how
 * much the tasks disagree with each other. Resampling only the tasks would
 * ignore the first and report a falsely tight headline on a battery of noisy
 * tasks -- which is the situation this was written for.
 *
 * Seeded, like everything else here, so a published headline can be recomputed
 * from the published rows.
 */
export function geometricRatioCI(perTask, { resamples = 2000, alpha = 0.05, seed = 0xf00d } = {}) {
  const usable = perTask.filter((e) => e.armUnits?.length && e.controlUnits?.length);
  if (!usable.length) return { low: NaN, high: NaN };

  const next = rng(seed);
  const draws = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let n = 0;
    for (const task of usable) {
      // Resampled as (cost, score) PAIRS and reduced to a ratio of totals --
      // the same statistic each per-task interval reports, so the headline
      // cannot be a summary of numbers no per-task line contains. When these
      // were medians of per-run unit costs, the headline and the rows beneath
      // it were different estimators.
      const totals = (pairs) => {
        let cost = 0;
        let delivered = 0;
        for (let i = 0; i < pairs.length; i++) {
          const [pc, ps] = pairs[(next() * pairs.length) | 0];
          cost += pc;
          delivered += ps;
        }
        return delivered > 0 ? cost / delivered : NaN;
      };
      const cm = totals(task.controlUnits);
      if (!cm) continue;
      const ratio = totals(task.armUnits) / cm;
      if (!Number.isFinite(ratio) || ratio <= 0) continue;
      sum += Math.log(ratio);
      n += 1;
    }
    if (n) draws.push(Math.exp(sum / n));
  }
  if (!draws.length) return { low: NaN, high: NaN };
  draws.sort((x, y) => x - y);
  const lo = Math.floor((alpha / 2) * draws.length);
  const hi = Math.min(draws.length - 1, Math.ceil((1 - alpha / 2) * draws.length) - 1);
  return { low: draws[lo], high: draws[hi] };
}

/**
 * The full report: every track, every arm, against control.
 *
 * Tracks are never combined. `assertSingleBuild` runs per arm and throws rather
 * than reporting, so a mixed-build store cannot produce a headline at all.
 */
export function report(rows, options = {}) {
  // THE COMPARATOR IS A PARAMETER, because a head-to-head between two
  // candidates is a question this report could not previously answer. Both
  // against control is not the same experiment: it is two ratios sharing a
  // denominator, and dividing one by the other by hand discards the covariance
  // and produces an interval that is simply wrong. Worse, the last time an
  // analysis this report could not express got hand-rolled in a throwaway
  // script, the script mixed two builds and bypassed the guard below.
  //
  // Defaults to `control`, so every existing caller is unaffected.
  const { baseline = 'control' } = options;
  const { tracks, rejected } = organise(rows);
  const out = { tracks: {}, rejected, baseline };

  for (const [track, arms] of tracks) {
    const baselineTasks = arms.get(baseline);
    out.tracks[track] = { control: Boolean(baselineTasks), baseline, arms: {} };
    if (!baselineTasks) continue;
    assertSingleBuild([...baselineTasks.values()].flat(), `${track}/${baseline}`);

    for (const [arm, tasks] of arms) {
      if (arm === baseline) continue;
      assertSingleBuild([...tasks.values()].flat(), `${track}/${arm}`);
      out.tracks[track].arms[arm] = compareArm(tasks, baselineTasks, options);
    }
    correctForFamilySize(out.tracks[track].arms);
  }
  return out;
}

/**
 * Every per-task interval a track publishes is one test, and they are corrected
 * together.
 *
 * THE FAMILY IS THE TRACK, NOT THE ARM, and getting that boundary wrong is the
 * easy way to keep an uncorrected win. Seven tasks against two arms is fourteen
 * tests; a reader who sees one exclusion in that table is looking at the single
 * most likely outcome of measuring nothing at all. Correcting inside each arm
 * separately would treat the same table as two families of seven and quietly
 * hand back most of the leniency.
 *
 * `significant` is left untouched -- the raw interval is still what it was, and
 * overwriting it would erase the reader's ability to see the correction's
 * cost. `survivesCorrection` is the field a published claim must cite.
 */
export function correctForFamilySize(armsByName, alpha = 0.05) {
  const family = [];
  for (const cmp of Object.values(armsByName)) {
    for (const entry of cmp.perTask) family.push(entry);
  }
  const adjusted = holm(family.map((e) => e.ci?.p ?? NaN));
  family.forEach((entry, i) => {
    entry.adjustedP = adjusted[i];
    entry.survivesCorrection = Number.isFinite(adjusted[i]) && adjusted[i] < alpha;
    entry.familyNote = `${family.length} tests on this track`;
  });
  for (const cmp of Object.values(armsByName)) {
    cmp.familySize = family.length;
    cmp.survivingTasks = cmp.perTask.filter((e) => e.survivesCorrection).map((e) => e.task);
  }
  return family.length;
}
