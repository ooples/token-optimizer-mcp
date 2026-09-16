import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const raw = resolve(process.argv[2]),
  destination = resolve(process.argv[3]);
const data = JSON.parse(await readFile(join(raw, 'results.json'), 'utf8'));
const groups = [];
for (const task of [...new Set(data.records.map((r) => r.task))])
  for (const mode of [...new Set(data.records.map((r) => r.mode))])
    for (const concurrency of [1, 8]) {
      const arms = {};
      for (const arm of ['proxy', 'headroom']) {
        const samples = data.records
          .filter(
            (r) =>
              r.task === task &&
              r.mode === mode &&
              r.concurrency === concurrency &&
              r.arm === arm
          )
          .flatMap((r) => r.samples);
        const times = samples.map((s) => s.ms).sort((a, b) => a - b);
        const mean = (key) =>
          samples.reduce((n, s) => n + s[key], 0) / samples.length;
        arms[arm] = {
          samples: samples.length,
          meanMs: mean('ms'),
          p95Ms:
            times[
              Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)
            ] ?? null,
          meanBytes: mean('forwardedBytes'),
          cacheKeyChanges: samples.filter((s) => s.cacheKeyPreserved === false)
            .length,
          outputChanges: samples.filter((s) => s.stableOutput === false).length,
        };
      }
      groups.push({
        task,
        mode,
        concurrency,
        arms,
        latencyWin: arms.proxy.meanMs < arms.headroom.meanMs,
        wireBytesWin: arms.proxy.meanBytes < arms.headroom.meanBytes,
        wireBytesTie: arms.proxy.meanBytes === arms.headroom.meanBytes,
      });
    }
const summary = {
  scope: data.scope,
  raw,
  complete: !data.error && data.records.length === (data.expectedGroups ?? 144),
  requests: data.records.reduce((n, r) => n + r.samples.length, 0),
  groups,
  latencyWins: groups.filter((g) => g.latencyWin).length,
  byteWins: groups.filter((g) => g.wireBytesWin).length,
  byteTies: groups.filter((g) => g.wireBytesTie).length,
};
await mkdir(destination, { recursive: true });
await copyFile(
  join(raw, 'results.json'),
  join(destination, 'raw-results.json'),
  1
);
await writeFile(
  join(destination, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(
  JSON.stringify(
    {
      complete: summary.complete,
      requests: summary.requests,
      groups: groups.length,
      latencyWins: summary.latencyWins,
      byteWins: summary.byteWins,
      byteTies: summary.byteTies,
      losses: groups.filter(
        (g) => !g.latencyWin || (!g.wireBytesWin && !g.wireBytesTie)
      ),
    },
    null,
    2
  )
);
