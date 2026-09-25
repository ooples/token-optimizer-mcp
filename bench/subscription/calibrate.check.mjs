/**
 * PROVE THE SOLVER BEFORE TRUSTING A NUMBER THAT COMES OUT OF IT.
 *
 * `calibrate.mjs` will happily print weights. The question this file answers is
 * whether those weights mean anything -- and it answers it the only way that is
 * not circular: by generating observations from KNOWN weights, running the real
 * pipeline over them, and checking that what comes back is what went in.
 *
 * It spends nothing, touches no credential and reads no transcript. Every
 * fixture is synthetic and built in memory, so this runs in CI on a machine
 * that has never seen a Claude subscription.
 *
 * The cases are not arbitrary; each is a way the fit could be wrong while still
 * looking right:
 *
 *  1. RECOVERY -- with clean data the solver must return the weights that
 *     generated it. If this fails nothing else matters.
 *  2. THE QUANTUM -- the meter floors to whole percent. The estimates must stay
 *     inside their own error bars, every coordinate the rounding ruins must be
 *     REPORTED as ruined, and the fitted noise must match what quantisation
 *     actually produces.
 *  3. UNIDENTIFIABILITY -- a coordinate no observation moved must come back
 *     named as unidentifiable, never as a number. This is the failure mode that
 *     produced the constants this whole rig exists to replace.
 *  3b. COLLINEARITY -- two coordinates that only ever moved together must not
 *     be handed an arbitrary split of their shared effect.
 *  4. UNOBSERVED BASELINE -- usage the transcripts cannot see must bias the
 *     LEVEL fit and cancel in the DELTA fit. That is the stated reason deltas
 *     are the default, so it has to be demonstrated rather than asserted.
 *  5. RESETS -- a pair of readings that straddles a window rollover is not an
 *     experiment and must never become a row.
 *  6. RESETS_AT JITTER -- and the converse: `resets_at` drifts by milliseconds
 *     between reads, which must NOT be mistaken for a rollover. This one was
 *     found by running the rig, not by reasoning about it.
 */

import {
  buildRows,
  fit,
  bracketAgreement,
  coordName,
  imprecise,
  sameWindowInstance,
} from './calibrate.mjs';
import { KINDS, zeroTotals } from './transcripts.mjs';

const WINDOW = 'five_hour';
const RESETS = '2026-09-25T15:29:59.839Z';

/** Weights chosen to look nothing like the asserted price list, so a solver
 *  that quietly returns the asserted values instead of solving would fail. */
const TRUTH = {
  [coordName('opus', 'input')]: 3.0e-6,
  [coordName('opus', 'cacheWrite1h')]: 6.6e-6,
  [coordName('opus', 'cacheRead')]: 0.24e-6,
  [coordName('opus', 'output')]: 21.0e-6,
};

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Build a run of observations from a cumulative token path.
 *
 * `steps` are per-interval token increments; `baseline` is utilisation the
 * transcripts never see. `floorPercent` switches between the ideal instrument
 * and the real one.
 */
function synthesise(steps, { baseline = 0, floorPercent = true } = {}) {
  const cumulative = zeroTotals();
  let trueUtil = baseline;
  const out = [];
  const emit = (at) => {
    out.push({
      at,
      label: 'synthetic',
      rig: 1,
      windows: {
        [WINDOW]: {
          percent: floorPercent ? Math.floor(trueUtil) : trueUtil,
          resetsAt: RESETS,
          byFamily: { opus: { ...cumulative } },
          totals: { ...cumulative },
        },
      },
      quiet: { secondsSinceLastRequest: 600, requestsLast10Min: 0 },
    });
  };
  emit(new Date(Date.parse(RESETS) - 5 * 3600e3).toISOString());
  let t = 1;
  for (const step of steps) {
    for (const kind of KINDS) {
      cumulative[kind] += step[kind] ?? 0;
      trueUtil += (TRUTH[coordName('opus', kind)] ?? 0) * (step[kind] ?? 0);
    }
    cumulative.requests += step.requests ?? 1;
    emit(new Date(Date.parse(RESETS) - 5 * 3600e3 + t * 6 * 60e3).toISOString());
    t++;
  }
  return out;
}

