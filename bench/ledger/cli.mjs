#!/usr/bin/env node
/**
 * The one command.
 *
 *   node bench/ledger/cli.mjs --arms assist,assist-noseed
 *   node bench/ledger/cli.mjs --report-only
 *
 * PROVENANCE IS TAKEN FROM THE MACHINE, NOT FROM A FLAG. The image digest comes
 * from `docker image inspect` and the commit from `git rev-parse`, so a row
 * cannot claim a build it did not come from. An operator who could type the
 * digest could mistype it, and a mistyped digest is exactly the silent
 * build-mixing this harness was built to end.
 */

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { ARMS, loadArms } from './arms.mjs';
import { dockerExecutor } from './executor.mjs';
import { runCampaign } from './campaign.mjs';
import { loadRows, buildsPresent } from './store.mjs';
import { report } from './rank.mjs';
import { renderReport } from './render.mjs';
import { ADVERSARIAL, forTrack } from './tasks/index.mjs';
import { buildKey } from './provenance.mjs';

export function parseArgs(argv) {
  const out = {
    image: 'thol-rig:local',
    store: 'bench/ledger/results.jsonl',
    arms: ['assist'],
    tracks: ['cold', 'warm'],
    credentials: join(homedir(), '.claude', '.credentials.json'),
    model: null,
    armsFile: null,
    reportOnly: false,
    maxReps: null,
    // Cold tasks in flight at once. 1 keeps the historical behaviour; the cap
    // exists because the executor kills a run at 900s and a contended host is
    // the only way a cheap task reaches that, which would be charged as a
    // failure rather than recognised as harness overload.
    concurrency: 1,
    // A DEFAULT, NOT AN OPTION TO REMEMBER. The first version of this guard
    // read an undefined default, so `minutes < undefined` was false and the
    // check silently never fired -- a campaign launched on a five-minute token.
    // A safety default that must be passed to work is not a safety default.
    minCredentialMinutes: 45,
    ignoreExpiry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--image') out.image = next();
    else if (a === '--store') out.store = next();
    else if (a === '--arms') out.arms = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--tracks') out.tracks = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--credentials') out.credentials = next();
    else if (a === '--model') out.model = next();
    else if (a === '--arms-file') out.armsFile = next();
    else if (a === '--max-reps') out.maxReps = Number(next());
    else if (a === '--reps') {
      // The fixed-n switch. Distinct from --max-reps on purpose: that one is a
      // ceiling on an adaptive rule, this one turns the adaptive rule off.
      const n = Number(next());
      if (!Number.isInteger(n) || n < 2) throw new Error(`--reps must be an integer >= 2, got ${n}`);
      out.reps = n;
    }
    else if (a === '--concurrency') {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 6) {
        throw new Error(`--concurrency must be an integer 1..6, got ${n}`);
      }
      out.concurrency = n;
    }
    else if (a === '--tasks') out.tasks = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--min-credential-minutes') out.minCredentialMinutes = Number(next());
    else if (a === '--ignore-expiry') out.ignoreExpiry = true;
    else if (a === '--baseline') out.baseline = next();
    else if (a === '--endpoint') {
      const e = next();
      if (e !== 'usd' && e !== 'output') throw new Error(`--endpoint must be usd or output, got ${e}`);
      out.endpoint = e;
    }
    else if (a === '--report-only') out.reportOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE = `
Ledger -- cost per unit of work delivered, failures included.

  --arms a,b          arms to run besides control   (default: assist)
  --tracks cold,warm  tracks to run                 (default: both)
  --image NAME        container image               (default: thol-rig:local)
  --store PATH        row store                     (default: bench/ledger/results.jsonl)
  --credentials PATH  credentials to mount read-only
  --model NAME        model override
  --arms-file PATH    extra arm definitions as JSON
  --max-reps N        cap reps per task (spend control)
  --reps N            FIXED reps per task -- no early stopping. Use this for any
                      published comparison: the adaptive rule is optional
                      stopping and its intervals are too narrow.
  --concurrency N     cold tasks in flight at once, 1..6   (default: 1)
  --baseline ARM      compare every arm against ARM        (default: control)
  --endpoint usd|output   rank on dollars or output tokens (default: usd)
  --tasks a,b         run only these task ids (spend control)
  --ignore-expiry     run even if credentials expire soon (data may be worthless)
  --report-only       re-render the existing store without running anything
`;

/**
 * How long the mounted credentials remain valid.
 *
 * WHY THIS IS A PRE-FLIGHT CHECK AND NOT A NOTE. The CLI reports an expired
 * token as `{ subtype: "success", is_error: true, total_cost_usd: 0 }` and
 * exits 0. The executor classifies that correctly as a failed run -- but a
 * campaign that crosses an expiry does not stop: it records the remaining
 * hundred runs as failures at zero cost, and the report faithfully concludes
 * that every arm failed every task. The data is worthless and the campaign
 * looks like it completed.
 *
 * These tokens are short-lived by design, so a long campaign crossing one is
 * the expected case rather than bad luck. Returns null when the file has no
 * expiry, which is not an error -- an API key has none.
 */
export function credentialMinutesLeft(path, { now = Date.now, read = readFileSync } = {}) {
  try {
    const raw = JSON.parse(read(path, 'utf8'));
    const oauth = raw.claudeAiOauth || raw;
    const expiresAt = oauth.expiresAt ?? oauth.expires_at;
    if (!Number.isFinite(Number(expiresAt))) return null;
    return Math.round((Number(expiresAt) - now()) / 60000);
  } catch {
    return null;
  }
}

