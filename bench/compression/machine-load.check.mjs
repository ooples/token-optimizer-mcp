/**
 * THE LOAD GATE, ON CASES WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * This exists because the instrument it replaces was blind. `load-witness.mjs`
 * times a single-threaded integer loop; measured, it read 45.49ms on the clean
 * hr30 capture, 45.77ms on hr31 (sixteen Kompress time-budget warnings) and
 * 44.19ms -- the fastest of the three -- on a box running forty MSBuild nodes,
 * two `dotnet test` runs and two mutation sweeps. An instrument that calls the
 * loaded box the quietest cannot gate anything, and it was believed for three
 * captures because nobody fed it a case whose answer was known.
 *
 * So every case here is synthetic: two `os.cpus()`-shaped readings whose busy
 * fraction is arithmetic, not whatever this machine happens to be doing. The
 * cases that carry the weight:
 *
 *  - `a quiet machine passes` / `a loaded machine is refused` -- the pair. One
 *    alone proves nothing: a function that always refuses passes the second.
 *  - `the loaded sample passes at a ceiling of 1` -- the positive control for
 *    that pair. The refusal above came from the LOAD, not from the function.
 *  - `no elapsed time is an error, not a quiet machine` -- the NaN trap. 0/0
 *    compared against any ceiling is false, which reads as fit, which is the
 *    exact failure this file exists to prevent.
 */

import { busySample, loadRefusal, DEFAULT_MAX_BUSY } from './machine-load.mjs';

let failures = 0;
const check = (cond, what, detail) => {
  if (cond) console.log(`ok   ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};

/** One core's cumulative counters. Only the total and `idle` are read. */
const times = (busy, idle) => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });

/** `cores` cores that each spent `busy` of every 1000 ticks doing work. */
const pair = (cores, busy) => ({
  before: Array.from({ length: cores }, () => times(0, 0)),
  after: Array.from({ length: cores }, () => times(busy, 1000 - busy)),
});

const quiet = pair(32, 20);
const qs = busySample(quiet.before, quiet.after);
check(!('error' in qs) && Math.abs(qs.busyFraction - 0.02) < 1e-9, 'a quiet machine reads 2% busy', JSON.stringify(qs));
check(loadRefusal(qs) === null, 'a quiet machine passes', String(loadRefusal(qs)));

const loaded = pair(32, 280);
const ls = busySample(loaded.before, loaded.after);
check(!('error' in ls) && Math.abs(ls.busyFraction - 0.28) < 1e-9, 'the measured loaded box reads 28% busy', JSON.stringify(ls));
const lr = loadRefusal(ls);
check(typeof lr === 'string' && lr.includes('28.0%'), 'a loaded machine is refused, with the number', String(lr));
check(typeof lr === 'string' && lr.includes('23.0 core(s) free'), 'and how many cores it left them', String(lr));

// THE POSITIVE CONTROL. Without this, a `loadRefusal` that returned a string
// unconditionally would pass every case above.
check(loadRefusal(ls, 1) === null, 'the loaded sample passes at a ceiling of 1', String(loadRefusal(ls, 1)));

// The ceiling is the only thing separating them, so it must be the thing that
// moves the verdict, in both directions.
check(loadRefusal(qs, 0.01) !== null, 'and the quiet sample is refused at a ceiling of 1%', String(loadRefusal(qs, 0.01)));
check(DEFAULT_MAX_BUSY > 0.02 && DEFAULT_MAX_BUSY < 0.24, 'the default ceiling sits between the two measured regimes', String(DEFAULT_MAX_BUSY));

const still = busySample([times(0, 0)], [times(0, 0)]);
check('error' in still && still.error.includes('no cpu time elapsed'), 'no elapsed time is an error, not a quiet machine', JSON.stringify(still));
check(String(loadRefusal(still)).includes('could not read machine load'), 'and the gate refuses on it rather than passing NaN', String(loadRefusal(still)));

const grew = busySample([times(0, 0)], [times(0, 0), times(0, 0)]);
check('error' in grew && grew.error.includes('core count changed'), 'a changed core count is refused', JSON.stringify(grew));

const back = busySample([times(0, 500)], [times(0, 100)]);
check('error' in back && back.error.includes('backwards'), 'counters that go backwards are refused', JSON.stringify(back));

check(String(loadRefusal(qs, 0)).includes('--max-busy'), 'a ceiling of 0 is refused as a bad flag', String(loadRefusal(qs, 0)));
check(String(loadRefusal(qs, 1.5)).includes('--max-busy'), 'so is a ceiling above 1', String(loadRefusal(qs, 1.5)));

console.log(failures === 0 ? 'machine-load: all checks passed' : `machine-load: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);