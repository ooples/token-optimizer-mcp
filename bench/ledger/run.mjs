/**
 * The campaign loop: sample until the interval is tight, then stop.
 *
 * THE EXECUTOR IS INJECTED, and that is a deliberate structural choice rather
 * than tidiness. Everything interesting here -- when to take another rep, when
 * to give up on a task, how warm state carries between runs, what provenance
 * lands on a row -- is logic that costs real money to exercise if it can only
 * be tested by running an agent. Injecting the executor makes the entire loop
 * unit-testable with a fake, for free, which is the same discipline that let
 * the measurement layer be built and mutation-tested before a single API call.
 *
 * The previous harness could only be debugged by spending; this session burned
 * roughly $8 discovering, among other things, that it had been resuming runs
 * from a superseded build. None of that needed to cost anything.
 *
 * COLD AND WARM ARE DIFFERENT LOOPS, not a flag. A cold rep gets a fresh state
 * directory every time and its reps are independent. A warm SEQUENCE runs an
 * ordered list of tasks against one accumulating state directory, and the unit
 * of repetition is the whole sequence -- repeating a single warm task in
 * isolation would measure a cold run wearing a warm label.
 */

import { samplingVerdict, DEFAULT_PRECISION } from './stats.mjs';
import { scoreWorkspace, zeroScore } from './task.mjs';

/**
 * One rep of one task.
 *
 * `execute` receives everything it needs to run an agent and must return
 * { status, usd, turns, workspace }. It is never asked to score anything: the
 * verifier belongs to the task, so an executor cannot influence its own mark.
 */
async function runOnce(task, { arm, track, rep, stateDir, execute, provenance }) {
  const startedAt = new Date().toISOString();
  let outcome;
  try {
    outcome = await execute({ task, arm, track, rep, stateDir });
  } catch (error) {
    outcome = { status: 'error', usd: 0, turns: 0, workspace: null, error: String(error) };
  }

  // A RUN THAT FAILED STILL PAYS. Its cost is whatever it burned before dying,
  // and its score is zero -- that pairing is the entire point of the ledger,
  // and dropping the row here would reintroduce the defect being fixed.
  const scored =
    outcome.status === 'ok' && outcome.workspace
      ? scoreWorkspace(task, outcome.workspace)
      : zeroScore(outcome.error || `status=${outcome.status}`);

  return {
    task: task.id,
    family: task.family,
    adversarial: task.adversarial,
    arm,
    track,
    rep,
    status: outcome.status,
    usd: Number(outcome.usd) || 0,
    turns: Number(outcome.turns) || 0,
    // COPIED THROUGH HERE, because the ROW is built in this file and not in the
    // executor. The token breakdown was added to readOutcome and tested there,
    // and every row still came out with tokens undefined -- a whole campaign
    // reported output ratio NaN. Testing the unit is not testing the wiring,
    // which is the same failure as verifying that an advisory fires without
    // verifying that it changes anything.
    tokens: outcome.tokens || null,
    score: scored.score,
    checks: scored.checks,
    verifier_errors: scored.errored,
    started_at: startedAt,
    ...provenance,
  };
}

/**
 * Cold track: independent reps, each from a fresh state directory.
 *
 * Sampling continues until the interval converges or the cap is hit. The cap is
 * a spend control and `unresolved` is its honest outcome -- a task that will not
 * converge is a fact about the task, not a number to average.
 */
export async function runColdTask(
  task,
  { arm, execute, freshStateDir, provenance, precision, onRow } = {}
) {
  const rows = [];
  const limit = { ...DEFAULT_PRECISION, ...precision };

  for (let rep = 1; rep <= limit.maxReps; rep++) {
    const stateDir = freshStateDir ? await freshStateDir({ task, arm, rep }) : null;
    const row = await runOnce(task, { arm, track: 'cold', rep, stateDir, execute, provenance });
    rows.push(row);
    // PERSISTED PER REP, NOT PER TASK. Writing only after the whole task
    // finished meant an interrupted campaign lost every rep it had paid for --
    // observed: a run died partway through the first task and left no store
    // file at all, discarding runs that had actually happened. The ledger's own
    // rule is that money already spent must be recorded, and that has to hold
    // for the harness itself.
    onRow?.(row);

    // Converge on the UNIT COST, which is what the ranking compares -- not on
    // raw spend. A task whose cost is steady but whose score wobbles is not
    // settled, and converging on usd alone would call it settled.
    const units = rows.filter((r) => r.score > 0).map((r) => r.usd / r.score);
    const verdict = samplingVerdict(units.length ? units : rows.map((r) => r.usd), limit);
    if (verdict.state !== 'continue') return { rows, verdict };
  }

  const units = rows.filter((r) => r.score > 0).map((r) => r.usd / r.score);
  return { rows, verdict: samplingVerdict(units.length ? units : rows.map((r) => r.usd), limit) };
}

