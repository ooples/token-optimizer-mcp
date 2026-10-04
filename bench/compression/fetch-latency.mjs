/**
 * THE SESSION-LATENCY CRITERION (MUST-WIN 2b), AS A FUNCTION, PLUS THE
 * INSTRUMENT THAT MEASURES OUR HALF OF IT.
 *
 * 2a compares transform time. That is the whole of the wall clock only for an
 * arm that hands the agent everything it will need. Neither arm does: ours
 * moves whole blocks to a spill path, theirs writes a `<<ccr:...>>` reference
 * and keeps the bytes in its store, and either way a later turn that wants
 * those bytes pays a retrieval. 2a cannot see that, and an arm can win it by
 * deferring more work to the fetches it does not count.
 *
 * So 2b adds the fetches: modelled session milliseconds are the transform plus
 * the round trips the arm forces at the fetch rate, each round trip costing one
 * measured retrieval. At `p = 0` this is exactly 2a, which is why the criterion
 * is stated at both ends -- the p=0 end stops an arm buying a latency win by
 * compressing less, and the p=1 end stops one buying it by deferring more.
 *
 * WHAT IS MEASURED AND WHAT IS MODELLED, kept apart on purpose. Measured: the
 * transform times (by `run-theirs.py` and `head-to-head.mjs`), the per-fetch
 * latency of our spill read (`measureOurFetch` below), and the per-fetch
 * latency of their store lookup (`resolve-theirs.py`, through their own
 * resolver, inside their TTL). Modelled: nothing but the arithmetic that adds
 * them up. There is no assumed per-fetch figure anywhere in this file, and a
 * missing one is a refusal rather than a default -- an unmeasured criterion is
 * never a pass.
 *
 * THE DIRECTION OF EVERY ESTIMATE FAVOURS THEM, as in `speed-verdict.mjs`: our
 * transform and our per-fetch are taken at the 90th percentile, theirs at the
 * 10th, each within a pass and then medianed across passes. Interference can
 * only add time, so a noisy pass on their side lowers nothing and a noisy pass
 * on ours counts against us.
 */

import { quantile } from './speed-verdict.mjs';

/** Our pessimistic reading: the slow end within a pass, medianed across passes. */
export function slowEstimate(passes) {
  return quantile(passes.map((xs) => quantile(xs, 0.9)), 0.5);
}

/** Their optimistic reading: the fast end within a pass, medianed across passes. */
export function fastEstimate(passes) {
  return quantile(passes.map((xs) => quantile(xs, 0.1)), 0.5);
}

const usable = (passes) =>
  Array.isArray(passes) &&
  passes.length >= 2 &&
  passes.every((xs) => Array.isArray(xs) && xs.length > 0);

/**
 * Time our retrieval path on the content an arm actually moved out.
 *
 * NOT A REIMPLEMENTATION OF THE PATH. The proxy's sink writes each block to a
 * content-addressed file under the OS temp directory and the agent reads it
 * back with the tool it already has (`spillTo` in src/proxy/server.ts, whose
 * comment says in as many words: written, never read back by us). So the fetch
 * being timed here is one `readFileSync` of one real file holding the real
 * bytes -- the same operation, on the same sizes, on the machine the rest of
 * the row was measured on.
 *
 * The write is deliberately OUTSIDE the timed region. A fetch happens on a
 * later turn against a file that already exists; charging the write to it
 * would be charging the retrieval for work the compression already did, and
 * that work is already in the transform time.
 *
 * @param {object} r
 * @param {string[]} r.blocks the block contents the arm spilled
 * @param {string} r.root a directory this function may create and fill
 * @param {number} r.passes independent passes to keep apart
 * @param {number} r.repeats fetches of every block within a pass
 * @param {{write: (p: string, s: string) => void, read: (p: string) => string,
 *   mkdir: (p: string) => void, now: () => number}} io
 * @returns {{passes: number[][], blocks: number, chars: number}|null}
 */
