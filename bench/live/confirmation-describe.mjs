import { reduction } from './report-validation.mjs';
/** Descriptive complete-pair summaries; never repairs a failed inference gate. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const study = resolve(process.argv[2]);
const plan = JSON.parse(await readFile(join(study, 'plan.json'), 'utf8'));
const rates = plan.scenario.usdPerMillion;
for (const name of ['uncached', 'cached', 'output'])
  if (!Number.isFinite(rates[name]) || rates[name] < 0)
    throw Error(`Invalid recorded rate: ${name}`);
const analysis = JSON.parse(
  await readFile(join(study, 'analysis.json'), 'utf8')
);
const fields = [
  'estimatedUsd',
  'input',
  'cached',
  'output',
  'requests',
  'agentSeconds',
  'seconds',
  'firstRequestColdSensitivityUsd',
];
function summarize(pairs) {
  const arms = {};
  for (const arm of ['proxy', 'headroom']) {
    arms[arm] = Object.fromEntries(
      fields.map((key) => [
        key,
        pairs.reduce((total, pair) => total + pair.arms[arm][key], 0),
      ])
    );
    arms[arm].allInputUncachedSensitivityUsd =
      (arms[arm].input * rates.uncached + arms[arm].output * rates.output) /
      1e6;
  }
  return {
    pairs: pairs.length,
    arms,
    reductions: Object.fromEntries(
      [...fields, 'allInputUncachedSensitivityUsd'].map((key) => [
        key,
        reduction(arms.proxy[key], arms.headroom[key]),
      ])
    ),
    proxyCostWins: pairs.filter(
      (pair) => pair.arms.proxy.estimatedUsd < pair.arms.headroom.estimatedUsd
    ).length,
  };
}
const result = {
  scope:
    'Descriptive totals over fully measured pairs only. Failed/incomplete attempts remain in analysis.json; no confidence interval or superiority claim.',
  excludedPairs: analysis.issues,
  all: summarize(analysis.pairs),
  families: Object.fromEntries(
    [...new Set(analysis.pairs.map((pair) => pair.family))]
      .sort()
      .map((family) => [
        family,
        summarize(analysis.pairs.filter((pair) => pair.family === family)),
      ])
  ),
  sensitivity:
    'Recorded rate-card scenario. Uncached sensitivities hold observed model behavior fixed; not controlled cold-cache experiments.',
  scenario: plan.scenario,
};
await writeFile(
  join(study, 'descriptive.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(result, null, 2));