/** Steps that vary the four live coordinates independently enough to be
 *  separable -- a real machine's steps are far more collinear, which is
 *  precisely why `calibrate.mjs` reports rank instead of assuming one. */
function independentSteps(n) {
  const steps = [];
  for (let i = 0; i < n; i++) {
    const s = 1 + ((i * 7) % 11);
    steps.push({
      input: 20000 * (1 + (i % 5)),
      cacheWrite1h: 120000 * s,
      cacheRead: 9000000 * (1 + ((i * 3) % 7)),
      output: 40000 * (1 + ((i * 2) % 4)),
    });
  }
  return steps;
}

// 1. RECOVERY. An unfloored meter and independent steps: the solver has to
//    return TRUTH to numerical precision, or it is not solving anything.
{
  const observations = synthesise(independentSteps(24), { floorPercent: false });
  const { rows } = buildRows(observations, { windowKey: WINDOW });
  const result = fit(rows);
  const worst = Math.max(
    ...Object.entries(TRUTH).map(([name, want]) =>
      Math.abs(((result.theta[name] ?? 0) - want) / want)
    )
  );
  check('recovers known weights from exact data', worst < 1e-6, `worst relative error ${worst.toExponential(2)}`);
  check('solves every live coordinate', result.rank === 4, `rank ${result.rank}`);
}

// 2. THE QUANTUM, AND THE UNCERTAINTY IT CREATES. The same path through a
//    flooring meter. The first draft of this case asserted every coordinate
//    landed within 25% of truth and it FAILED at 26.1% -- and the failure was
//    correct. `opus.input` contributes a fraction of a percentage point per
//    step while the rounding error is a whole one, so no estimator can pin it
//    down from 40 observations. That is a fact about the instrument, not a bug
//    to be tuned away, so the check now asserts what is actually true and what
//    a consumer needs:
//
//      (a) every estimate is within three standard errors of truth -- i.e. the
//          error bars are honest, which is the property that makes them usable;
//      (b) any coordinate that misses a 25% accuracy bar is REPORTED as
//          imprecise. A wrong number that announces itself is safe; a wrong
//          number that looks confident is how the price-list constants got
//          believed in the first place.
{
  const observations = synthesise(independentSteps(40), { floorPercent: true });
  const { rows } = buildRows(observations, { windowKey: WINDOW });
  const result = fit(rows);

  let covered = 0;
  const inaccurate = [];
  for (const [name, want] of Object.entries(TRUTH)) {
    const got = result.theta[name];
    const se = result.stderr[name];
    if (got === undefined || !(se > 0)) continue;
    if (Math.abs(got - want) <= 3 * se) covered++;
    if (Math.abs((got - want) / want) > 0.25) inaccurate.push(name);
  }
  const flagged = new Set(imprecise(result).map((w) => w.name));

  check(
    'every estimate is within three standard errors of truth',
    covered === Object.keys(TRUTH).length,
    `${covered}/${Object.keys(TRUTH).length} covered`
  );
  check(
    'every inaccurate coordinate is flagged as imprecise',
    inaccurate.every((name) => flagged.has(name)),
    inaccurate.length
      ? `inaccurate ${inaccurate.join(',')} | flagged ${[...flagged].join(',') || 'none'}`
      : 'none were inaccurate'
  );
  check(
    'the noise model matches quantisation (sd 0.41)',
    result.sigma > 0.2 && result.sigma < 0.7,
    `sigma ${result.sigma.toFixed(3)} pp`
  );
  const agree = bracketAgreement(rows, result.predictions);
  check(
    'most rows land inside the rounding band',
    agree.inside / agree.total > 0.8,
    `${agree.inside}/${agree.total}`
  );
}

// 3. UNIDENTIFIABILITY. `cacheWrite5m` never moves -- exactly the shape this
//    machine's data has. It must be NAMED, not numbered. A solver that returns
//    a confident value for an untouched coordinate is how a price-list constant
//    gets laundered into a measurement.
{
  const observations = synthesise(independentSteps(24), { floorPercent: false });
  const { rows } = buildRows(observations, { windowKey: WINDOW });
  const result = fit(rows);
  const name = coordName('opus', 'cacheWrite5m');
  const dropped = result.dropped.find((d) => d.name === name);
  check('names an untouched coordinate as unidentifiable', Boolean(dropped), dropped?.reason);
  check('publishes no weight for it', result.theta[name] === undefined);
}

