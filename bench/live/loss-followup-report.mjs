/** Retain every loss-follow-up attempt and report only audited complete costs. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const evidence = resolve(process.argv[2]);
const read = async (name) =>
  JSON.parse(await readFile(join(evidence, name), 'utf8'));
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
  const rows = await read(`cases/${expected.id}/results.json`);
  const validation = await read(`cases/${expected.id}/validation.json`);
  const auditedCosts = await read(`cases/${expected.id}/cost-scenario.json`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.seed === expected.seedOffset + 1));
  const arms = {};
  for (const arm of ['proxy', 'headroom']) {
    const row = rows.find((r) => r.arm === arm);
    assert.ok(row);
    const valid = validation.find((r) => r.arm === arm)?.verdict === 'PASS';
    arms[arm] = {
      verdict: row.verdict,
      auditedPass: valid,
      usage: row.usage,
      requests: row.requests,
      agentSeconds: row.agentSeconds,
      estimatedUsd: auditedCosts.valid ? cost(row.usage) : null,
      firstRequestCached:
        row.ledgerUsage?.[0]?.usage?.cached_input_tokens ?? null,
    };
  }
  const original = baseline.cases.find((x) => x.id === expected.id);
  const complete =
    done.exit === 0 &&
    done.auditExit === 0 &&
    done.costExit === 0 &&
    auditedCosts.valid &&
    Object.values(arms).every((x) => x.auditedPass);
  cases.push({
    id: expected.id,
    arms,
    complete,
    originalCostDifferenceUsd: original.costDifferenceUsd,
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
  costReductionCompletePairs:
    1 -
    totals.proxy.estimatedUsdCompletePairs /
      totals.headroom.estimatedUsdCompletePairs,
  cases,
};
await writeFile(
  join(evidence, 'followup-summary.json'),
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(report, null, 2));
