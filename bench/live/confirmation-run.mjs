/** Executes the committed schedule once. No product tuning or winner stopping. */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyFreeze } from './confirmation-freeze.mjs';
import { continuationPrefix } from './confirmation-continuation.mjs';

const study = resolve(process.argv[2]);
const plan = JSON.parse(await readFile(join(study, 'plan.json'), 'utf8'));
const freeze = JSON.parse(await readFile(join(study, 'freeze.json'), 'utf8'));
await verifyFreeze(freeze);
const prefix = await continuationPrefix(study, plan, freeze);
const raw = await mkdtemp(join(tmpdir(), 'codex-confirmation-'));
const journal = {
  started: new Date().toISOString(),
  raw,
  plannedPairs: plan.pairs,
  pairs: prefix.pairs,
  continuation: prefix.continuation,
  status: 'running',
};
await writeFile(
  join(study, 'execution.json'),
  JSON.stringify(journal, null, 2) + '\n',
  { flag: 'wx' }
);
const save = () =>
  writeFile(
    join(study, 'execution.json'),
    JSON.stringify(journal, null, 2) + '\n'
  );
async function command(args, env, log, onLine = () => {}) {
  const out = createWriteStream(log + '.stdout'),
    err = createWriteStream(log + '.stderr');
  const child = spawn(process.execPath, args, {
    cwd: freeze.root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pending = '';
  child.stdout.on('data', (chunk) => {
    out.write(chunk);
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      onLine(line);
    }
  });
  child.stderr.pipe(err);
  const code = await new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', res);
  });
  await new Promise((res) => out.end(res));
  return code;
}
let consecutiveInfrastructureFailures = 0;
for (const pair of journal.pairs)
  consecutiveInfrastructureFailures = pair.infrastructureFailure
    ? consecutiveInfrastructureFailures + 1
    : 0;
try {
  if (consecutiveInfrastructureFailures >= 3)
    throw Error('Cannot resume an infrastructure-failure stop');
  for (const item of plan.schedule.slice(journal.pairs.length)) {
    await verifyFreeze(freeze);
    const stop = await readFile(join(study, 'STOP.json'), 'utf8').catch(
      (error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    );
    if (stop !== null) throw Error(`Operator checkpoint stop: ${stop}`);
    const caseRaw = join(raw, item.id),
      archived = join(study, 'cases', item.id);
    await mkdir(caseRaw, { recursive: true });
    await mkdir(archived, { recursive: true });
    const state = {
      id: item.id,
      family: item.family,
      started: new Date().toISOString(),
      status: 'running',
    };
    journal.pairs.push(state);
    await save();
    let campaign;
    const code = await command(
      ['bench/live/codex.mjs'],
      {
        TASKS: item.task,
        REPS: '1',
        ARMS: item.arms.join(','),
        SEED_OFFSET: String(item.seed - 1),
        READ_MODE: item.readMode,
        CASE_SUITE: plan.caseSuite,
        CODEX_BENCH_MODEL: plan.model,
        OUT: caseRaw,
      },
      join(caseRaw, 'runner'),
      (line) => {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        if (value.campaign) campaign = value.campaign;
        if (value.arm)
          console.log(
            JSON.stringify({
              case: item.id,
              arm: value.arm,
              verdict: value.verdict,
              seconds: value.agentSeconds,
              completedPairs: journal.pairs.filter(
                (p) => p.status === 'complete'
              ).length,
              plannedPairs: plan.pairs,
            })
          );
      }
    );
    state.runnerExit = code;
    state.raw = campaign;
    if (!campaign || code !== 0)
      throw Error(
        `Harness did not complete ${item.id}; retain partial artifacts`
      );
    const report = await command(
      ['bench/live/report-codex.mjs', campaign],
      {},
      join(caseRaw, 'audit')
    );
    const costs = await command(
      ['bench/live/codex-cost.mjs', campaign],
      {},
      join(caseRaw, 'cost')
    );
    // These codes mean an audited failure, not a crashed auditor. Keep the
    // attempt and continue the fixed schedule; missing artifacts still throw.
    if (![0, 1].includes(report) || ![0, 2].includes(costs))
      throw Error(`Evidence auditor failed for ${item.id}`);
    for (const name of [
      'manifest.json',
      'provenance.json',
      'results.json',
      'validation.json',
      'summary.json',
      'cost-scenario.json',
    ])
      await copyFile(join(campaign, name), join(archived, name));
    const audit = JSON.parse(
      await readFile(join(campaign, 'validation.json'), 'utf8')
    );
    state.verdicts = audit.map((r) => ({ arm: r.arm, verdict: r.verdict }));
    state.status = 'complete';
    state.finished = new Date().toISOString();
    await verifyFreeze(freeze);
    await save();
    if (audit.length === 2 && audit.every((r) => r.verdict === 'INVALID_READ'))
      throw Error(
        'Both arms failed initial exposure audit; stop incomplete for measurement review'
      );
    // The Codex auditor can retain a transport-level turn.failed as FAIL.
    // Recognize its client errors as infrastructure rather than relying only
    // on the verdict label (the completed v2 study exposed an upstream 503).
    state.infrastructureFailure = audit.some(
      (r) => r.verdict === 'PROVIDER_ERROR' || r.clientErrors?.length > 0
    );
    await save();
    consecutiveInfrastructureFailures = state.infrastructureFailure
      ? consecutiveInfrastructureFailures + 1
      : 0;
    if (consecutiveInfrastructureFailures >= 3)
      throw Error(
        'Three consecutive infrastructure-failed pairs; stop as incomplete, never retry into this sample'
      );
  }
  journal.status = 'complete';
  journal.finished = new Date().toISOString();
  await save();
} catch (error) {
  journal.status = 'incomplete';
  journal.error = String(error);
  await save();
  throw error;
}
console.log(
  JSON.stringify({ status: journal.status, raw, pairs: journal.pairs.length })
);
