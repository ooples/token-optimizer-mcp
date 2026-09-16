import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const rows = JSON.parse(await readFile(new URL('results.json', root), 'utf8'));
const audit = JSON.parse(await readFile(new URL('validation.json', root), 'utf8'));
const valid = rows.filter(r => r.arm === 'proxy' && audit.some(a => a.arm === r.arm && a.rep === r.rep && a.verdict === 'PASS') && rows.some(h => h.arm === 'headroom' && h.rep === r.rep && audit.some(a => a.arm === h.arm && a.rep === h.rep && a.verdict === 'PASS'))).map(r => r.rep);
const costs = r => ((r.usage.input-r.usage.cached)*10+r.usage.cached+r.usage.output*50)/1e6;
const sum = (rs, fn) => rs.reduce((n,r) => n + fn(r),0);
const arms = {};
for (const arm of ['proxy','headroom']) {
  const selected = rows.filter(r => r.arm === arm && valid.includes(r.rep));
  arms[arm] = {
    estimatedUsd: sum(selected,costs), input: sum(selected,r=>r.usage.input),
    requests: sum(selected,r=>r.requests), agentSeconds:sum(selected,r=>r.agentSeconds),
    coldFirstSensitivityUsd:sum(selected,r=>costs(r)+r.ledgerUsage[0].usage.cached_input_tokens*9/1e6),
  };
}
const reductions = Object.fromEntries(Object.keys(arms.proxy).map(k=>[k,100*(1-arms.proxy[k]/arms.headroom[k])]));
const report = { scope:'Descriptive three fully measured pairs only; not confirmation and not the full campaign cost',plannedPairs:4,measuredPairs:valid.length,excludedPairs:[1],attempts:8,proxyPasses:3,headroomPasses:4,missingCostAttempt:'proxy rep 1: upstream 503 after initial read; partial provider ledger retained, total cost unknown',arms,reductionsPercent:reductions,pairCostRatios: valid.map(rep=>({rep,ratio:costs(rows.find(r=>r.rep===rep&&r.arm==='proxy'))/costs(rows.find(r=>r.rep===rep&&r.arm==='headroom'))}))};
await writeFile(new URL('descriptive.json',root),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
