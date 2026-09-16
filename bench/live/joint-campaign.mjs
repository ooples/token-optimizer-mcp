/** Archive a development campaign and classify every task/repetition. */
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { classifyPair } from './joint-audit.mjs';
const raw = resolve(process.argv[2]),
  out = resolve(process.argv[3]);
const read = async (name) =>
  JSON.parse(await readFile(join(raw, name), 'utf8'));
const rows = await read('results.json'),
  costs = await read('cost-scenario.json'),
  manifest = await read('manifest.json');
const pairs = [];
for (const task of manifest.tasks)
  for (let rep = 1; rep <= manifest.reps; rep++) {
    const arms = {};
    for (const arm of ['proxy', 'headroom']) {
      const row = rows.find(
        (r) => r.task === task && r.rep === rep && r.arm === arm
      );
      const cost = costs.measured.find(
        (r) => r.task === task && r.rep === rep && r.arm === arm
      );
      arms[arm] = {
        verdict: cost?.verdict ?? 'MISSING',
        estimatedUsd: cost?.estimatedUsd ?? null,
        agentSeconds: row?.agentSeconds ?? null,
        requests: row?.requests ?? null,
      };
    }
    pairs.push({ task, rep, arms, classification: classifyPair(arms) });
  }
await mkdir(out, { recursive: true });
for (const name of [
  'manifest.json',
  'provenance.json',
  'results.json',
  'summary.json',
  'validation.json',
  'cost-scenario.json',
])
  await copyFile(join(raw, name), join(out, name), 1);
await writeFile(
  join(out, 'joint-pairs.json'),
  JSON.stringify(
    {
      raw,
      scope: 'Development cases, no confidence-backed confirmation claim.',
      pairs,
    },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(pairs, null, 2));
