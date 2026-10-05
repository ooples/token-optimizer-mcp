/**
 * MUST-WIN 2b, CHECKED ON READINGS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The criterion it guards is arithmetic over four measurements, and arithmetic
 * over measurements is exactly where a gate goes quietly wrong: a sign, a
 * quantile taken from the wrong end, a missing figure defaulted to zero. Each
 * of those failures reads as a pass, so each one has a case here whose right
 * answer is fixed before the function is called:
 *
 *  - an arm that wins the transform and forces no fetches wins at both ends
 *  - an arm that wins the transform and pays it back in fetches LOSES at p=1
 *  - a per-fetch figure that is needed and missing is never a pass
 *  - a per-fetch figure that is NOT needed, because the arm forces no round
 *    trips, must not be demanded
 *  - our slow reading is compared against their fast one, not median to median
 *  - the timed read really happened, so a per-fetch latency cannot be an elision
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latencyVerdict, measureOurFetch, slowEstimate, fastEstimate } from './fetch-latency.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok  ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));

/** `n` readings all of `ms`, so every quantile of the pass is exactly `ms`. */
const flat = (ms, n = 11) => Array.from({ length: n }, () => ms);
const passes = (ms) => [flat(ms), flat(ms), flat(ms)];

const base = {
  ourTransformPasses: passes(10),
  theirTransformPasses: passes(100),
  ourTurns: 0,
  theirTurns: 0,
  ourFetch: null,
  theirFetch: null,
};

// FASTER TO TRANSFORM AND NOTHING DEFERRED. The whole criterion reduces to 2a
// and we win it at both ends. This is also the case that would break if a
// missing per-fetch figure were demanded unconditionally: neither arm has one
// here, and neither arm needs one.
{
  const v = latencyVerdict(base);
  check(v.pass === true, 'no fetches on either side reduces to the transform', v.detail);
}

// THE CASE 2a CANNOT SEE. Same transform times -- we are ten times faster --
// but our arm moved four blocks out and each one costs 30ms to fetch back, so
// at full fetch we are at 130ms against their 100ms and we LOSE. An arm may not
// buy a transform win by deferring the work into retrievals nobody counted.
{
  const v = latencyVerdict({
    ...base,
    ourTurns: 4,
    ourFetch: { passes: passes(30) },
  });
  check(v.pass === false, 'a transform win paid back in fetches loses at p=1', v.detail);
  check(
    v.detail.includes('p0 10.0ms <= 100.0ms ok'),
    'and it says which end it lost at',
    v.detail
  );
}

// THE SAME ARITHMETIC IN THEIR DIRECTION. Their store lookup is what their
// ratio is bought with, so when it is their arm deferring, the fetches count
// against them and a transform loss of ours can still be a latency win.
{
  const v = latencyVerdict({
    ...base,
    ourTransformPasses: passes(150),
    theirTransformPasses: passes(100),
    theirTurns: 20,
    theirFetch: { passes: passes(5) },
  });
  check(v.pass === false, 'losing the transform still loses at p=0', v.detail);
  const both = latencyVerdict({
    ...base,
    ourTransformPasses: passes(150),
    theirTransformPasses: passes(160),
    theirTurns: 20,
    theirFetch: { passes: passes(5) },
  });
  check(both.pass === true, 'and their fetches count against them at p=1', both.detail);
}

// A NEEDED FIGURE THAT IS MISSING IS NEVER A PASS, in either direction, and the
// refusal names the side it was missing from rather than the criterion.
{
  const ours = latencyVerdict({ ...base, ourTurns: 3, ourFetch: null });
  check(ours.pass === null, 'our missing per-fetch figure refuses', ours.detail);
  check(ours.detail.includes('ours forces 3'), 'and names us', ours.detail);
  const theirs = latencyVerdict({ ...base, theirTurns: 7, theirFetch: null });
  check(theirs.pass === null, 'their missing per-fetch figure refuses', theirs.detail);
  check(theirs.detail.includes('theirs forces 7'), 'and names them', theirs.detail);
  const said = latencyVerdict({
    ...base,
    theirTurns: 7,
    theirFetch: { unmeasured: true, detail: 'their store served none of 7 marker(s)' },
  });
  check(said.pass === null, 'an explicitly unmeasured figure refuses', said.detail);
  check(said.detail.includes('served none'), 'and carries its own reason', said.detail);
  const onePass = latencyVerdict({
    ...base,
    theirTurns: 7,
    theirFetch: { passes: [flat(1)] },
  });
  check(onePass.pass === null, 'one pass cannot decide a per-fetch figure', onePass.detail);
}

