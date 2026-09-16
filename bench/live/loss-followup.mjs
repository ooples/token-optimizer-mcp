/** One fixed development follow-up of every original losing pair. No retries. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const study = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const original = await read(join(study, 'analysis.json'));
const cases = [];
for (const pair of original.pairs) {
  if (pair.arms.proxy.estimatedUsd <= pair.arms.headroom.estimatedUsd) continue;
  const manifest = await read(join(study, 'cases', pair.id, 'manifest.json'));
  cases.push({
    id: pair.id,
    family: pair.family,
    ...manifest,
    arms: [...manifest.arms].reverse(),
  });
}
await mkdir(evidence, { recursive: true });
const plan = {
  scope:
    'Development follow-up of all 13 original losses, with opposite arm order. One attempt per arm per case, no retries or selective replacement. Not independent confirmation.',
  cases,
};
await writeFile(
  join(evidence, 'followup-plan.json'),
  JSON.stringify(plan, null, 2) + '\n',
  { flag: 'wx' }
);
const run = (script, args, env = {}) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', () => done(null));
    child.on('exit', (code) => done(code));
  });
const execution = [];
for (const item of cases) {
  const out = join(tmpdir(), `codex-loss-followup-${Date.now()}-${item.id}`);
  console.log(`START ${item.id}`);
  const exit = await run('bench/live/codex.mjs', [], {
    OUT: out,
    ARMS: item.arms.join(','),
    REPS: '1',
    TASKS: item.tasks.join(','),
    SEED_OFFSET: String(item.seedOffset),
    CASE_SUITE: item.caseSuite,
    READ_MODE: item.readMode,
    CODEX_BENCH_MODEL: item.model,
  });
  const dirs = (
    await readdir(out, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })
  ).filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'));
  const raw = dirs.length === 1 ? join(out, dirs[0].name) : null;
  const auditExit = raw
    ? await run('bench/live/report-codex.mjs', [raw])
    : null;
  const costExit = raw ? await run('bench/live/codex-cost.mjs', [raw]) : null;
  const target = join(evidence, 'cases', item.id);
  await mkdir(target, { recursive: true });
  for (const file of [
    'manifest.json',
    'provenance.json',
    'results.json',
    'summary.json',
    'validation.json',
    'cost-scenario.json',
  ]) {
    if (!raw) break;
    try {
      await writeFile(join(target, file), await readFile(join(raw, file)), {
        flag: 'wx',
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  execution.push({
    id: item.id,
    raw,
    exit,
    auditExit,
    costExit,
    failure: raw ? null : 'Expected exactly one retained campaign',
    outputDirectory: out,
  });
  await writeFile(
    join(evidence, 'followup-execution.json'),
    JSON.stringify(execution, null, 2) + '\n'
  );
  console.log(
    `FINISHED ${item.id}: runner=${exit}, audit=${auditExit}, costs=${costExit}`
  );
}
