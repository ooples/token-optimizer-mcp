/** Uses development data only for planning; never confirmation outcomes. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { standardScenario } from './codex-cost.mjs';
import { heldoutFixture, heldoutWorkflow } from './heldout-cases.mjs';
const directory = resolve(process.argv[2]);
const evidence = resolve('bench/live/evidence');
const pilot = [];
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) await scan(next);
    else if (entry.name === 'results.json') {
      let rows;
      try {
        rows = JSON.parse(await readFile(next, 'utf8'));
      } catch {
        continue;
      }
      if (!Array.isArray(rows)) continue;
      for (const ours of rows.filter(
        (r) => r.arm === 'proxy' && r.verdict === 'PASS'
      )) {
        const theirs = rows.find(
          (r) =>
            r.arm === 'headroom' &&
            r.task === ours.task &&
            r.rep === ours.rep &&
            r.verdict === 'PASS'
        );
        const cost = (r) =>
          r?.usage
            ? ((r.usage.input - r.usage.cached) * 10 +
                r.usage.cached +
                r.usage.output * 50) /
              1e6
            : NaN;
        if (cost(ours) > 0 && cost(theirs) > 0)
          pilot.push({
            file: next,
            task: ours.task,
            rep: ours.rep,
            logRatio: Math.log(cost(ours) / cost(theirs)),
          });
      }
    }
  }
}
await scan(evidence);
const families = [
  'logs',
  'json',
  'code',
  'bugfix',
  'refactor',
  'refresh',
  'mixed',
];
const groups = [...new Set(pilot.map((p) => p.task))].map((task) =>
  pilot.filter((p) => p.task === task)
);
const residualSum = groups.reduce((s, g) => {
  const m = g.reduce((n, p) => n + p.logRatio, 0) / g.length;
  return s + g.reduce((n, p) => n + (p.logRatio - m) ** 2, 0);
}, 0);
const pilotSd = Math.sqrt(
  residualSum / Math.max(1, pilot.length - groups.length)
);
const planningSd = Math.max(0.5, pilotSd);
const costPairs = Math.ceil(
  (((1.96 + 0.841621) * planningSd) / Math.log(0.95 / 0.8)) ** 2
);
const pairs = Math.ceil(Math.max(70, costPairs) / 14) * 14;
if (pairs > 210)
  throw Error(
    'Planning variance requires more than the predeclared 210-pair resource ceiling; revise before confirmation'
  );
let state = 0x9152026;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
};
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const schedule = [];
for (const family of families) {
  const orders = shuffle(
    Array.from({ length: pairs / 7 }, (_, i) =>
      i % 2 ? ['headroom', 'proxy'] : ['proxy', 'headroom']
    )
  );
  for (let i = 0; i < pairs / 7; i++) {
    const seed = 1000000 + Math.floor(random() * 1000000000);
    const task = family === 'mixed' ? 'refresh' : family;
    const f = ['logs', 'json', 'code'].includes(task)
      ? heldoutFixture(task, seed)
      : heldoutWorkflow(task, seed);
    schedule.push({
      id: `${family}-${i + 1}`,
      family,
      task,
      seed,
      arms: orders[i],
      readMode: family === 'mixed' ? 'mixed' : 'natural',
      caseSha256: createHash('sha256').update(JSON.stringify(f)).digest('hex'),
    });
  }
}
shuffle(schedule);
if (new Set(schedule.map((p) => p.caseSha256)).size !== schedule.length)
  throw Error('Duplicate generated case');
const plan = {
  version: 1,
  created: new Date().toISOString(),
  productCommit: '62c0b678',
  caseSuite: 'heldout-v1',
  model: 'gpt-6-astra',
  families,
  pairs,
  runs: 2 * pairs,
  pairsPerFamily: pairs / 7,
  pilot: {
    pairs: pilot.length,
    residualSd: pilotSd,
    planningSd,
    costPairs,
    sourcePolicy:
      'All comparable passing proxy/HeadRoom development pairs available before confirmation; mixed builds, excluded from final inference.',
    records: pilot,
  },
  sizing: {
    targetRatio: 0.8,
    superiorityMargin: 0.95,
    alphaTwoSided: 0.05,
    approximatePower: 0.8,
    minimumPairs: 70,
    maximumPairs: 210,
    note: 'Normal approximation on paired log costs is planning only. Family-balanced bootstrap and correctness gates decide the result.',
  },
  scenario: standardScenario,
  bootstrap: {
    resamples: 20000,
    seed: 9152026,
    method:
      'paired BCa bootstrap within each family; pairs remain intact; delete-one-pair jackknife acceleration',
  },
  success: {
    bothCostUpper95Below: 0.95,
    allProxyTasksPass: true,
    minimumOneSided95SuccessBound: 0.95,
    allAttemptsAccounted: true,
    allLedgersReconcile: true,
    artifactsFrozen: true,
  },
  schedule,
};
await writeFile(
  join(directory, 'plan.json'),
  JSON.stringify(plan, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(
  JSON.stringify({
    pilotPairs: pilot.length,
    pilotSd,
    planningSd,
    pairs,
    runs: 2 * pairs,
  })
);
