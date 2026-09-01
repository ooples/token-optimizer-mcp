/**
 * What a task is, and how a run of it earns a score.
 *
 * THE SCORE IS THE WHOLE CREDIBILITY ARGUMENT, so it is deterministic and
 * task-local: a list of named checks, each a predicate over the workspace the
 * agent left behind, each carrying a weight. No model grades anything. A rubric
 * argument is unfalsifiable and every graded benchmark eventually drowns in
 * one; a failing assertion is not arguable.
 *
 * PARTIAL CREDIT IS THE POINT. Binary pass/fail cannot express "cheaper but
 * worse", which is the exact failure mode a token optimizer is prone to -- an
 * agent that fixes the bug but deletes the test, or answers the question but
 * gets the version wrong, has not done the same work as one that did it all.
 * Weighted checks let the ledger charge for that difference instead of rounding
 * it away.
 */

/** Checks must be cheap, local, and free of network or model calls. */
export function validateTask(task) {
  const problems = [];
  if (!task || typeof task !== 'object') return ['not an object'];
  if (!task.id || typeof task.id !== 'string') problems.push('missing id');
  if (!task.family || typeof task.family !== 'string') problems.push('missing family');
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) problems.push('missing prompt');
  if (typeof task.setup !== 'function') problems.push('setup must be a function');
  if (!Array.isArray(task.checks) || !task.checks.length) problems.push('needs at least one check');
  if (!Array.isArray(task.tracks) || !task.tracks.length) problems.push('needs at least one track');

  for (const [i, check] of (task.checks || []).entries()) {
    if (!check || typeof check.run !== 'function') problems.push(`check ${i}: run must be a function`);
    if (!check?.name) problems.push(`check ${i}: missing name`);
    const w = check?.weight;
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
      problems.push(`check ${i}: weight must be a positive number`);
    }
  }

  // ADVERSARIAL MUST BE DECLARED, NOT INFERRED. The benchmark's defence against
  // "the vendor picked tasks that suit them" is a set of families where our own
  // approach cannot help, reported first. A boolean that defaults to false and
  // is never set would let that set quietly empty itself.
  if (typeof task.adversarial !== 'boolean') problems.push('adversarial must be declared explicitly');

  return problems;
}

/**
 * Runs a task's checks against a finished workspace.
 *
 * A THROWING CHECK SCORES ZERO FOR ITS WEIGHT, and is recorded as errored
 * rather than failed. The distinction matters when reading a report: a check
 * that failed says something about the agent, a check that threw says something
 * about the check, and conflating them lets a broken verifier masquerade as a
 * poor result -- which would silently deflate every arm equally and look like
 * a finding.
 */
export function scoreWorkspace(task, workspace) {
  const results = [];
  let earned = 0;
  let total = 0;

  for (const check of task.checks) {
    total += check.weight;
    let passed = false;
    let errored = null;
    try {
      passed = Boolean(check.run(workspace));
    } catch (error) {
      errored = error?.message || String(error);
    }
    if (passed) earned += check.weight;
    results.push({ name: check.name, weight: check.weight, passed, errored });
  }

  return {
    score: total > 0 ? earned / total : 0,
    earned,
    total,
    checks: results,
    // Surfaced so a report can refuse to trust a task whose verifier is broken.
    errored: results.filter((r) => r.errored).length,
  };
}

/**
 * A run that never produced a workspace scores zero, and says why.
 *
 * Kept as a function rather than a literal so every caller produces the same
 * shape -- a failed run still has to be a valid ledger row, carrying its cost.
 */
export function zeroScore(reason) {
  return { score: 0, earned: 0, total: 0, checks: [], errored: 0, reason };
}
