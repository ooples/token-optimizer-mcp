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
  bracketCap,
  buildRows,
  fit,
  rowCost,
  savingAsShareOfCap,
  bracketAgreement,
  coordName,
  imprecise,
  offsetSignature,
  capReport,
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

// ---------------------------------------------------------------------------
// 5. A SATURATED FIT HAS NO ERROR BARS, AND ZERO IS THE WRONG ONE TO PRINT.
//
// With as many identifiable coordinates as rows the solver passes exactly
// through every point. The residual is then 0 by construction, and dividing it
// by a degrees-of-freedom floor of 1 -- which is what this file failed to
// catch -- turns "no information about precision" into "+/- 0%", the most
// confident output the report can produce, in the one case that has earned
// none of it.
//
// The live rig hit exactly this: two observations, two coordinates, `+/- 0%`
// on both, one of them physically impossible (case 6). Nothing here tested a
// design with rows <= rank, which is why it shipped.
// ---------------------------------------------------------------------------
{
  const A = coordName('opus', 'cacheRead');
  const B = coordName('opus', 'cacheWrite1h');
  const mk = (a, b, y) => ({ x: new Map([[A, a], [B, b]]), y });

  const saturated = fit([mk(1000, 10, 1), mk(2000, 25, 3)]);
  check(
    'an exactly determined fit is reported as saturated, not as precise',
    saturated.saturated === true && saturated.rank === saturated.rows && saturated.dof === 0,
    `${saturated.rows} rows, rank ${saturated.rank}, dof ${saturated.dof}`
  );
  check(
    'its standard errors are undetermined rather than zero',
    Object.values(saturated.stderr).every((se) => !Number.isFinite(se)) &&
      Object.values(saturated.relativeStderr).every((r) => !Number.isFinite(r)) &&
      saturated.sigma === null,
    'sigma is null and every stderr is non-finite'
  );
  check(
    'so every coordinate is withheld as imprecise',
    imprecise(saturated).length === Object.keys(saturated.theta).length,
    `${imprecise(saturated).length} of ${Object.keys(saturated.theta).length} withheld`
  );
  check(
    'a zero residual on a saturated fit is not evidence of anything',
    saturated.residual === 0 && saturated.saturated === true,
    'residual 0 is forced by the design, so the flag is what a reader must see'
  );

  // The converse, so the guard is about degrees of freedom and not a blanket
  // refusal: more rows than coordinates, and the error bars come back.
  const spare = fit([mk(1000, 10, 1), mk(2000, 25, 3), mk(3000, 12, 2), mk(1500, 40, 4)]);
  check(
    'more rows than coordinates restores real error bars',
    spare.saturated === false &&
      spare.dof === 2 &&
      Object.values(spare.relativeStderr).every((r) => Number.isFinite(r) && r > 0),
    `dof ${spare.dof}, rel ` +
      Object.values(spare.relativeStderr)
        .map((r) => `${(r * 100).toFixed(0)}%`)
        .join(' / ')
  );

  // -------------------------------------------------------------------------
  // 6. A NEGATIVE WEIGHT IS IMPOSSIBLE, NOT MERELY SMALL.
  //
  // Utilisation is monotone non-decreasing in every token kind: spending a
  // cache read cannot hand quota back. An unconstrained least squares will
  // still return a negative weight whenever two coordinates move nearly in
  // lockstep and the meter's rounding breaks the proportion -- which is the
  // normal condition of this rig's data, not an exotic one. The sign is the
  // only surviving evidence that the design failed to separate them, so it
  // must reach the report; the magnitude looks like any other result.
  // -------------------------------------------------------------------------
  const negative = fit([mk(1000, 10, 1), mk(2000, 20, 2), mk(3000, 31, 2)]);
  const neg = Object.entries(negative.theta).filter(([, v]) => v < 0);
  check(
    'a negative weight is named as impossible, not published as a number',
    neg.length === 1 && negative.impossible.length === 1 && negative.impossible[0] === neg[0][0],
    `${negative.impossible.join(', ')} came back at ${neg[0]?.[1].toExponential(2)}`
  );
  check(
    'and carries no error bar, so nothing downstream can quote it as precise',
    !Number.isFinite(negative.relativeStderr[negative.impossible[0]]) &&
      imprecise(negative).some((w) => w.name === negative.impossible[0]),
    'relative stderr is undetermined and the coordinate is withheld'
  );
  check(
    'the two flags are independent -- this fit has a spare row and is still wrong',
    negative.saturated === false && negative.dof === 1 && negative.impossible.length === 1,
    `dof ${negative.dof}, saturated ${negative.saturated}`
  );
  check(
    'a well-posed fit raises neither flag',
    spare.impossible.length === 0 && spare.saturated === false,
    'no impossible sign, not saturated'
  );
}