export function measureOurFetch({ blocks, root, passes = 3, repeats = 11 }, io) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  io.mkdir(root);
  const paths = blocks.map((content, i) => {
    const at = `${root}/${i}-block.txt`;
    io.write(at, content);
    return at;
  });
  // ONE WARM READ PER FILE BEFORE THE CLOCK STARTS, and it is not a favour to
  // ourselves: their store lookup is timed against a SQLite file their own
  // resolver has already opened and pruned, so its pages are warm too. Timing
  // our side cold against theirs warm would be measuring the OS page cache and
  // reporting it as a difference between the two designs.
  for (const at of paths) io.read(at);
  const out = [];
  for (let pass = 0; pass < passes; pass++) {
    const samples = [];
    for (let rep = 0; rep < repeats; rep++) {
      for (const at of paths) {
        const t0 = io.now();
        const text = io.read(at);
        const t1 = io.now();
        // READ, AND PROVED TO HAVE BEEN READ. A read whose result is never
        // looked at is a read a runtime is free to elide, and a zero it
        // elided would publish as our per-fetch latency.
        if (text.length === 0) throw new Error(`spill read came back empty: ${at}`);
        samples.push(t1 - t0);
      }
    }
    out.push(samples);
  }
  return {
    passes: out,
    blocks: blocks.length,
    chars: blocks.reduce((n, s) => n + s.length, 0),
  };
}
/**
 * WHY A MISSING PER-FETCH FIGURE IS NOT ALWAYS A REFUSAL. An arm that moved
 * nothing out forces no round trips, so its per-fetch latency multiplies zero
 * at every fetch rate and never enters the arithmetic. Refusing the criterion
 * for want of a figure that cannot change the answer would mark our own
 * strongest case -- the arm that hands the agent everything -- as unmeasured.
 * So the figure is demanded exactly when the turns are non-zero, and the
 * refusal names which side it was missing from.
 */
function fetchNeeded(turns, fetch, side) {
  if (!(turns > 0)) return { need: false, why: null };
  if (fetch === null || fetch === undefined)
    return { need: true, why: `${side} forces ${turns} fetch(es) and none were timed` };
  if (fetch.unmeasured)
    return {
      need: true,
      why: `${side} per-fetch latency UNMEASURED: ${String(fetch.detail ?? 'no reason given')}`,
    };
  if (!usable(fetch.passes))
    return {
      need: true,
      why:
        `${side} per-fetch latency was timed in fewer than two passes, which ` +
        'cannot separate a reading from interference',
    };
  return { need: true, why: null };
}

/**
 * MUST-WIN 2b.
 *
 * @param {object} r
 * @param {number[][]|null} r.ourTransformPasses our transform, per pass
 * @param {number[][]|null} r.theirTransformPasses their transform, per pass
 * @param {number} r.ourTurns round trips our arm forces at full fetch
 * @param {number} r.theirTurns round trips their arm forces at full fetch
 * @param {{passes: number[][], unmeasured?: boolean, detail?: string}|null} r.ourFetch
 * @param {{passes: number[][], unmeasured?: boolean, detail?: string}|null} r.theirFetch
 * @param {number[]} r.ps the fetch rates the criterion is stated at
 * @returns {{pass: boolean|null, detail: string}}
 */
export function latencyVerdict({
  ourTransformPasses,
  theirTransformPasses,
  ourTurns,
  theirTurns,
  ourFetch,
  theirFetch,
  ps = [0, 1],
}) {
  if (!usable(ourTransformPasses) || !usable(theirTransformPasses))
    return {
      pass: null,
      detail:
        'transform time is not recorded in two or more passes on both arms, so ' +
        'the p=0 end of this criterion is the unrepeatable reading 2a already refuses',
    };
  if (!Number.isFinite(ourTurns) || !Number.isFinite(theirTurns))
    return { pass: null, detail: 'round trips UNRECORDED (re-run head-to-head)' };

  const mine = fetchNeeded(ourTurns, ourFetch, 'ours');
  const yours = fetchNeeded(theirTurns, theirFetch, 'theirs');
  const missing = [mine.why, yours.why].filter(Boolean);
  if (missing.length > 0) return { pass: null, detail: missing.join('; ') };

  const ourMs = slowEstimate(ourTransformPasses);
  const theirMs = fastEstimate(theirTransformPasses);
  // OURS SLOW, THEIRS FAST, on the fetch as on the transform. A per-fetch
  // figure is a distribution too: a disk read and a SQLite lookup both take
  // occasional spikes from whatever else the machine is doing.
  const ourPer = mine.need ? slowEstimate(ourFetch.passes) : 0;
  const theirPer = yours.need ? fastEstimate(theirFetch.passes) : 0;

  const at = ps.map((p) => {
    const ours = ourMs + p * ourTurns * ourPer;
    const theirs = theirMs + p * theirTurns * theirPer;
    return { p, ours, theirs, ok: ours <= theirs };
  });
  const shown = at
    .map(
      (a) =>
        `p${a.p} ${a.ours.toFixed(1)}ms <= ${a.theirs.toFixed(1)}ms ${a.ok ? 'ok' : 'NO'}`
    )
    .join('; ');
  return {
    pass: at.every((a) => a.ok),
    detail:
      `${shown} (transform ours p90 ${ourMs.toFixed(1)}ms vs theirs p10 ` +
      `${theirMs.toFixed(1)}ms; ${ourTurns} fetch(es) at ${ourPer.toFixed(3)}ms ` +
      `vs ${theirTurns} at ${theirPer.toFixed(3)}ms)`,
  };
}