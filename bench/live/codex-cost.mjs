/** Rate-card scenario over audited provider usage, never an account invoice. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const standardScenario = Object.freeze({
  model: 'gpt-6-astra',
  label: 'Codex Enterprise standard rate-card scenario; not actual billed cost',
  verifiedOn: '2026-09-15',
  source: 'https://help.openai.com/en/articles/20001415',
  usdPerMillion: { uncached: 10, cached: 1, output: 50 },
  assumptions: [
    'All runs use standard speed with no regional or contract adjustments.',
    'Codex Astra has no cache-write charge or long-context multiplier.',
    'Subscription charges, credits, proxy compute, and account discounts are not measured.',
  ],
});

export function costReport(
  manifest,
  summary,
  rows,
  validation = rows,
  scenario = standardScenario
) {
  const rates = scenario.usdPerMillion;
  if (manifest.model !== scenario.model || summary.model !== scenario.model)
    throw Error('Rate-card model mismatch');
  if (
    !['uncached', 'cached', 'output'].every(
      (k) => Number.isFinite(rates[k]) && rates[k] >= 0
    )
  )
    throw Error('Invalid rate card');
  const expected = manifest.tasks.flatMap((task) =>
    manifest.arms.flatMap((arm) =>
      Array.from(
        { length: manifest.reps },
        (_, rep) => `${task}:${arm}:${rep + 1}`
      )
    )
  );
  const ids = rows.map((r) => `${r.task}:${r.arm}:${r.rep}`);
  const failures = [];
  const auditIds = validation.map((r) => `${r.task}:${r.arm}:${r.rep}`);
  if (
    auditIds.length !== expected.length ||
    new Set(auditIds).size !== expected.length ||
    auditIds.some((id) => !expected.includes(id))
  )
    failures.push('Missing, duplicate, or unexpected audit rows');
  if (summary.valid !== true) failures.push('Campaign audit is invalid');
  if (
    !expected.length ||
    ids.length !== expected.length ||
    new Set(ids).size !== expected.length ||
    ids.some((id) => !expected.includes(id))
  )
    failures.push('Missing, duplicate, or unexpected runs');
  const measured = rows.map((row) => {
    const audited = validation.find(
      (r) => r.task === row.task && r.arm === row.arm && r.rep === row.rep
    );
    const u = row.usage;
    const valid =
      u &&
      ['input', 'cached', 'output'].every(
        (k) => Number.isSafeInteger(u[k]) && u[k] >= 0
      ) &&
      u.cached <= u.input;
    const ledger = row.ledgerUsage;
    const totals = { input: 0, cached: 0, output: 0 };
    let reconciled = Array.isArray(ledger) && ledger.length > 0;
    for (const entry of ledger || []) {
      const l = entry.usage;
      if (
        !l ||
        !['input_tokens', 'cached_input_tokens', 'output_tokens'].every(
          (k) => Number.isSafeInteger(l[k]) && l[k] >= 0
        ) ||
        l.cached_input_tokens > l.input_tokens
      ) {
        reconciled = false;
        continue;
      }
      totals.input += l.input_tokens;
      totals.cached += l.cached_input_tokens;
      totals.output += l.output_tokens;
    }
    reconciled &&=
      valid && Object.keys(totals).every((k) => totals[k] === u[k]);
    if (!valid || !reconciled || audited?.verdict !== 'PASS')
      failures.push(`Unverified run ${row.task}:${row.arm}:${row.rep}`);
    const usd =
      valid && reconciled
        ? ((u.input - u.cached) * rates.uncached +
            u.cached * rates.cached +
            u.output * rates.output) /
          1e6
        : null;
    return {
      task: row.task,
      arm: row.arm,
      rep: row.rep,
      recordedVerdict: row.verdict,
      verdict: audited?.verdict ?? 'UNAUDITED',
      estimatedUsd: usd,
    };
  });
  const aggregates = [];
  const comparisons = [];
  if (!failures.length) {
    for (const task of manifest.tasks) {
      for (const arm of manifest.arms) {
        const group = measured.filter((r) => r.task === task && r.arm === arm);
        aggregates.push({
          task,
          arm,
          meanEstimatedUsd:
            group.reduce((s, r) => s + r.estimatedUsd, 0) / group.length,
        });
      }
      for (const candidate of manifest.arms.filter((a) =>
        ['proxy', 'mcp', 'full', 'full-files'].includes(a)
      )) {
        const current = aggregates.find(
          (a) => a.task === task && a.arm === candidate
        );
        for (const against of candidate === 'full-files'
          ? ['control', 'headroom', 'full']
          : ['control', 'headroom']) {
          const baseline = aggregates.find(
            (a) => a.task === task && a.arm === against
          );
          if (baseline)
            comparisons.push({
              task,
              candidate,
              against,
              estimatedUsdDelta:
                current.meanEstimatedUsd - baseline.meanEstimatedUsd,
              reductionPercent: baseline.meanEstimatedUsd
                ? 100 *
                  (1 - current.meanEstimatedUsd / baseline.meanEstimatedUsd)
                : null,
            });
        }
      }
    }
  }
  return {
    scenario,
    valid: failures.length === 0,
    failures,
    measured,
    aggregates,
    comparisons,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const dir = process.argv[2];
  if (!dir) throw Error('Usage: node bench/live/codex-cost.mjs CAMPAIGN');
  const [manifest, summary, rows, validation] = await Promise.all(
    ['manifest.json', 'summary.json', 'results.json', 'validation.json'].map(
      async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))
    )
  );
  const report = costReport(manifest, summary, rows, validation);
  await writeFile(
    join(dir, 'cost-scenario.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      valid: report.valid,
      failures: report.failures,
      comparisons: report.comparisons,
    })
  );
  if (!report.valid) process.exitCode = 2;
}
