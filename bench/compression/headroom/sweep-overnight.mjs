/**
 * WAIT FOR THE MACHINE TO GO QUIET, THEN SWEEP BOTH SERIALISATION ARMS.
 *
 * WHY UNATTENDED. The box this harness runs on also runs other people's builds,
 * test suites and agent sessions, and their engine is wall-clock budgeted: swept
 * on a busy machine it gives up mid-payload and passes content through
 * uncompressed, which changes their COLUMN, not just their clock. hr31 is what
 * that looks like -- sixteen Kompress time-budget warnings in a capture that
 * otherwise reads fine. So rather than picking a time and hoping, this waits for
 * the load gate to say yes and starts then.
 *
 * WHAT IT REFUSES TO PAPER OVER. A momentary dip is not a quiet machine, so the
 * gate has to say yes CONSECUTIVELY before anything starts; and any non-zero
 * exit from any sweep stops everything, because the alternative is three more
 * hours spent measuring against a handicapped opponent. What you find in the
 * morning is either a complete pair of captures or a partial one that says where
 * it stopped -- never a bad one that looks complete.
 *
 * ONE CORPUS, PINNED, ACROSS BOTH ARMS. Six of the eighteen workloads are their
 * fixtures, and their generators mint ids with uuid4, which no seed reaches --
 * so two sweeps of the same clone produce two different corpora on those rows,
 * at identical length and shape. Comparing a `default` sweep against a `compact`
 * one over drifting payloads would attribute the drift to the serialisation.
 * Both arms therefore run from ONE natives.json, built once from a previous
 * capture's per-chunk natives and reused verbatim, with the clone passed as `-`.
 * The snapshot is their fixture content, so it stays out of git.
 *
 * Usage:
 *   node bench/compression/headroom/sweep-overnight.mjs [--out hr32] [--chunks 6]
 *     [--corpus hr-corpus/natives-18.json] [--from hr31/warm] [--max-busy 0.1]
 *     [--deadline-hours 12] [--quiet-readings 3] [--poll-seconds 60]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sampleBusySync, loadRefusal, DEFAULT_MAX_BUSY } from '../machine-load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const OUT = flag('--out', 'hr32');
const CHUNKS = Number(flag('--chunks', '6'));
const CORPUS = flag('--corpus', path.join('hr-corpus', 'natives-18.json'));
const FROM = flag('--from', path.join('hr31', 'warm'));
const MAX_BUSY = Number(flag('--max-busy', String(DEFAULT_MAX_BUSY)));
const DEADLINE_MS = Number(flag('--deadline-hours', '12')) * 3600 * 1000;
const QUIET_READINGS = Number(flag('--quiet-readings', '3'));
const POLL_MS = Number(flag('--poll-seconds', '60')) * 1000;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (line) => console.log(`[${stamp()}] ${line}`);
const die = (line) => {
  console.error(`[${stamp()}] ${line}`);
  process.exit(1);
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// ---------------------------------------------------------------- the corpus
//
// BUILT ONCE, THEN NEVER AGAIN. If the file is already there it is used as-is,
// because the whole point is that every arm sees the same bytes; rebuilding it
// between arms would reintroduce exactly the drift it exists to remove.
const buildCorpus = () => {
  if (fs.existsSync(CORPUS)) {
    const held = Object.keys(JSON.parse(fs.readFileSync(CORPUS, 'utf8')));
    say(`corpus: reusing ${CORPUS} -- ${held.length} workload(s)`);
    return held;
  }
  if (!fs.existsSync(FROM)) die(`no corpus at ${CORPUS} and nothing to build it from at ${FROM}`);
  const merged = {};
  const parts = fs
    .readdirSync(FROM, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(FROM, e.name, 'natives.json'))
    .filter((p) => fs.existsSync(p))
    .sort();
  if (parts.length === 0) die(`${FROM} holds no chunk with a natives.json`);
  for (const p of parts) {
    const part = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [name, value] of Object.entries(part)) {
      // A NAME IN TWO CHUNKS IS A SPLIT THAT OVERLAPPED, and silently keeping
      // one of the two would publish a corpus nobody chose.
      if (name in merged) die(`${name} appears in more than one chunk of ${FROM}`);
      merged[name] = value;
    }
  }
  fs.mkdirSync(path.dirname(CORPUS), { recursive: true });
  fs.writeFileSync(CORPUS, JSON.stringify(merged, null, 2));
  const names = Object.keys(merged);
  say(`corpus: built ${CORPUS} from ${parts.length} chunk(s) -- ${names.length} workload(s)`);
  return names;
};

// ------------------------------------------------------------- waiting it out
//
// CONSECUTIVE, NOT CUMULATIVE. One reading under the ceiling is a gap between
// two builds; the run it would start lasts hours. The counter resets on any
// reading that fails, so the sweep begins only after the machine has been quiet
// continuously for QUIET_READINGS * POLL_MS.
const waitForQuiet = () => {
  const until = Date.now() + DEADLINE_MS;
  let consecutive = 0;
  // THE QUIETEST IT EVER GOT. The ceiling is a guard set from measurement on a
  // LOADED box; nobody has ever read this machine idle. If it turns out to idle
  // above the ceiling the wait burns the whole night and sweeps nothing, and the
  // only thing that makes that recoverable is knowing what number would have
  // worked. So the give-up message carries it.
  let quietest = Infinity;
  for (;;) {
    const sample = sampleBusySync(2000);
    const refusal = loadRefusal(sample, MAX_BUSY);
    const reading =
      'error' in sample
        ? sample.error
        : `${(sample.busyFraction * 100).toFixed(1)}% busy of ${sample.cores} core(s)`;
    if (!('error' in sample)) quietest = Math.min(quietest, sample.busyFraction);
    if (refusal === null) {
      consecutive += 1;
      say(`load ${reading} -- under the ${(MAX_BUSY * 100).toFixed(1)}% ceiling (${consecutive}/${QUIET_READINGS})`);
      if (consecutive >= QUIET_READINGS) return;
    } else {
      if (consecutive > 0) say(`load ${reading} -- back over the ceiling, counter reset`);
      else say(`load ${reading} -- waiting`);
      consecutive = 0;
    }
    if (Date.now() >= until) {
      die(
        `the machine never went quiet for ${QUIET_READINGS} consecutive reading(s) within ` +
          `${DEADLINE_MS / 3600000}h. Nothing was swept. The quietest reading in that ` +
          `whole window was ${quietest === Infinity ? 'never taken' : `${(quietest * 100).toFixed(1)}% busy`}` +
          `, against a ${(MAX_BUSY * 100).toFixed(1)}% ceiling -- if that floor is this box ` +
          'idling, raise --max-busy to just above it rather than waiting again.'
      );
    }
    sleep(POLL_MS);
  }
};

// ------------------------------------------------------------------ the sweeps
const sweepArm = (arm) => {
  const out = path.join(OUT, arm);
  const argv = [
    path.join(HERE, 'sweep-chunks.mjs'),
    '-',
    out,
    '--chunks',
    String(CHUNKS),
    '--paired',
    '--extra',
    CORPUS,
    '--separators',
    arm,
    '--max-busy',
    String(MAX_BUSY),
  ];
  say(`=== arm ${arm}: node ${argv.join(' ')}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  const minutes = Math.round((Date.now() - started) / 60000);
  if (r.status !== 0) {
    die(
      `arm ${arm} exited ${r.status} after ${minutes}m. Stopping -- what is on disk under ` +
        `${out} is partial and says where it stopped. Nothing after this arm was run.`
    );
  }
  say(`=== arm ${arm}: done in ${minutes}m -- ${out}/warm and ${out}/empty`);
};

const names = buildCorpus();
if (names.length === 0) die('the corpus is empty');
say(`waiting for a quiet machine (ceiling ${(MAX_BUSY * 100).toFixed(1)}%, deadline ${DEADLINE_MS / 3600000}h)`);
waitForQuiet();
for (const arm of ['default', 'compact']) sweepArm(arm);
say(`both arms landed under ${OUT}. Score each with head-to-head.mjs; do not --record until they agree on what they should agree on.`);