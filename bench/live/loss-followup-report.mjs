/** Retain every loss-follow-up attempt and report only audited complete costs. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { matchAudits, reduction } from './report-validation.mjs';
const evidence = resolve(process.argv[2]);
const read = async (name) =>
  JSON.parse(await readFile(join(evidence, name), 'utf8'));
const optional = async (name) => {
  try {
    return await read(name);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
};
const plan = await read('followup-plan.json');
const execution = await read('followup-execution.json');
assert.equal(execution.length, plan.cases.length);
const baseline = await read('loss-audit.json');
const rates = baseline.scenario.usdPerMillion;
const cost = (u) =>
  ((u.input - u.cached) * rates.uncached +
    u.cached * rates.cached +
    u.output * rates.output) /
  1e6;
const cases = [];
for (const expected of plan.cases) {
  const done = execution.find((x) => x.id === expected.id);
  assert.ok(done);
  const rows = await optional(`cases/${expected.id}/results.json`);
  const validation = await optional(`cases/${expected.id}/validation.json`);
  const auditedCosts = await optional(
    `cases/${expected.id}/cost-scenario.json`
  );
  let audited = [],
    artifactsValid = false;
  try {
    audited = matchAudits(rows, validation);
    artifactsValid =
      rows.length === 2 &&
      rows.every((r) => r.seed === expected.seedOffset + 1) &&
      ['proxy', 'headroom'].every(
        (arm) => rows.filter((r) => r.arm === arm).length === 1
      );
  } catch {
    /* Incomplete attempts remain in the report with unknown costs. */
  }
  const arms = {};
  for (const arm of ['proxy', 'headroom']) {
    const row =
      (Array.isArray(rows) ? rows : []).find((r) => r.arm === arm) ?? {};
    const valid =
      artifactsValid && audited.find((r) => r.arm === arm)?.verdict === 'PASS';
    arms[arm] = {
      verdict: row.verdict ?? 'INCOMPLETE',
      auditedPass: valid,
      usage: row.usage,
      requests: row.requests,
      agentSeconds: row.agentSeconds,
      estimatedUsd:
        artifactsValid && auditedCosts?.valid && row.usage
          ? cost(row.usage)
          : null,
      firstRequestCached:
        row.ledgerUsage?.[0]?.usage?.cached_input_tokens ?? null,
    };
  }
  const original = baseline.cases.find((x) => x.id === expected.id);
  const complete =
    done.exit === 0 &&
    done.auditExit === 0 &&
    done.costExit === 0 &&
    Boolean(done.raw) &&
    artifactsValid &&
    auditedCosts?.valid === true &&
    Object.values(arms).every(
      (x) => x.auditedPass && Number.isFinite(x.estimatedUsd)
    );
  cases.push({
    id: expected.id,
    arms,
    complete,
    originalCostDifferenceUsd: original.costDifferenceUsd,
    incompleteReason: complete
      ? null
      : 'Missing, invalid, or failed attempt artifacts',
    costDifferenceUsd: complete
      ? arms.proxy.estimatedUsd - arms.headroom.estimatedUsd
      : null,
    proxyCostWin: complete
      ? arms.proxy.estimatedUsd < arms.headroom.estimatedUsd
      : null,
  });
}
const complete = cases.filter((x) => x.complete);
const totals = Object.fromEntries(
  ['proxy', 'headroom'].map((arm) => [
    arm,
    {
      pass: cases.filter((x) => x.arms[arm].auditedPass).length,
      estimatedUsdCompletePairs: complete.reduce(
        (s, x) => s + x.arms[arm].estimatedUsd,
        0
      ),
      inputCompletePairs: complete.reduce(
        (s, x) => s + x.arms[arm].usage.input,
        0
      ),
    },
  ])
);
const report = {
  scope: plan.scope,
  planned: cases.length,
  complete: complete.length,
  proxyCostWins: cases.filter((x) => x.proxyCostWin === true).length,
  proxyCostLosses: cases.filter((x) => x.complete && x.costDifferenceUsd > 0)
    .length,
  costTies: cases.filter((x) => x.complete && x.costDifferenceUsd === 0).length,
  totals,
  costReductionCompletePairs: reduction(
    totals.proxy.estimatedUsdCompletePairs,
    totals.headroom.estimatedUsdCompletePairs
  ),
  cases,
};
await writeFile(
  join(evidence, 'followup-summary.json'),
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(report, null, 2));