// THE TRANSFORM STILL HAS TO BE REPEATED. 2b adds to 2a, it does not relax it.
{
  const v = latencyVerdict({ ...base, theirTransformPasses: [flat(100)] });
  check(v.pass === null, 'a single-pass transform refuses, as in 2a', v.detail);
  const none = latencyVerdict({ ...base, theirTransformPasses: null });
  check(none.pass === null, 'and an unrecorded one refuses too', none.detail);
}

// ROUND TRIPS THAT WERE NEVER RECORDED ARE NOT ZERO ROUND TRIPS. A capture from
// before the field existed would otherwise read as the arm that defers nothing,
// which is the strongest possible reading of our own column.
{
  const v = latencyVerdict({ ...base, theirTurns: null });
  check(v.pass === null, 'unrecorded round trips refuse', v.detail);
}

// OUR SLOW READING AGAINST THEIR FAST ONE, not median against median. Both arms
// sit at 100ms typical here; ours spends two readings of every eleven slow and
// theirs two fast. Medians would call this a tie and pass it; the stated rule
// fails it.
//
// TWO AND NOT ONE, and the difference is the jitter band rather than a detail of
// the fixture: nearest-rank p90 over eleven readings is the tenth of them, so a
// SINGLE spike in a pass does not move our estimate at all, and a single dip
// does not move theirs. That is deliberate -- one interference event should not
// decide a criterion -- and it is worth a fixture that would notice if the
// percentile were ever quietly replaced by a maximum.
{
  const spiky = [
    [...flat(100, 9), 400, 400],
    [...flat(100, 9), 400, 400],
    [...flat(100, 9), 400, 400],
  ];
  const dippy = [
    [40, 40, ...flat(100, 9)],
    [40, 40, ...flat(100, 9)],
    [40, 40, ...flat(100, 9)],
  ];
  check(
    slowEstimate([[...flat(100, 10), 400]]) === 100,
    'one spike in eleven does not move our estimate'
  );
  check(slowEstimate(spiky) > 100, 'our estimate reads the slow end', String(slowEstimate(spiky)));
  check(fastEstimate(dippy) < 100, 'their estimate reads the fast end', String(fastEstimate(dippy)));
  const v = latencyVerdict({
    ...base,
    ourTransformPasses: spiky,
    theirTransformPasses: dippy,
  });
  check(v.pass === false, 'so two arms at the same median do not tie', v.detail);
}
// THE MEASURER, AGAINST A REAL FILESYSTEM. It is the half of this file that
// produces a number rather than judging one, so what has to be shown is that
// the number came from somewhere: that every block was written and read back,
// that the passes are kept apart, and that an arm with nothing to fetch gets
// `null` rather than an empty distribution that would read as zero latency.
{
  const root = mkdtempSync(join(tmpdir(), 'to-fetch-latency-'));
  try {
    const io = {
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      write: (p, s) => writeFileSync(p, s, 'utf8'),
      read: (p) => readFileSync(p, 'utf8'),
      now: () => Number(process.hrtime.bigint()) / 1e6,
    };
    const blocks = [
      'a'.repeat(20000),
      JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, ok: true }))),
    ];
    const m = measureOurFetch({ blocks, root: join(root, 'spill'), passes: 3, repeats: 5 }, io);
    check(m !== null && m.passes.length === 3, 'three passes, kept apart', String(m?.passes.length));
    check(
      m.passes.every((xs) => xs.length === 5 * blocks.length),
      'every block is fetched in every repeat of every pass',
      m.passes.map((xs) => xs.length).join('/')
    );
    check(
      m.passes.flat().every((v) => Number.isFinite(v) && v >= 0),
      'and every reading is a finite non-negative duration'
    );
    check(m.chars === blocks.reduce((n, s) => n + s.length, 0), 'the bytes fetched are recorded');
    check(measureOurFetch({ blocks: [], root, passes: 2, repeats: 2 }, io) === null,
      'an arm that moved nothing out has no per-fetch figure, not a zero one');

    // A READ THAT CAME BACK EMPTY IS A BUG IN THE INSTRUMENT, NOT A FAST FETCH.
    // Without this the first misconfigured spill root would publish itself as a
    // per-fetch latency of nothing at all.
    let threw = null;
    try {
      measureOurFetch(
        { blocks: ['x'], root: join(root, 'blank'), passes: 2, repeats: 1 },
        { ...io, read: () => '' }
      );
    } catch (e) {
      threw = e;
    }
    check(threw !== null, 'an empty read throws rather than timing nothing', String(threw?.message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);