// ---------------------------------------------------------------------------
// 7. The cap bracket -- one parameter instead of five, and what it refuses.
// ---------------------------------------------------------------------------

{
  // A cap of exactly 100M effective input tokens, and a row that spends 24M of
  // it. At 24% the reading is exact, so the bracket must CONTAIN 100M and must
  // not pretend to be tighter than the meter's own quantum.
  const x = new Map([[coordName('opus', 'input'), 24_000_000]]);
  const b = bracketCap([{ y: 24, x }], { mode: 'levels' });
  check(
    'a level brackets the cap on both sides and contains the truth',
    b.lo <= 100e6 && b.hi >= 100e6 && b.usable === 1,
    `${(b.lo / 1e6).toFixed(1)}M .. ${(b.hi / 1e6).toFixed(1)}M`
  );
}

{
  // Every published rate, exercised at once. 1M input + 1M 1-hour writes +
  // 10M reads + 1M output = 1 + 2 + 1 + 5 = 9M effective input tokens.
  const x = new Map([
    [coordName('opus', 'input'), 1_000_000],
    [coordName('opus', 'cacheWrite1h'), 1_000_000],
    [coordName('opus', 'cacheRead'), 10_000_000],
    [coordName('opus', 'output'), 1_000_000],
  ]);
  const { cost } = rowCost(x);
  check( 'a mixed row prices at the published rates',cost === 9_000_000, `${cost}`);
}

{
  // OUTPUT IS IN THE UNIT, which is the thing the cost model was missing. A
  // row of pure output must cost five times the same count of input tokens.
  const out = rowCost(new Map([[coordName('opus', 'output'), 1000]])).cost;
  const inp = rowCost(new Map([[coordName('opus', 'input'), 1000]])).cost;
  check( 'output is priced, at five times input',out === 5 * inp, `${out} vs ${inp}`);
}

{
  // A DELTA OF 1 BOUNDS THE CAP ONLY FROM BELOW, because the true delta could
  // be anywhere above 0. Saying otherwise would invent the one bound that
  // decides whether a saving has a floor.
  const x = new Map([[coordName('opus', 'input'), 5_000_000]]);
  const b = bracketCap([{ y: 1, x }], { mode: 'deltas' });
  check(
    'a delta of 1 gives a floor on the cap and no ceiling',
    b.lo > 0 && b.hi === Infinity && b.needsBiggerDelta === true,
    `${(b.lo / 1e6).toFixed(1)}M .. unbounded`
  );
}

{
  // A delta of 2 closes the interval, which is the whole difference between
  // "at most this much is saved" and a claim with a floor under it.
  const x = new Map([[coordName('opus', 'input'), 5_000_000]]);
  const b = bracketCap([{ y: 2, x }], { mode: 'deltas' });
  check(
    'a delta of 2 closes the interval',
    Number.isFinite(b.hi) && b.needsBiggerDelta === false,
    `${(b.lo / 1e6).toFixed(1)}M .. ${(b.hi / 1e6).toFixed(1)}M`
  );
}

