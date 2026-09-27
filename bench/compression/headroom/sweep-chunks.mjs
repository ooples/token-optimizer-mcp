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
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
const VALUED = new Set(['--chunks', '--extra', '--merge-into']);
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

if (CLONE === undefined || OUT === undefined || !Number.isInteger(N) || N < 1) {
  console.error(
    'usage: node bench/compression/headroom/sweep-chunks.mjs <clone|-> <out-dir> ' +
      '--chunks <n> [--extra <natives.json>] [--merge-into <dir>]'
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

fs.mkdirSync(OUT, { recursive: true });
const dirs = [];
const timings = [];
for (let i = 1; i <= N; i += 1) {
  const dir = path.join(OUT, `chunk${i}of${N}`);
  const sweptSeconds = run(
    PYTHON,
    [
      path.join(HERE, 'run-theirs.py'),
      CLONE,
      dir,
      '--chunk',
      `${i}/${N}`,
      ...(EXTRA === null ? [] : ['--extra', EXTRA]),
    ],
    `chunk ${i}/${N}: sweep`
  );
  // IMMEDIATELY, AND IN ITS OWN PROCESS. Every second between these two lines is
  // a second of the TTL spent, so nothing else goes here -- not a merge, not a
  // report, not the next chunk.
  const resolveSeconds = run(
    PYTHON,
    [path.join(HERE, 'resolve-theirs.py'), CLONE, dir],
    `chunk ${i}/${N}: resolve`
  );
  dirs.push(dir);
  timings.push({ chunk: `${i}/${N}`, sweptSeconds, resolveSeconds });
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
    `  chunk ${t.chunk}: swept ${t.sweptSeconds}s, resolved in ${t.resolveSeconds}s, ` +
      `oldest entry ${age === null ? 'unknown' : `${age}s`} -- ${verdict}`
  );
}

const merged = run(
  process.execPath,
  [path.join(HERE, '..', 'chunk-merge.mjs'), `--out=${MERGE_INTO}`, ...dirs],
  'merge'
);
void merged;

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
