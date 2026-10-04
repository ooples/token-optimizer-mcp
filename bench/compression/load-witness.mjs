/**
 * IS THE MACHINE THE SAME MACHINE IT WAS WHEN THE OTHER SIDE WAS TIMED?
 *
 * WHAT FORCED THIS FILE. The same recording, run twice minutes apart against the
 * same capture, produced these medians for our own engine:
 *
 *   agent-loop-logs   48.7ms -> 108.0ms   +122%
 *   sre-debugging     44.1ms ->  83.9ms    +90%
 *   agent-loop        22.9ms ->  42.2ms    +84%
 *   browser-session   80.4ms -> 133.7ms    +66%
 *   grep-output        5.4ms ->   7.2ms    +33%
 *
 * All twelve rows moved, by 33% to 122%, with no change to the code under test.
 * And the three-pass jitter band saw none of it: run one's passes were 25/22/22,
 * 49/48/47, 83/79/80 -- tight, healthy, and all three equally contaminated,
 * because passes inside one run share the ambient load. A band computed from
 * them measures the spread of a load level, not the load level itself.
 *
 * Their arms are timed by run-theirs.py, in a Python process, at whatever hour
 * the sweep ran. Ours are timed by head-to-head.mjs, in a Node process, later. A
 * difference of 33% to 122% between two of our own runs is larger than most of
 * the margins the speed criterion decides, so a cross-session comparison with no
 * load control is decided by the machine, not by either engine.
 *
 * WHAT THIS MEASURES. A fixed integer-mixing loop -- no allocation, no I/O, no
 * dependence on the payload or on either engine -- timed the same way from both
 * sides. It is deliberately NOT a Python witness and a JavaScript witness whose
 * numbers would be incomparable: run-theirs.py spawns THIS script, exactly as
 * head-to-head.mjs does, so both sessions record readings of the same work by
 * the same runtime and the two can be held against each other directly.
 *
 * WHY THE MEDIAN OF INTERLEAVED READINGS, NOT THE MINIMUM. The minimum is the
 * best estimator of what the machine CAN do, and the wrong one here: a briefly
 * idle moment on a loaded machine yields a clean minimum while the long
 * benchmark beside it runs slow throughout. What has to be detected is load
 * SUSTAINED across the run, so callers take a reading before each pass and the
 * median over all of them is the session's witness.
 *
 * THE CHECKSUM IS NOT DECORATION. A witness whose loop was shortened, hoisted or
 * optimised away would report a small number and read as a quiet machine -- the
 * failure that makes every contaminated run look clean. The expected checksum is
 * asserted on every invocation, so the work provably happened.
 */

/** Iterations tuned so one reading is roughly 45ms on this machine -- long enough
 *  to average over a scheduler quantum, short enough that a caller can afford one
 *  reading per pass. The absolute number does not matter; what matters is that it
 *  is the SAME work on both sides, and that it is stable: two invocations on a
 *  quiet machine read 43.412 and 43.389. */
const ITERATIONS = 40_000_000;

/** FNV-1a over the iteration index. Any change to the loop changes this. */
const EXPECTED = 3778163653;

export function witnessOnce() {
  const t0 = process.hrtime.bigint();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < ITERATIONS; i++) {
    h ^= i;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, checksum: h };
}

/**
 * `reps` readings, their median, and the checksum every one of them produced.
 * Throws rather than returning a number when the loop did not do the work.
 */
export function witness(reps = 3) {
  const samples = [];
  let checksum = null;
  for (let i = 0; i < reps; i++) {
    const r = witnessOnce();
    if (r.checksum !== EXPECTED)
      throw new Error(
        `load witness checksum ${r.checksum} != ${EXPECTED}: the calibration loop ` +
          'did not run as written, so its time says nothing about machine load'
      );
    checksum = r.checksum;
    samples.push(r.ms);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    ms: sorted[Math.floor(sorted.length / 2)],
    samples,
    checksum,
    iterations: ITERATIONS,
  };
}

/**
 * THE BAND, AND WHY IT IS WHERE IT IS. Two sessions are comparable when their
 * witnesses agree; the question is how close counts as agreement. The
 * contamination this file exists to catch was 33% at its mildest, so a band has
 * to be well inside that or it admits exactly the runs that motivated it. 10% is
 * loose enough to survive ordinary scheduling noise on an otherwise quiet
 * machine and tight enough that a 33% shift in available CPU is refused.
 *
 * Returns `{ ok, detail }` and never throws: a missing witness on either side is
 * `ok: false`, because an unmeasured load is not a controlled one.
 */
export const WITNESS_BAND = 0.1;

export function witnessesAgree(ours, theirs, band = WITNESS_BAND) {
  const read = (v, which) => {
    if (v === null || v === undefined)
      return { ms: null, detail: `no ${which} load witness recorded` };
    const ms = typeof v === 'object' ? Number(v.ms) : Number(v);
    if (!Number.isFinite(ms) || ms <= 0)
      return { ms: null, detail: `${which} load witness is not a time (${String(ms)})` };
    return { ms, detail: '' };
  };
  const o = read(ours, 'our');
  const t = read(theirs, 'their');
  if (o.ms === null || t.ms === null)
    return { ok: false, detail: [o.detail, t.detail].filter(Boolean).join('; ') };
  const drift = Math.abs(o.ms - t.ms) / Math.min(o.ms, t.ms);
  const shown =
    `witness ours ${o.ms.toFixed(1)}ms / theirs ${t.ms.toFixed(1)}ms, ` +
    `drift ${(drift * 100).toFixed(1)}% (band ${(band * 100).toFixed(0)}%)`;
  return drift <= band
    ? { ok: true, detail: shown }
    : {
        ok: false,
        detail:
          shown +
          ' -- the two sides were timed on machines under different load, so ' +
          'neither engine is what the difference measures',
      };
}

// Run directly to print one session's witness as JSON. This is the entry point
// run-theirs.py spawns, so both sides read the same work through the same path.
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reps = Number.parseInt(process.argv[2] ?? '3', 10);
  process.stdout.write(JSON.stringify(witness(Number.isFinite(reps) ? reps : 3)) + '\n');
}
