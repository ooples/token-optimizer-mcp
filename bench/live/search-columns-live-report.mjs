import { reduction } from './report-validation.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { heldoutFixture } from './heldout-cases.mjs';
import { compressSearchResults } from '../../dist/compress/search.js';

const evidence = resolve(process.argv[2]);
const read = async (name) =>
  JSON.parse(await readFile(join(evidence, name), 'utf8'));
const runs = await read('live/results.json');
const audit = await read('live/validation.json');
const costs = await read('live/cost-scenario.json');
assert.equal(costs.valid, true);
assert.equal(runs.length, 8);
assert.equal(audit.length, 8);
assert.ok(audit.every((row) => row.verdict === 'PASS'));
const rates = costs.scenario.usdPerMillion;
const estimated = (usage) =>
  ((usage.input - usage.cached) * rates.uncached +
    usage.cached * rates.cached +
    usage.output * rates.output) /
  1e6;
const arms = {};
for (const arm of ['proxy', 'headroom']) {
  const selected = runs.filter((row) => row.arm === arm);
  assert.equal(selected.length, 4);
  assert.deepEqual(
    selected.map((row) => row.seed).sort(),
    [1900000301, 1900000302, 1900000303, 1900000304]
  );
  arms[arm] = {
    attempts: 4,
    input: 0,
    cached: 0,
    output: 0,
    requests: 0,
    agentSeconds: 0,
    seconds: 0,
    estimatedUsd: 0,
    firstRequestColdSensitivityUsd: 0,
    allInputUncachedSensitivityUsd: 0,
  };
  for (const row of selected) {
    for (const key of ['input', 'cached', 'output'])
      arms[arm][key] += row.usage[key];
    for (const key of ['requests', 'agentSeconds', 'seconds'])
      arms[arm][key] += row[key];
    const cost = estimated(row.usage);
    arms[arm].estimatedUsd += cost;
    arms[arm].firstRequestColdSensitivityUsd +=
      cost +
      (row.ledgerUsage[0].usage.cached_input_tokens *
        (rates.uncached - rates.cached)) /
        1e6;
    arms[arm].allInputUncachedSensitivityUsd +=
      (row.usage.input * rates.uncached + row.usage.output * rates.output) /
      1e6;
  }
}
const metrics = [
  'input',
  'output',
  'requests',
  'agentSeconds',
  'seconds',
  'estimatedUsd',
  'firstRequestColdSensitivityUsd',
  'allInputUncachedSensitivityUsd',
];
const reductions = Object.fromEntries(
  metrics.map((key) => [key, reduction(arms.proxy[key], arms.headroom[key])])
);
assert.ok(
  reductions.estimatedUsd === null
    ? costs.comparisons[0].reductionPercent === null
    : costs.comparisons[0].reductionPercent !== null &&
        Math.abs(
          reductions.estimatedUsd * 100 - costs.comparisons[0].reductionPercent
        ) < 1e-9
);
let byteIdentical = 0;
for (const group of ['fresh', 'replay']) {
  const prior = await read(`local/${group}/results.json`);
  for (const row of prior.rows.filter((row) => row.arm === 'proxy')) {
    const body = await read(`local/${group}/${row.seed}-proxy.json`);
    assert.equal(
      compressSearchResults(heldoutFixture('code', row.seed).content).text,
      body.input.find((item) => item.type === 'function_call_output').output
    );
    byteIdentical++;
  }
}
const result = {
  liveProductCommit: '3faf2289',
  allAuditsPass: true,
  arms,
  reductions,
  proxyCostWins: runs.filter(
    (row) =>
      row.arm === 'proxy' &&
      estimated(row.usage) <
        estimated(
          runs.find(
            (other) => other.arm === 'headroom' && other.seed === row.seed
          ).usage
        )
  ).length,
  allocationCleanup: {
    byteIdenticalCapturedOutputs: byteIdentical,
    currentSearchSha256: createHash('sha256')
      .update(await readFile('dist/compress/search.js'))
      .digest('hex'),
  },
  limitations: [
    'Four balanced development pairs on controlled code-search lookups, not broad confirmation.',
    'The first-request and all-input-uncached sensitivities keep observed behavior fixed; they are not measured cold-cache cohorts.',
    'Provider/cache conditions and seeds differ from previous runs; no live causal before/after attribution.',
  ],
};
await writeFile(
  join(evidence, 'live-summary.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(result, null, 2));
