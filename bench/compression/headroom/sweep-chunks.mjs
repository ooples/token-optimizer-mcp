/**
 * DRIVING THEIR CAPTURE IN CHUNKS, EACH RESOLVED INSIDE THEIR WINDOW.
 *
 * Their CCR store serves a marker for a bounded time only -- their own resolver
 * quotes "CCR TTL: 1800 seconds" -- and a full roster sweep runs longer than
 * that. So a capture taken as one sweep and resolved afterwards asks about
 * entries that expired while it was still running, gets "Entry not found" for
 * them, and scores their retention at zero for what is really our sequencing.
 *
 * This driver fixes the sequencing rather than detecting the damage afterwards:
 * one chunk of the roster is swept, resolved immediately, and only then is the
 * next chunk started.
 *
 * THE RESOLVER RUNS AS ITS OWN PROCESS, DELIBERATELY. It imports their package
 * and reads their store through it, and doing that inside the sweeping process
 * would let one chunk's imports, warm model and in-process caches decide what a
 * later chunk sees. The process boundary is the only thing that makes each
 * resolution a fresh read, and it is cheap compared to the sweep beside it.
 *
 * STRICTLY SEQUENTIAL, for the same reason. Two chunks in parallel would write
 * their store concurrently, share the machine the load witness is measuring, and
 * make the per-chunk sweep durations -- the numbers that say whether a chunk fit
 * in the window at all -- meaningless.
 *
 * A FAILED CHUNK STOPS THE RUN. The merge would refuse an incomplete set anyway,
 * but stopping here names the chunk that failed while its output is still on
 * disk to look at, instead of reporting a coverage gap several minutes later.
 *
 * Usage:
 *   node bench/compression/headroom/sweep-chunks.mjs <clone|-> <out-dir> \
 *     --chunks <n> [--extra <natives.json>] [--merge-into <dir>]
 *
 * `--extra` wants the `natives.json` of a previous capture, never `payloads.json`:
 * run-theirs.py refuses the flattened form, because wrapping a conversation back
 * up as one tool result measures a shape no proxy produces.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sampleBusySync, loadRefusal, DEFAULT_MAX_BUSY } from '../machine-load.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
// EVERY FLAG THAT TAKES A VALUE CONSUMES THE NEXT ARGUMENT, so the positionals
// are what is left. Filtering on "the previous argument began with --" instead
// would read `--chunks 4 - out` as one positional, and silently swallow the
// clone path the moment a valueless flag is added.
const VALUED = new Set(['--chunks', '--extra', '--merge-into', '--separators', '--max-busy']);
const consumed = new Set();
args.forEach((a, i) => {
  if (VALUED.has(a)) {
    consumed.add(i);
    consumed.add(i + 1);
  } else if (a.startsWith('--')) consumed.add(i);
});
const positional = args.filter((_, i) => !consumed.has(i));
const CLONE = positional[0];
const OUT = positional[1];
const N = Number(flag('--chunks'));
const EXTRA = flag('--extra');
const MERGE_INTO = flag('--merge-into') ?? OUT;
const PAIRED = args.includes('--paired');
// PASSED THROUGH UNREAD. run-theirs.py owns the vocabulary and rejects anything
// it does not know, so validating it a second time here would only create a
// second place for the two lists to drift apart.
const SEPARATORS = flag('--separators');
// THE CEILING, AND THE ONLY WAY PAST IT. There is deliberately no boolean
// bypass: raising a number is explicit, quantified and printed into the log,
// where `--allow-loaded` would be a blanket that records nothing about how
// loaded the box actually was.
const MAX_BUSY = flag('--max-busy') === null ? DEFAULT_MAX_BUSY : Number(flag('--max-busy'));

if (CLONE === undefined || OUT === undefined || !Number.isInteger(N) || N < 1) {
  console.error(
    'usage: node bench/compression/headroom/sweep-chunks.mjs <clone|-> <out-dir> ' +
      '--chunks <n> [--paired] [--extra <natives.json>] [--merge-into <dir>] ' +
      '[--separators default|compact] [--max-busy <fraction>]'
  );
  process.exit(2);
}
if (EXTRA !== null && path.basename(EXTRA) === 'payloads.json') {
  console.error(
    'pass natives.json, not payloads.json: the flattened form hands their pipeline a ' +
      'whole conversation inside one tool result and measures a shape no proxy produces'
  );
  process.exit(2);
}

const PYTHON = process.env.BENCH_PYTHON ?? 'python';
const run = (cmd, argv, label) => {
  const started = Date.now();
  console.log(`\n=== ${label}`);
  console.log(`    ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit' });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (r.error !== undefined && r.error !== null) {
    console.error(`${label} could not start: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n${label} exited ${r.status} after ${seconds}s -- stopping here.`);
    console.error('The chunks already on disk are intact; fix this one and re-run it alone,');
    console.error('then merge with chunk-merge.mjs.');
    process.exit(1);
  }
  return seconds;
};

// THE SAME PATH run-theirs.py STAMPS, and the only three files SQLite keeps for it.
// A stale `-wal` left behind by an aborted sweep would overlay a store we just
// cleared, so it goes with the db rather than being left as a surprise.
const STORE = path.join(os.homedir(), '.headroom', 'ccr_store.db');
const clearStore = () => {
  const removed = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const file = STORE + suffix;
    if (!fs.existsSync(file)) continue;
    try {
      fs.rmSync(file);
      removed.push(path.basename(file));
    } catch (err) {
      // A HOLDER STOPS THE RUN. Their store refuses deletion while a process has it
      // open ("Device or resource busy"), and carrying on would sweep what is meant
      // to be the cold arm against a store still holding the previous chunk. That is
      // the one thing this mode exists to prevent, so it fails loudly instead.
      console.error(`
could not clear ${file}: ${err.message}`);
      console.error('Something still holds their store. Stopping rather than sweeping');
      console.error('a cold arm against a warm store.');
      process.exit(1);
    }
  }
  console.log(
    `    cleared their store: ${removed.length === 0 ? 'nothing to remove' : removed.join(', ')}`
  );
};

// IS THE BOX FREE ENOUGH TO MEASURE THEM ON? Their transform is wall-clock
// budgeted, so on a busy machine it gives up and passes content through
// uncompressed: their COLUMN changes, not just their clock. That has already
// happened once -- hr31 carries sixteen time-budget warnings -- and the
// instrument that was supposed to catch it, load-witness.mjs, read that capture
// as no busier than the clean one and read a forty-MSBuild-node box as quieter
// than both. It times one single-threaded loop, and on 32 cores that loop always
// gets a core. This reads idle time across all of them instead.
//
// IT GUARDS, IT DOES NOT PROVE. Only `competitorWarnings.degraded` can show a
// capture was clean, and that is already a hard refusal in run-theirs.py and in
// head-to-head.mjs. This is here so a four-hour sweep does not start on a box
// that was never going to produce one.
const requireQuietMachine = (when) => {
  const sample = sampleBusySync(2000);
  const refusal = loadRefusal(sample, MAX_BUSY);
  console.log(
    `    machine load ${when}: ${
      'error' in sample
        ? sample.error
        : `${(sample.busyFraction * 100).toFixed(1)}% busy of ${sample.cores} core(s)` +
          `, ceiling ${(MAX_BUSY * 100).toFixed(1)}%`
    }`
  );
  if (refusal === null) return;
  console.error(`\nNOT SWEEPING: ${refusal}`);
  console.error('Quiesce the box -- no other builds, test runs or agent sessions -- and');
  console.error('start again. If this machine has a permanent background service, raise the');
  console.error('ceiling explicitly with --max-busy <fraction>; there is no blanket bypass.');
  process.exit(1);
};

console.log('\n=== before anything is swept');
requireQuietMachine('at the start');
fs.mkdirSync(OUT, { recursive: true });
const dirs = [];
const timings = [];
/** One chunk swept and resolved into `dir`, with the resolve counted in its window. */
const sweepChunk = (i, dir, arm) => {
  const label = arm === null ? `chunk ${i}/${N}` : `chunk ${i}/${N} ${arm}`;
  const sweptSeconds = run(
    PYTHON,
    [
      path.join(HERE, 'run-theirs.py'),
      CLONE,
      dir,
      '--chunk',
      `${i}/${N}`,
      ...(EXTRA === null ? [] : ['--extra', EXTRA]),
      ...(SEPARATORS === null ? [] : ['--separators', SEPARATORS]),
    ],
    `${label}: sweep`
  );
  // IMMEDIATELY, AND IN ITS OWN PROCESS. Every second between these two lines is
  // a second of the TTL spent, so nothing else goes here -- not a merge, not a
  // report, not the next chunk.
  const resolveSeconds = run(
    PYTHON,
    [path.join(HERE, 'resolve-theirs.py'), CLONE, dir],
    `${label}: resolve`
  );
  dirs.push(dir);
  timings.push({ chunk: `${i}/${N}`, arm, sweptSeconds, resolveSeconds });
  return dir;
};

