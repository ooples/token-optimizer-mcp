/** Audit every scheduled pair, including failures and unknown costs. No winner filtering. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function classifyPair(arms) {
  if (!['proxy', 'headroom'].every((a) => arms[a]?.verdict === 'PASS'))
    return 'quality-failure';
  if (
    !['proxy', 'headroom'].every((a) =>
      ['estimatedUsd', 'agentSeconds'].every(
        (k) => Number.isFinite(arms[a][k]) && arms[a][k] >= 0
      )
    )
  )
    return 'unknown';
  const p = arms.proxy,
    h = arms.headroom;
  if (p.estimatedUsd === h.estimatedUsd || p.agentSeconds === h.agentSeconds)
    return 'tie';
  if (p.estimatedUsd < h.estimatedUsd && p.agentSeconds < h.agentSeconds)
    return 'joint-win';
  if (p.estimatedUsd > h.estimatedUsd && p.agentSeconds > h.agentSeconds)
    return 'joint-loss';
  return p.estimatedUsd > h.estimatedUsd ? 'cost-loss' : 'speed-loss';
}
export async function jointAudit(study) {
  const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
  const plan = await read(join(study, 'plan.json'));
  const execution = await read(join(study, 'execution.json'));
  const rates = plan.scenario.usdPerMillion;
  const cases = [];
  for (const item of plan.schedule) {
    const state = execution.pairs.find((p) => p.id === item.id);
    const directory = join(study, 'cases', item.id);
    const optional = async (name) =>
      read(join(directory, name)).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
    const rows = await optional('results.json');
    const costs = await optional('cost-scenario.json');
    const arms = {};
    for (const arm of ['proxy', 'headroom']) {
      const row = rows?.find((r) => r.arm === arm);
      const cost = costs?.measured.find((r) => r.arm === arm);
      let ledger = [];
      if (row && state?.raw) {
        ledger = (
          await readFile(
            join(state.raw, `${row.task}-${row.rep}-${arm}`, 'ledger.jsonl'),
            'utf8'
          ).catch((e) => {
            if (e.code === 'ENOENT') return '';
            throw e;
          })
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map(JSON.parse)
          .filter((r) => r.path?.endsWith('/responses'));
      }
      const timed =
        ledger.length > 0 &&
        ledger.every((r) => r.timing && Number.isFinite(r.timing.upstreamMs));
      const timing = timed
        ? Object.fromEntries(
            ['transformMs', 'upstreamHeadersMs', 'upstreamMs'].map((k) => [
              k,
              ledger.reduce((s, r) => s + (r.timing[k] ?? 0), 0),
            ])
          )
        : null;
      arms[arm] = {
        verdict: cost?.verdict ?? 'MISSING',
        estimatedUsd: cost?.estimatedUsd ?? null,
        agentSeconds: row?.agentSeconds ?? null,
        startupInclusiveSeconds: row?.seconds ?? null,
        usage: row?.usage ?? null,
        requests: row?.requests ?? null,
        failedTools:
          row?.completedTools?.filter((t) => t.status === 'failed').length ??
          null,
        timing,
        timingNote: timing
          ? 'Upstream includes network, provider queue/prefill/generation, and competitor proxy for HeadRoom; these are not individually identifiable.'
          : 'Older capture has no request timing; no causal speed attribution available.',
      };
    }
    const p = arms.proxy,
      h = arms.headroom;
    const components =
      p.usage && h.usage
        ? {
            inputVolumeUsd:
              ((p.usage.input - h.usage.input) * rates.uncached) / 1e6,
            cacheDiscountUsd:
              (-(p.usage.cached - h.usage.cached) *
                (rates.uncached - rates.cached)) /
              1e6,
            outputUsd: ((p.usage.output - h.usage.output) * rates.output) / 1e6,
          }
        : null;
    cases.push({
      id: item.id,
      family: item.family,
      seed: item.seed,
      classification: classifyPair(arms),
      arms,
      costComponents: components,
    });
  }
  const counts = (rows) =>
    Object.fromEntries(
      [
        'joint-win',
        'joint-loss',
        'cost-loss',
        'speed-loss',
        'tie',
        'quality-failure',
        'unknown',
      ].map((k) => [k, rows.filter((r) => r.classification === k).length])
    );
  return {
    scope:
      'All scheduled pairs; passing quality and strictly lower cost AND agent wall time required for a joint win. Cost components are arithmetic, not causal cache attribution.',
    counts: counts(cases),
    families: Object.fromEntries(
      [...new Set(cases.map((r) => r.family))].map((f) => [
        f,
        counts(cases.filter((r) => r.family === f)),
      ])
    ),
    cases,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await jointAudit(resolve(process.argv[2]));
  await writeFile(
    resolve(process.argv[3]),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' }
  );
  console.log(
    JSON.stringify(
      {
        counts: report.counts,
        families: report.families,
        losses: report.cases
          .filter((r) => r.classification !== 'joint-win')
          .map((r) => ({
            id: r.id,
            classification: r.classification,
            cost: [r.arms.proxy.estimatedUsd, r.arms.headroom.estimatedUsd],
            seconds: [r.arms.proxy.agentSeconds, r.arms.headroom.agentSeconds],
          })),
      },
      null,
      2
    )
  );
}