{
  // Rows intersect: two levels on the same cap must agree, and the
  // intersection must be no wider than either.
  const one = { y: 10, x: new Map([[coordName('opus', 'input'), 10_000_000]]) };
  const two = { y: 50, x: new Map([[coordName('opus', 'input'), 50_000_000]]) };
  const b = bracketCap([one, two], { mode: 'levels' });
  const solo = bracketCap([two], { mode: 'levels' });
  check(
    'two consistent levels intersect to something no wider than either',
    !b.empty && b.lo >= solo.lo && b.hi <= solo.hi && b.lo <= 100e6 && b.hi >= 100e6,
    `${(b.lo / 1e6).toFixed(1)}M .. ${(b.hi / 1e6).toFixed(1)}M`
  );
}

{
  // AND ROWS CAN CONTRADICT EACH OTHER, which is a finding and not a glitch:
  // it falsifies either the published rates or the single-cap model. An empty
  // intersection must be NAMED, because `lo > hi` read as an interval is the
  // tightest-looking answer this code can produce.
  const cheap = { y: 50, x: new Map([[coordName('opus', 'input'), 10_000_000]]) };
  const dear = { y: 10, x: new Map([[coordName('opus', 'input'), 50_000_000]]) };
  const b = bracketCap([cheap, dear], { mode: 'levels' });
  check( 'contradictory rows are reported as empty, not as a tight interval',b.empty === true, `${(b.lo / 1e6).toFixed(1)}M .. ${(b.hi / 1e6).toFixed(1)}M`);
}

{
  // A row that spent nothing, or that moved the meter not at all, constrains
  // nothing -- and must not be counted as though it had.
  const b = bracketCap(
    [
      { y: 0, x: new Map([[coordName('opus', 'input'), 1_000_000]]) },
      { y: 5, x: new Map([[coordName('opus', 'input'), 0]]) },
    ],
    { mode: 'levels' }
  );
  check( 'rows that constrain nothing are counted as such',b.usable === 0 && b.lo === 0 && b.hi === Infinity);
}

{
  // The published rates are multiples of a family's OWN input token, so a
  // bracket drawn across two families has quietly assumed those are equal.
  const x = new Map([
    [coordName('opus', 'input'), 1_000_000],
    [coordName('haiku', 'input'), 1_000_000],
  ]);
  const b = bracketCap([{ y: 10, x }], { mode: 'levels' });
  check( 'a bracket across families says so',b.mixedFamilies.length === 2, b.mixedFamilies.join(','));
}

{
  // The inversion: a bigger cap makes any saving a SMALLER share of it, so the
  // floor comes from the top of the bracket. Getting this backwards would
  // overstate every saving by the width of the interval.
  const b = { lo: 100e6, hi: 200e6 };
  const s = savingAsShareOfCap(2e6, b);
  check(
    'a saving is bracketed by the cap, floor from the top of it',
    Math.abs(s.floor - 1) < 1e-9 && Math.abs(s.ceiling - 2) < 1e-9,
    `${s.floor.toFixed(2)}pp .. ${s.ceiling.toFixed(2)}pp`
  );
}

{
  // And with no ceiling on the cap there is no floor on the saving. Zero is
  // the honest answer there, not the ceiling quietly reused.
  const s = savingAsShareOfCap(2e6, { lo: 100e6, hi: Infinity });
  check( 'an unbounded cap leaves a saving with no floor',s.floor === 0 && s.ceiling === 2, `${s.floor}pp .. ${s.ceiling}pp`);
}

// ---------------------------------------------------------------------------
// 8. The offset probe -- why levels can agree and still be wrong.
// ---------------------------------------------------------------------------

/** A levels row: `tokens` of plain input read at `y` percent. */
const lvl = (label, tokens, y) => ({
  label,
  y,
  x: new Map([[coordName('opus', 'input'), tokens]]),
});

