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
import { existsSync } from 'node:fs';

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
    else if (a === '--tasks') out.tasks = next().split(',').map((s) => s.trim()).filter(Boolean);
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
  --tasks a,b         run only these task ids (spend control)
  --report-only       re-render the existing store without running anything
`;

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
    const rows = loadRows(store);
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
    process.stdout.write(renderReport(report(rows), { adversarialTasks }) + '\n');
    return 0;
  }

  if (!existsSync(opts.credentials)) {
    process.stderr.write(`credentials not found at ${opts.credentials}\n`);
    return 1;
  }

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
    precision: opts.maxReps ? { maxReps: opts.maxReps } : undefined,
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
