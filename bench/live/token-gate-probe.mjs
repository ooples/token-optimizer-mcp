import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { tokenBenefit } from '../../dist/proxy/token-gate.js';
const before = 'a'.repeat(32768);
const after =
  'Repeated padding omitted; original retained in the supplied file.';
const rss = process.memoryUsage().rss;
const start = performance.now();
const accepted = tokenBenefit(before, after);
const result = {
  characters: before.length,
  accepted,
  ms: performance.now() - start,
  rssGrowth: process.memoryUsage().rss - rss,
};
if (process.argv[2])
  writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
