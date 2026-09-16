import { matchAudits } from './report-validation.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { compressJsonFragments } from '../../dist/compress/json-fragments.js';
const raw = resolve(process.argv[2]),
  evidence = resolve(process.argv[3]);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const plan = await read(join(evidence, 'outer-followup-plan.json'));
const results = await read(join(raw, 'results.json'));
const audit = await read(join(raw, 'validation.json'));
const costs = await read(join(raw, 'cost-scenario.json'));
const replay = await read(join(evidence, 'outer-replay/replay.json'));
assert.equal(
  createHash('sha256')
    .update(await readFile('dist/compress/json-fragments.js'))
    .digest('hex'),
  replay.compiledSha256
);
assert.equal(results.length, 4);
assert.equal(audit.length, 4);
matchAudits(results, audit);
const rates = costs.scenario.usdPerMillion;
const cost = (u) =>
  ((u.input - u.cached) * rates.uncached +
    u.cached * rates.cached +
    u.output * rates.output) /
  1e6;
const arms = {},
  pairs = [];
for (const arm of plan.arms) {
  const rows = results.filter((r) => r.arm === arm);
  assert.deepEqual(rows.map((r) => r.seed).sort(), [
    plan.seedOffset + 1,
    plan.seedOffset + 2,
  ]);
  arms[arm] = {
    passes: audit.filter((r) => r.arm === arm && r.verdict === 'PASS').length,
    outerTruncated: rows.every((r) => r.read.outerTruncated === true),
    input: rows.reduce((s, r) => s + r.usage.input, 0),
    output: rows.reduce((s, r) => s + r.usage.output, 0),
    requests: rows.reduce((s, r) => s + r.requests, 0),
    agentSeconds: rows.reduce((s, r) => s + r.agentSeconds, 0),
    estimatedUsd: costs.valid
      ? rows.reduce((s, r) => s + cost(r.usage), 0)
      : null,
  };
}
for (const seed of [plan.seedOffset + 1, plan.seedOffset + 2]) {
  const p = results.find((r) => r.arm === 'proxy' && r.seed === seed);
  const h = results.find((r) => r.arm === 'headroom' && r.seed === seed);
  pairs.push({
    seed,
    proxyEstimatedUsd: costs.valid ? cost(p.usage) : null,
    headroomEstimatedUsd: costs.valid ? cost(h.usage) : null,
  });
}
const target = join(evidence, 'outer-live');
await mkdir(target, { recursive: true });
for (const file of [
  'manifest.json',
  'provenance.json',
  'results.json',
  'summary.json',
  'validation.json',
  'cost-scenario.json',
])
  await writeFile(join(target, file), await readFile(join(raw, file)), {
    flag: 'wx',
  });
const fragments = [];
for (const row of results.filter((r) => r.arm === 'proxy')) {
  const records = (
    await readFile(
      join(raw, `${row.task}-${row.rep}-${row.arm}`, 'requests.jsonl'),
      'utf8'
    )
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  const unique = new Set();
  for (const record of records) {
    if (!record.body.startsWith('{')) continue;
    for (const item of JSON.parse(record.body).input ?? [])
      for (const part of Array.isArray(item.output) ? item.output : []) {
        if (typeof part.text !== 'string' || unique.has(part.text)) continue;
        unique.add(part.text);
        const out = compressJsonFragments(part.text);
        if (out.text !== part.text)
          fragments.push({
            seed: row.seed,
            beforeChars: part.text.length,
            afterChars: out.text.length,
          });
      }
  }
}
const report = {
  scope: plan.scope,
  raw,
  valid:
    costs.valid &&
    audit.every((r) => r.verdict === 'PASS') &&
    Object.values(arms).every((a) => a.outerTruncated),
  arms,
  pairs,
  compressedOuterFragments: fragments,
  estimatedCostReduction: costs.valid
    ? 1 - arms.proxy.estimatedUsd / arms.headroom.estimatedUsd
    : null,
};
await writeFile(
  join(evidence, 'outer-summary.json'),
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(report, null, 2));
