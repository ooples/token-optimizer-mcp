/** Descriptive report only; primary inference remains in frozen analyzer. */
import { readFile, writeFile } from 'node:fs/promises';
const study = 'bench/live/evidence/confirmation-2026-09-15-v2';
const plan = JSON.parse(await readFile(study + '/plan.json', 'utf8'));
const analysis = JSON.parse(await readFile(study + '/analysis.json', 'utf8'));
const execution = JSON.parse(await readFile(study + '/execution.json', 'utf8'));
if (execution.status !== 'complete') throw Error('Finished schedule required');
const excluded = analysis.issues.map(issue => issue.split(':')[0]);
const records = [];
for (const item of plan.schedule) {
  if (excluded.includes(item.id)) continue;
  const rows = JSON.parse(await readFile(`${study}/cases/${item.id}/results.json`, 'utf8'));
  for (const row of rows) records.push({ ...row, family: item.family, case: item.id });
}
function stats(rows) {
  const sum = (fn) => rows.reduce((s, r) => s + fn(r), 0);
  return {
    runs: rows.length,
    passes: rows.filter(r => r.verdict === 'PASS').length,
    requests: sum(r => r.requests),
    input: sum(r => r.usage.input), cached: sum(r => r.usage.cached), output: sum(r => r.usage.output),
    estimatedUsd: sum(r => ((r.usage.input-r.usage.cached)*10+r.usage.cached+r.usage.output*50)/1e6),
    agentSeconds: sum(r => r.agentSeconds), startupInclusiveSeconds: sum(r => r.seconds),
    firstCached: sum(r => r.ledgerUsage[0].usage.cached_input_tokens),
    firstZeroCacheRuns: rows.filter(r => r.ledgerUsage[0].usage.cached_input_tokens === 0).length,
  };
}
const output = { scope: 'Descriptive complete-pair subset only; excludes unmeasured attempts, no confirmatory inference', excludedCases: excluded, superiorityEstablished: analysis.superiorityEstablished };
for (const family of ['overall', ...plan.families]) {
  const scoped = family === 'overall' ? records : records.filter(r => r.family === family);
  const proxy = stats(scoped.filter(r => r.arm === 'proxy'));
  const headroom = stats(scoped.filter(r => r.arm === 'headroom'));
  const reductionsPercent = {};
  for (const key of ['estimatedUsd','requests','input','output','agentSeconds','startupInclusiveSeconds'])
    reductionsPercent[key] = 100*(1-proxy[key]/headroom[key]);
  output[family] = { proxy, headroom, reductionsPercent };
}
await writeFile(study + '/descriptive.json', JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output));
