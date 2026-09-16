/** CPU/allocation replay of captured proxy requests, with no provider calls.
 * node --cpu-prof --heap-prof bench/live/profile-responses.mjs CAPTURE [ROUNDS]
 * Spill returns a fixed local reference: disk I/O and networking are excluded.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
const { compressResponses } = await import(
  process.env.RESPONSES_MODULE || '../../dist/proxy/responses.js'
);

const rounds = Number(process.argv[3] || 50);
if (!Number.isSafeInteger(rounds) || rounds < 1) throw Error('Invalid rounds');
const records = (await readFile(process.argv[2], 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse)
  .filter((r) => r.body);
const requests = records
  .map((r) => ({ body: Buffer.from(r.body), request: JSON.parse(r.body) }))
  .filter((r) => Array.isArray(r.request.input));
if (!requests.length) throw Error('No Responses requests');
const times = [];
const session = new Session();
session.connect();
await session.post('HeapProfiler.startSampling', {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
let checksum = 0;
const cpuBefore = process.cpuUsage();
const heapBefore = process.memoryUsage().heapUsed;
for (let round = 0; round < rounds; round++) {
  // A new proxy per round, stable spill identity within its conversation.
  const spill = () => '/profile-only/rows.json';
  for (const { body, request } of requests) {
    const start = performance.now();
    const result = compressResponses(body, request, spill);
    times.push(performance.now() - start);
    checksum += result.body.length;
  }
}
times.sort((a, b) => a - b);
const { profile } = await session.post('HeapProfiler.stopSampling');
session.disconnect();
if (process.env.ALLOCATION_PROFILE)
  await writeFile(process.env.ALLOCATION_PROFILE, JSON.stringify(profile));
console.log(
  JSON.stringify(
    {
      requests: requests.length,
      rounds,
      calls: times.length,
      meanMs: times.reduce((a, b) => a + b, 0) / times.length,
      p50Ms: times[Math.floor(times.length * 0.5)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      cpuMicros: process.cpuUsage(cpuBefore),
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      checksum,
      sampledAllocationBytes: profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0
      ),
      note: 'Heap delta is retained heap plus GC timing, not total allocated bytes; use the allocation profile. Disk I/O and network excluded.',
    },
    null,
    2
  )
);