{
  // Truly proportional traffic against a 200M cap: 20M -> 10%, 60M -> 30%.
  // The probe must find no offset worth reporting and recover the cap.
  const b = bracketCap([lvl('early', 20e6, 10), lvl('late', 60e6, 30)], { mode: 'levels' });
  const sig = offsetSignature(b);
  check(
    'proportional rows show no offset and give back the cap',
    Math.abs(sig.offset) < 1e-9 && Math.abs(sig.cap - 200e6) < 1,
    `${(sig.cap / 1e6).toFixed(1)}M, offset ${sig.offset.toFixed(2)}pp`
  );
  check(
    'no offset means the levels bracket is not accused of understating',
    sig.levelsUnderstateCap === false
  );
}

{
  // The same 200M cap, but the meter also carries a fixed 3pp the transcripts
  // never see: 20M -> 13%, 60M -> 33%. Two points, two unknowns, so both must
  // come back exactly -- and the LOW row must be the one implying the small cap,
  // which is the signature the report keys on.
  const rows = [lvl('early', 20e6, 13), lvl('late', 60e6, 33)];
  const b = bracketCap(rows, { mode: 'levels' });
  const sig = offsetSignature(b);
  check(
    'an injected offset comes back exactly, with the cap',
    Math.abs(sig.cap - 200e6) < 1 && Math.abs(sig.offset - 3) < 1e-9,
    `${(sig.cap / 1e6).toFixed(1)}M, offset ${sig.offset.toFixed(2)}pp`
  );
  check(
    'a positive offset is reported as understating the cap',
    sig.levelsUnderstateCap === true && sig.low.label === 'early' && sig.high.label === 'late'
  );
  const early = b.perRow.find((r) => r.label === 'early');
  const late = b.perRow.find((r) => r.label === 'late');
  check(
    'and the low row really does imply the smaller cap',
    early.hi < late.lo,
    `early <= ${(early.hi / 1e6).toFixed(0)}M, late >= ${(late.lo / 1e6).toFixed(0)}M`
  );
  check(
    'which is exactly the contradiction the bracket refuses to paper over',
    b.empty === true,
    `${(b.lo / 1e6).toFixed(0)}M .. ${(b.hi / 1e6).toFixed(0)}M`
  );
}

{
  // The dangerous case: rows clustered at almost the same reading. The offset
  // model fits them just as well as the proportional one, so the bracket agrees
  // while the truth is elsewhere. The probe exists to say so.
  const b = bracketCap([lvl('a', 113.8e6, 23), lvl('b', 124.2e6, 25)], { mode: 'levels' });
  const sig = offsetSignature(b);
  check(
    'clustered rows agree and still leave room for an offset',
    b.empty === false && sig.offset > 0 && sig.cap > b.hi,
    `bracket ${(b.lo / 1e6).toFixed(0)}-${(b.hi / 1e6).toFixed(0)}M, ` +
      `offset model ${(sig.cap / 1e6).toFixed(0)}M at ${sig.offset.toFixed(1)}pp`
  );
}

{
  check(
    'one row cannot separate a cap from an offset',
    offsetSignature(bracketCap([lvl('only', 24e6, 24)], { mode: 'levels' })) === null
  );
  check(
    'rows at the same reading cannot either',
    offsetSignature(bracketCap([lvl('a', 24e6, 24), lvl('b', 25e6, 24)], { mode: 'levels' })) ===
      null
  );
}

{
  // More tokens, lower reading: the slope is negative, which is not an offset
  // but a broken observation. Reporting a cap from it would be worse than
  // reporting nothing.
  const b = bracketCap([lvl('a', 60e6, 10), lvl('b', 20e6, 30)], { mode: 'levels' });
  check('an impossible slope is refused, not reported', offsetSignature(b) === null);
}

{
  // capReport must cover every window and both routes without being told to,
  // because a caller who has to ask for the failing one will not.
  const obs = synthesise(independentSteps(6), { floorPercent: false });
  const report = capReport(obs);
  const seen = report.map((r) => `${r.windowKey}/${r.mode}`);
  check(
    'capReport covers both windows by both routes',
    seen.length === 4 &&
      seen.includes('five_hour/levels') &&
      seen.includes('seven_day/deltas'),
    seen.join(' ')
  );
}


console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
