/** Descriptive complete-pair summaries; never repairs a failed inference gate. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const study = resolve(process.argv[2]);
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
      (arms[arm].input * 10 + arms[arm].output * 50) / 1e6;
  }
  return {
    pairs: pairs.length,
    arms,
    reductions: Object.fromEntries(
      [...fields, 'allInputUncachedSensitivityUsd'].map((key) => [
        key,
        1 - arms.proxy[key] / arms.headroom[key],
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
    'Frozen 10/1/50 USD per million token scenario. Uncached sensitivities hold observed model behavior fixed; not controlled cold-cache experiments.',
};
await writeFile(
  join(study, 'descriptive.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(result, null, 2));
