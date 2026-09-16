/** Describe all measured local requests; no independent-sample CI claims. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const directory = resolve(process.argv[2]);
const data = JSON.parse(
  await readFile(join(directory, 'results.json'), 'utf8')
);
if (!data.complete || data.records.length !== 54)
  throw Error('Incomplete local comparison');
const seen = new Set();
for (const record of data.records) {
  const id = [record.round, record.arm, record.task, record.mode].join(':');
  if (seen.has(id) || record.samples.length !== data.repetitions)
    throw Error('Invalid measured group');
  seen.add(id);
  if (
    record.samples.some(
      (s) =>
        !Number.isFinite(s.milliseconds) ||
        s.milliseconds <= 0 ||
        s.sentBytes <= 0 ||
        s.forwardedBytes <= 0
    )
  )
    throw Error('Invalid sample');
}
const mean = (values) => values.reduce((n, v) => n + v, 0) / values.length;
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
const cases = [];
for (const task of ['logs', 'json', 'code'])
  for (const mode of ['repeated', 'unique']) {
    const arms = {};
    for (const arm of ['proxy', 'headroom', 'control']) {
      const groups = data.records.filter(
        (r) => r.task === task && r.mode === mode && r.arm === arm
      );
      const samples = groups.flatMap((r) => r.samples);
      const times = samples.map((s) => s.milliseconds);
      arms[arm] = {
        requests: samples.length,
        meanMs: mean(times),
        medianMs: quantile(times, 0.5),
        p95Ms: quantile(times, 0.95),
        processCpuMsPerRequest:
          groups.reduce((n, r) => n + r.processCpuMs, 0) / samples.length,
        meanSentBytes: mean(samples.map((s) => s.sentBytes)),
        meanForwardedBytes: mean(samples.map((s) => s.forwardedBytes)),
        sampledPeakPrivateBytes: Math.max(
          ...groups.flatMap((r) => [
            r.before.privateBytes,
            r.after.privateBytes,
          ])
        ),
        roundMeanMs: groups.map((r) =>
          mean(r.samples.map((s) => s.milliseconds))
        ),
      };
    }
    cases.push({
      task,
      mode,
      arms,
      latencyReductionPercent:
        100 * (1 - arms.proxy.meanMs / arms.headroom.meanMs),
      cpuReductionPercent:
        100 *
        (1 -
          arms.proxy.processCpuMsPerRequest /
            arms.headroom.processCpuMsPerRequest),
    });
  }
const summary = {
  complete: true,
  requests: data.records.reduce((n, r) => n + r.samples.length, 0),
  headroomOverrides: data.headroomOverrides,
  cases,
  memoryFootprint: Object.fromEntries(
    ['proxy', 'headroom', 'control'].map((arm) => [
      arm,
      Math.max(
        ...data.records
          .filter((r) => r.arm === arm)
          .flatMap((r) => [r.before.privateBytes, r.after.privateBytes])
      ),
    ])
  ),
  limitations: data.limitations,
};
await writeFile(
  join(directory, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n'
);
console.log(JSON.stringify(summary));
