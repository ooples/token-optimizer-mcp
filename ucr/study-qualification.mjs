/** Evaluate a bounded, non-promotable selection before powered execution. */
export function studyQualificationVerdict({
  rows,
  plannedTrials,
  selectedTrialCount = null,
  plannedArms = null,
  failures,
}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeTrials = Array.isArray(plannedTrials) ? plannedTrials : [];
  const safeFailures = Array.isArray(failures) ? failures : [];
  const expectedTrials = Number.isInteger(selectedTrialCount)
    ? selectedTrialCount
    : safeTrials.length;
  const selectedArms = new Set(
    Array.isArray(plannedArms)
      ? plannedArms
      : safeTrials.map((trial) => trial.arm)
  );
  const rowByPair = new Map();
  for (const row of safeRows) {
    if (!row?.pairId) continue;
    if (!rowByPair.has(row.pairId)) rowByPair.set(row.pairId, {});
    rowByPair.get(row.pairId)[row.arm] = row;
  }
  const requiresPairedControl =
    selectedArms.has('empty') && selectedArms.has('runtime');
  const pairs = [...rowByPair.values()].filter(
    (pair) => pair.empty || pair.runtime
  );
  const completePairs = pairs.filter((pair) => pair.empty && pair.runtime);
  const tokenOverheads = completePairs
    .filter(
      (pair) =>
        Number.isFinite(pair.empty.totalTokens) &&
        pair.empty.totalTokens > 0 &&
        Number.isFinite(pair.runtime.totalTokens)
    )
    .map(
      (pair) =>
        (pair.runtime.totalTokens - pair.empty.totalTokens) /
        pair.empty.totalTokens
    );
  const checks = {
    selectionComplete:
      expectedTrials > 0 &&
      safeRows.length === expectedTrials &&
      safeFailures.length === 0,
    trialIntegrity: safeRows.every(
      (row) => row.trialIntegrityValid === true && row.graderVerified === true
    ),
    taskCorrect:
      safeRows.every((row) => row.severeHarm !== true) &&
      safeRows
        .filter((row) => row.arm !== 'empty')
        .every((row) => row.correct === true),
    runtimeDelivered: safeRows
      .filter((row) => row.arm === 'runtime')
      .every(
        (row) => row.delivered === true && row.deliveryPhase === 'pre-action'
      ),
    controlsWithheld: safeRows
      .filter((row) => row.arm === 'empty')
      .every((row) => row.delivered !== true),
    hardNegativesWithheld: safeRows
      .filter((row) =>
        ['stale', 'irrelevant', 'contradictory', 'harmful'].includes(row.arm)
      )
      .every((row) => row.delivered !== true),
    pairedCoverage:
      !requiresPairedControl ||
      (completePairs.length > 0 && completePairs.length === pairs.length),
    correctnessNonInferiority:
      !requiresPairedControl ||
      completePairs.every(
        (pair) =>
          !(pair.empty.correct === true && pair.runtime.correct !== true)
      ),
    tokenNonInferiority:
      !requiresPairedControl ||
      (completePairs.length > 0 &&
        tokenOverheads.length === completePairs.length &&
        tokenOverheads.every((overhead) => overhead <= 0.05)),
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    schemaVersion: 'ucr.study-qualification/1',
    status: failed.length ? 'failed' : 'passed',
    passed: failed.length === 0,
    checks,
    failed,
    selectedTrials: expectedTrials,
    executedTrials: safeRows.length,
    completePairs: completePairs.length,
    maximumObservedTokenOverhead:
      tokenOverheads.length > 0 ? Math.max(...tokenOverheads) : null,
  };
}
