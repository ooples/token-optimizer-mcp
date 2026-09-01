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

import { median, ratioCI, significant, samplingVerdict, rng } from './stats.mjs';
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
 * One arm's result on one task.
 *
 * `costPerUnit` charges every run. `completion` is the share of runs that
 * cleared the threshold, reported BESIDE the cost rather than folded into it,
 * because a reader deciding whether to adopt a tool needs to see a cheap tool
 * that fails a third of the time for what it is.
 */
export function taskResult(rows, { completionThreshold = 0.999, precision } = {}) {
  const usd = rows.map((r) => r.usd);
  const score = rows.map((r) => r.score);
  const spend = usd.reduce((a, b) => a + b, 0);
  const delivered = score.reduce((a, b) => a + b, 0);

  // Per-run cost of a unit of work, which is what the ratio and the CI use.
  // Runs that delivered nothing are included at their full cost via `spend`,
  // and contribute no denominator -- so a task an arm never completes has an
  // infinite unit cost, which is the honest answer rather than a missing row.
  const perRun = rows.map((r) => (r.score > 0 ? r.usd / r.score : Infinity));
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
  const { maxUnresolvedShare = 0.34 } = options;
  const perTask = [];
  const unresolved = [];

  for (const [task, rows] of armTasks) {
    const controlRows = controlTasks.get(task);
    if (!controlRows?.length) continue;

    const arm = taskResult(rows, options);
    const control = taskResult(controlRows, options);

    const armUnits = rows.filter((r) => r.score > 0).map((r) => r.usd / r.score);
    const ctlUnit = controlRows.filter((r) => r.score > 0).map((r) => r.usd / r.score);
    const ci = ratioCI(armUnits, ctlUnit);

    const entry = {
      task,
      ratio: control.costPerUnit > 0 ? arm.costPerUnit / control.costPerUnit : NaN,
      ci,
      significant: significant(ci),
      arm,
      control,
      armUnits,
      controlUnits: ctlUnit,
    };

    if (arm.sampling.state === 'unresolved' || control.sampling.state === 'unresolved') {
      unresolved.push(entry);
    } else {
      perTask.push(entry);
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
      const a = [];
      const c = [];
      for (let i = 0; i < task.armUnits.length; i++) {
        a.push(task.armUnits[(next() * task.armUnits.length) | 0]);
      }
      for (let i = 0; i < task.controlUnits.length; i++) {
        c.push(task.controlUnits[(next() * task.controlUnits.length) | 0]);
      }
      const cm = median(c);
      if (!cm) continue;
      const ratio = median(a) / cm;
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
  const { tracks, rejected } = organise(rows);
  const out = { tracks: {}, rejected };

  for (const [track, arms] of tracks) {
    const controlTasks = arms.get('control');
    out.tracks[track] = { control: Boolean(controlTasks), arms: {} };
    if (!controlTasks) continue;

    for (const [arm, tasks] of arms) {
      if (arm === 'control') continue;
      assertSingleBuild([...tasks.values()].flat(), `${track}/${arm}`);
      out.tracks[track].arms[arm] = compareArm(tasks, controlTasks, options);
    }
  }
  return out;
}