/**
 * Warm track: an ordered sequence against ONE accumulating state directory.
 *
 * The repetition unit is the sequence, so `rep` indexes the whole pass. This is
 * the only condition under which a cross-session mechanism can demonstrate
 * anything -- the harness this replaces gave every run a throwaway home, which
 * made that entire class of product unmeasurable rather than merely unmeasured.
 */
export async function runWarmSequence(
  tasks,
  { arm, execute, freshStateDir, provenance, precision, onRow, startRep = 1, priorRows = [] } = {}
) {
  const limit = { ...DEFAULT_PRECISION, ...precision };
  // RESUMES FROM ROWS ALREADY BANKED. Without this a warm campaign that was
  // interrupted restarted its whole sequence, so a track killed three times in
  // a row could never finish no matter how much was spent. The prior rows count
  // toward convergence too -- otherwise resuming would re-derive an interval
  // from a fraction of the evidence and keep sampling forever.
  const rows = [...priorRows];

  for (let rep = startRep; rep <= limit.maxReps; rep++) {
    // Fresh for the SEQUENCE, shared within it. That single distinction is what
    // separates warm from cold.
    const stateDir = freshStateDir ? await freshStateDir({ arm, rep }) : null;
    for (const task of tasks) {
      const row = await runOnce(task, { arm, track: 'warm', rep, stateDir, execute, provenance });
      rows.push(row);
      // Per rep, for the reason given in runColdTask: an interrupted campaign
      // must keep whatever it has already paid for.
      onRow?.(row);
    }

    // Converged when EVERY task in the sequence has settled. One unresolved
    // task does not stop the others being sampled, but it does stop the
    // sequence being called finished.
    const verdicts = tasks.map((task) => {
      const mine = rows.filter((r) => r.task === task.id && r.score > 0);
      const units = mine.map((r) => r.usd / r.score);
      const fallback = rows.filter((r) => r.task === task.id).map((r) => r.usd);
      return samplingVerdict(units.length ? units : fallback, limit);
    });
    if (verdicts.every((v) => v.state !== 'continue')) {
      return { rows, verdicts, unresolved: tasks.filter((_, i) => verdicts[i].state === 'unresolved').map((t) => t.id) };
    }
  }

  const verdicts = tasks.map((task) => {
    const mine = rows.filter((r) => r.task === task.id && r.score > 0);
    const units = mine.map((r) => r.usd / r.score);
    const fallback = rows.filter((r) => r.task === task.id).map((r) => r.usd);
    return samplingVerdict(units.length ? units : fallback, limit);
  });
  return {
    rows,
    verdicts,
    unresolved: tasks.filter((_, i) => verdicts[i].state === 'unresolved').map((t) => t.id),
  };
}

/**
 * Provenance for every row this campaign writes.
 *
 * REQUIRED, NOT OPTIONAL. `provenance.mjs` refuses to summarise rows that span
 * two builds, and that guard is only as good as the identity recorded here.
 * Throwing on a missing digest is deliberate: a campaign that runs without
 * provenance produces rows that can never be safely compared to anything, and
 * discovering that after spending the money is the failure this prevents.
 */
export function campaignProvenance({ imageDigest, commitSha } = {}) {
  if (!imageDigest || !commitSha) {
    throw new Error(
      'campaign provenance requires imageDigest and commitSha; ' +
        'rows without them cannot be compared across builds'
    );
  }
  return { image_digest: imageDigest, commit_sha: commitSha };
}