// 3b. COLLINEARITY. Two coordinates moved in lockstep cannot be told apart. The
//     rank must drop and one of them must be reported, rather than the pair
//     being handed an arbitrary split of their shared effect.
{
  const steps = independentSteps(24).map((s) => ({ ...s, input: s.cacheWrite1h / 6 }));
  const observations = synthesise(steps, { floorPercent: false });
  const { rows } = buildRows(observations, { windowKey: WINDOW });
  const result = fit(rows);
  const collinear = result.dropped.filter((d) => d.reason.startsWith('collinear'));
  check('detects a lockstep pair', result.rank === 3 && collinear.length === 1, `rank ${result.rank}, dropped ${collinear.map((d) => d.name).join(',') || 'none'}`);
}

// 4. UNOBSERVED BASELINE. 9 percentage points of usage the transcripts cannot
//    see. Deltas must be unaffected; levels must be visibly wrong. This is the
//    justification for the default mode, so it is tested as a claim.
{
  const observations = synthesise(independentSteps(24), { baseline: 9, floorPercent: false });
  const relErr = (result) =>
    Math.max(
      ...Object.entries(TRUTH).map(([name, want]) =>
        Math.abs(((result.theta[name] ?? 0) - want) / want)
      )
    );
  const deltas = fit(buildRows(observations, { windowKey: WINDOW, mode: 'deltas' }).rows);
  const levels = fit(buildRows(observations, { windowKey: WINDOW, mode: 'levels' }).rows);
  check('deltas cancel an unobserved baseline', relErr(deltas) < 1e-6, `${relErr(deltas).toExponential(2)}`);
  check(
    'levels are biased by it, as documented',
    relErr(levels) > 0.01,
    `level fit is off by ${(relErr(levels) * 100).toFixed(1)}%`
  );
}

// 5. A RESET MUST NOT BECOME A ROW. When the window rolls over, utilisation
//    falls and the pair spans two different window instances. Pairing across it
//    would feed the fit a large negative movement against positive tokens.
{
  const observations = synthesise(independentSteps(6), { floorPercent: false });
  const after = JSON.parse(JSON.stringify(observations[observations.length - 1]));
  after.at = new Date(Date.parse(RESETS) + 60e3).toISOString();
  after.windows[WINDOW].resetsAt = '2026-09-25T20:29:59.839Z';
  after.windows[WINDOW].percent = 0;
  const { rows, skipped } = buildRows([...observations, after], { windowKey: WINDOW });
  check(
    'refuses a pair that straddles a reset',
    skipped.straddlesReset === 1 && rows.every((r) => r.y >= 0),
    `skipped ${skipped.straddlesReset}`
  );
}

// 6. RESETS_AT JITTER. Found by the first end-to-end run, not by reasoning.
//    The endpoint recomputes `resets_at` per request, so two reads minutes
//    apart differ by tens of milliseconds. Keying window identity on string
//    equality -- which is what the first version did -- discards every pair and
//    the rig silently reports "no data" forever. This pins the tolerance from
//    both sides: jitter must NOT split a window, and a real rollover must.
{
  const observations = synthesise(independentSteps(6), { floorPercent: false });
  const jittered = observations.map((o, i) => ({
    ...o,
    windows: {
      [WINDOW]: {
        ...o.windows[WINDOW],
        resetsAt: new Date(Date.parse(RESETS) + i * 74).toISOString(),
      },
    },
  }));
  const { rows, skipped } = buildRows(jittered, { windowKey: WINDOW });
  check(
    'millisecond jitter in resets_at does not split a window',
    skipped.straddlesReset === 0 && rows.length === observations.length - 1,
    `${rows.length} rows, ${skipped.straddlesReset} skipped`
  );
  check(
    'sameWindowInstance still rejects a real rollover',
    !sameWindowInstance(
      { resetsAt: RESETS },
      { resetsAt: new Date(Date.parse(RESETS) + 5 * 3600e3).toISOString() }
    ),
    'five hours later is a different window'
  );
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