const coldDirs = [];
const warmDirs = [];
for (let i = 1; i <= N; i += 1) {
  // PER CHUNK, AND POINTEDLY NOT INSIDE sweepChunk. In paired mode the cold and
  // warm sweeps must follow each other with nothing in between -- every second
  // there is a second of their TTL -- so the reading is taken here, before the
  // clear, where it costs the experiment nothing.
  requireQuietMachine(`before chunk ${i}/${N}`);
  if (!PAIRED) {
    sweepChunk(i, path.join(OUT, `chunk${i}of${N}`), null);
    continue;
  }
  // COLD, WARM, IN THAT ORDER, WITH NOTHING BETWEEN THEM. The clear makes the cold
  // arm's label true; the second sweep follows the first with no gap, so the entries
  // it reads are the ones the first sweep just wrote -- minutes old against their
  // 1800s window, which is the only way this axis can be varied at all.
  console.log(`
=== chunk ${i}/${N}: clearing their store for the cold arm`);
  clearStore();
  coldDirs.push(sweepChunk(i, path.join(OUT, 'cold', `chunk${i}of${N}`), 'cold'));
  warmDirs.push(sweepChunk(i, path.join(OUT, 'warm', `chunk${i}of${N}`), 'warm'));
}

// WHETHER EACH CHUNK ACTUALLY FIT, read back from what the resolver wrote rather
// than from the clock this driver kept. The resolver ages the OLDEST entry of the
// chunk against the TTL their store quoted, and that is the number the scorer
// uses; a driver-side elapsed time would miss the warm-up and the import cost
// that sit inside the window too.
console.log('\n=== how each chunk sat inside their window');
let late = 0;
for (const t of timings) {
  const dir = dirs[timings.indexOf(t)];
  const p = path.join(dir, 'theirs-resolved.json');
  let prov = null;
  try {
    prov = JSON.parse(fs.readFileSync(p, 'utf8')).__provenance__ ?? null;
  } catch {
    prov = null;
  }
  const age = prov?.elapsedSecondsOldestEntry ?? prov?.elapsedSeconds ?? null;
  const ttl = prov?.theirStatedTtlSeconds ?? null;
  const verdict =
    prov === null
      ? 'NO RESOLUTION ON DISK'
      : prov.pastTheirTtl === true
        ? 'PAST THEIR TTL -- this chunk is unmeasured on retention'
        : ttl === null
          ? 'inside it, and their store refused nothing'
          : `inside their stated ${ttl}s`;
  if (prov === null || prov.pastTheirTtl === true) late += 1;
  console.log(
    `  chunk ${t.chunk}${t.arm === null ? '' : ` ${t.arm}`}: swept ${t.sweptSeconds}s, ` +
      `resolved in ${t.resolveSeconds}s, ` +
      `oldest entry ${age === null ? 'unknown' : `${age}s`} -- ${verdict}`
  );
}

