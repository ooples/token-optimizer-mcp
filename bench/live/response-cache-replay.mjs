import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { compressResponses } = await import(
  process.env.RESPONSES_MODULE || '../../dist/proxy/responses.js'
);
const raw = process.argv[2];
const requests = [];
for (const name of (await readdir(raw)).filter((x) => x.endsWith('-proxy'))) {
  for (const r of (await readFile(join(raw, name, 'requests.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse)
    .filter((r) => r.path.endsWith('/responses'))) {
    requests.push({ body: Buffer.from(r.body), request: JSON.parse(r.body) });
  }
}
if (!requests.length) throw Error('No matching Responses captures');
const spill = () => '/tmp/perf-recovery.txt';
const run = () =>
  requests.map(
    ({ body, request }) => compressResponses(body, request, spill).body
  );
const started = performance.now();
const outputs = run();
const coldMs = performance.now() - started;
run();
const samples = [];
for (let n = 0; n < 12; n++) {
  const start = performance.now();
  run();
  samples.push(performance.now() - start);
}
const result = {
  scope:
    'Local replay, twelve warm passes of the reported requestCount captured requests; not competitor performance or allocated-byte totals.',
  requestCount: requests.length,
  coldMs,
  warmMs: samples,
  warmMeanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
  outputSha256: outputs.map((x) =>
    createHash('sha256').update(x).digest('hex')
  ),
  memory: process.memoryUsage(),
};
await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    coldMs: result.coldMs,
    warmMeanMs: result.warmMeanMs,
    memory: result.memory,
  })
);