/** Reads the identity of what is being measured, from the machine itself. */
export function detectProvenance({ image, cwd = process.cwd(), run = execFileSync } = {}) {
  const imageDigest = String(
    run('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
  ).trim();
  const commitSha = String(run('git', ['-C', cwd, 'rev-parse', 'HEAD'])).trim();
  if (!imageDigest || !commitSha) throw new Error('could not determine image digest or commit');
  return { imageDigest, commitSha };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const store = resolve(opts.store);
  const adversarialTasks = new Set(ADVERSARIAL.map((t) => t.id));

  if (opts.reportOnly) {
    // `--tasks` narrows the battery here as well as during a run, because the
    // robustness checks a pre-registration asks for -- does the headline
    // survive dropping the task I authored last? -- are re-analyses of rows
    // already paid for. Doing them in a throwaway script is how a previous
    // analysis mixed two builds and bypassed the guard below; doing them here
    // keeps the guard.
    const all = loadRows(store);
    const rows = opts.tasks ? all.filter((r) => opts.tasks.includes(r.task)) : all;
    if (opts.tasks && all.length && !rows.length) {
      process.stdout.write(
        `no rows for task(s) ${opts.tasks.join(', ')} in ${store}\n` +
          `present: ${[...new Set(all.map((r) => r.task))].sort().join(', ')}\n`
      );
      return 1;
    }
    if (!rows.length) {
      process.stdout.write(`no rows in ${store}\n`);
      return 1;
    }
    const builds = buildsPresent(rows);
    if (builds.length > 1) {
      // Loud, and it does not guess which build was meant. Choosing one for the
      // operator is how a mixed store silently becomes a single number.
      process.stdout.write(
        `store holds ${builds.length} builds; summarise one at a time:\n` +
          builds.map((b) => `  ${b.build}  rows=${b.rows}  latest=${b.latest}`).join('\n') +
          '\n'
      );
      return 1;
    }
    // THE ANALYSIS MUST USE THE DESIGN THE DATA WAS COLLECTED UNDER. Without
    // this, rows gathered at a fixed n are re-judged by the adaptive rule at
    // report time: any cell whose interval is wider than the 10% target comes
    // back UNRESOLVED and is dropped from the headline, even though its rep
    // count was pre-registered and met in full. Observed on the large-context
    // run, where a completed 30-rep cell was excluded and the headline silently
    // covered 2 tasks of 3.
    const built = report(rows, {
      ...(opts.baseline ? { baseline: opts.baseline } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.reps ? { precision: { fixedReps: opts.reps } } : {}),
    });
    if (opts.baseline && !Object.values(built.tracks).some((t) => t.control)) {
      // A typo'd baseline would otherwise print an empty report, which reads
      // like "no difference" rather than "you named an arm that is not here".
      process.stdout.write(`no rows for baseline arm "${opts.baseline}" in ${store}\n`);
      return 1;
    }
    process.stdout.write(renderReport(built, { adversarialTasks }) + '\n');
    return 0;
  }

  if (!existsSync(opts.credentials)) {
    process.stderr.write(`credentials not found at ${opts.credentials}\n`);
    return 1;
  }

  const minutes = credentialMinutesLeft(opts.credentials);
  if (minutes !== null && minutes < opts.minCredentialMinutes && !opts.ignoreExpiry) {
    process.stderr.write(
      `credentials expire in ${minutes} min, which is less than the ${opts.minCredentialMinutes} ` +
        `this campaign needs.\nA campaign that crosses an expiry does not stop -- it records every ` +
        `remaining run as a failure at zero cost, and the report concludes that every arm failed ` +
        `every task.\nRefresh the credentials, or pass --ignore-expiry to proceed anyway.\n`
    );
    return 1;
  }
  if (minutes !== null) process.stdout.write(`credentials valid for ${minutes} min\n`);

  const arms = { ...ARMS, ...(opts.armsFile ? loadArms(opts.armsFile) : {}) };
  const { imageDigest, commitSha } = detectProvenance({ image: opts.image });

  const existing = loadRows(store).filter(
    (r) => buildKey(r) === buildKey({ image_digest: imageDigest, commit_sha: commitSha })
  );
  process.stdout.write(
    `image ${imageDigest.slice(0, 19)}  commit ${commitSha.slice(0, 8)}  ` +
      `${existing.length} row(s) already recorded for this build\n`
  );

  const execute = dockerExecutor({
    image: opts.image,
    credentials: opts.credentials,
    arms,
    model: opts.model,
  });

  const { report: built } = await runCampaign({
    arms,
    armNames: opts.arms,
    execute,
    storePath: store,
    imageDigest,
    commitSha,
    tracks: opts.tracks,
    tasksForTrack: opts.tasks
      ? (track) => forTrack(track).filter((t) => opts.tasks.includes(t.id))
      : undefined,
    precision:
      opts.reps || opts.maxReps
        ? {
            ...(opts.reps ? { fixedReps: opts.reps } : {}),
            ...(opts.maxReps ? { maxReps: opts.maxReps } : {}),
          }
        : undefined,
    concurrency: opts.concurrency,
    log: (line) => process.stdout.write(line + '\n'),
  });

  process.stdout.write('\n' + renderReport(built, { adversarialTasks }) + '\n');
  process.stdout.write(`\nraw rows: ${store}\n`);
  return 0;
}

// Only when invoked directly, so the module stays importable by tests.
if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exit(1);
    });
}

export { main };