// ONE MERGE PER ARM, and never one merge across both. A file holding a cold chunk
// beside a warm one would describe a capture that was never run, and the whole point
// of the pair is that each side is internally one instrument.
const merges = PAIRED
  ? [
      { label: 'merge (cold arm)', out: path.join(MERGE_INTO, 'empty'), parts: coldDirs },
      { label: 'merge (warm arm)', out: path.join(MERGE_INTO, 'warm'), parts: warmDirs },
    ]
  : [{ label: 'merge', out: MERGE_INTO, parts: dirs }];
for (const m of merges) {
  run(
    process.execPath,
    [path.join(HERE, '..', 'chunk-merge.mjs'), `--out=${m.out}`, ...m.parts],
    m.label
  );
}

// DO THE TWO ARMS ACTUALLY HOLD THE SAME CORPUS? The whole point of a paired
// sweep is that ONE variable moved, and the scorer enforces that by refusing a
// pair whose payload sets differ. It refused a real pair for exactly that reason:
// their fixtures mint ids with uuid4, which no seed reaches, so four of the six
// workloads they publish came out different on every sweep while staying the same
// length and shape. Nothing in the columns looked wrong; only the digest differed.
//
// THE COST OF FINDING THAT LATE IS THE REASON THIS IS HERE. The sweep is about
// ninety minutes and the refusal arrives after it, from a different script, so the
// failure reads as a scorer problem rather than as the corpus drifting under the
// experiment. Comparing the two payload files takes milliseconds and names the
// workloads that moved.
//
// IT IS THE SAME BYTES THE SCORER HASHES -- payloads.json of each merged arm --
// so this cannot pass while the scorer refuses. The per-workload breakdown is the
// part the scorer does not give, and it is what points at the generator.
if (PAIRED) {
  const digest = (p) =>
    crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  const emptyAt = path.join(MERGE_INTO, 'empty', 'payloads.json');
  const warmAt = path.join(MERGE_INTO, 'warm', 'payloads.json');
  const de = digest(emptyAt);
  const dw = digest(warmAt);
  console.log(`\n=== the two arms' corpus\n    cold ${de}\n    warm ${dw}`);
  if (de !== dw) {
    const a = JSON.parse(fs.readFileSync(emptyAt, 'utf8'));
    const b = JSON.parse(fs.readFileSync(warmAt, 'utf8'));
    const moved = Object.keys(a).filter(
      (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])
    );
    console.error(
      '\nthe two arms were swept over DIFFERENT payloads, so this pair cannot measure'
    );
    console.error('their store -- one variable did not move, two did.');
    console.error(`  drifted: ${moved.join(', ') || '(whole-file difference only)'}`);
    console.error('A workload that drifts at identical length is a generator minting ids');
    console.error('from an unseeded source; fix the generator, do not re-run and hope.');
    process.exit(1);
  }
  console.log('    identical, so the store is the only variable between the arms');
}

// SAID LAST, BECAUSE IT IS THE ONE THING THAT DECIDES WHETHER THIS CAPTURE CAN
// CARRY A RETENTION VERDICT. A chunk that went past their TTL still merges -- the
// merged file records the bound and `resolutionUsable` refuses those rows one by
// one -- but the run is not the clean capture it was started to be, and it should
// not take a successful-looking exit.
if (late > 0) {
  console.error(
    `\n${late} of ${N} chunk(s) did not answer inside their window. The merge is on disk ` +
      'and honest about it, but those rows are UNMEASURED on retention: re-run those ' +
      'chunks with a smaller --chunks, or fewer workloads per chunk.'
  );
  process.exit(1);
}
console.log(`\n${N} chunk(s) swept, resolved and merged into ${MERGE_INTO}, all inside their window.`);
