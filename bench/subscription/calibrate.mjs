/**
 * FIT THE SUBSCRIPTION'S OWN WEIGHTS, INSTEAD OF ASSERTING A PRICE LIST.
 *
 * `bench/compression/cost-model.mjs` charges every arm with three constants:
 *
 *     cacheWrite: 1.25,  cacheRead: 0.1,  outputPerInput: 5
 *
 * They are list prices for the API, restated as if they were the exchange rate
 * of a subscription. Nothing has ever checked that. This file checks it, from
 * the two things the rig can actually see: exact tokens (`transcripts.mjs`) and
 * real metered movement (`meter.mjs`), paired by `observe.mjs`.
 *
 * THE MODEL. The meter reports utilisation as a percentage of a cap it will not
 * tell us:
 *
 *     percent  =  100 * ( SUM_i w_i * x_i ) / L
 *
 * over coordinates i = (model family x token kind), with x the token counts and
 * w the per-coordinate weights. L is null on this plan, so w and L are NOT
 * separately identifiable -- only the composite
 *
 *     theta_i  =  100 * w_i / L
 *
 * which is what this file solves for. That is not a shortfall: every claim the
 * benchmark makes is a RATIO ("this arm costs 0.7x that one"), and ratios of
 * theta equal ratios of w exactly. The unknown cap cancels. What cannot be
 * recovered is an absolute "this workload costs N dollars", and the rig should
 * never print one.
 *
 * WHY DIFFERENCES, NOT LEVELS. The default fit uses the CHANGE between two
 * consecutive observations inside one window. Two reasons, both load-bearing:
 *
 *  1. The transcripts are not the whole meter. Usage from claude.ai, another
 *     machine on the same subscription, or any client that writes no transcript
 *     counts against the window and is invisible here. In a level fit that
 *     unobserved usage is an unmodelled intercept and biases every weight. In a
 *     delta it cancels, as long as it did not itself change between the two
 *     reads -- which is why `observe.mjs` records how quiet the machine was.
 *  2. A level fit uses the window's whole history, so consecutive levels are
 *     almost the same vector and carry almost no independent information. The
 *     deltas are the actual experiments.
 *
 * A level fit is still available (`--levels`) as a cross-check: it rests on a
 * stronger assumption, so agreement between the two is evidence and
 * disagreement localises the problem to coverage.
 *
 * THE QUANTUM IS THE ERROR BAR. `percent` is an integer. A delta of 3 means the
 * true movement was somewhere in (2, 4) -- an absolute error of about +/-1
 * REGARDLESS of the delta's size. That has three consequences this file
 * enforces rather than mentions:
 *
 *  - Errors are the same size on every row, so ordinary least squares is the
 *    right estimator and no weighting scheme is appropriate. Weighting by
 *    delta size would be assuming proportional error, which is false here.
 *  - A delta of 0 or 1 is nearly all noise. `--min-delta` exists for that, and
 *    the report always says how many rows survived it.
 *  - A fit that reports a residual far below 1 percentage point has not
 *    achieved precision -- it has overfit. The report prints the residual
 *    against the quantum for exactly that reason.
 *
 * IDENTIFIABILITY IS REPORTED, NOT ASSUMED. With one model family in play and
 * cache reads dominating every row, the design matrix is routinely rank
 * deficient -- on this machine `cacheWrite5m` is identically zero, so its
 * weight is not merely imprecise, it is unconstrained by any observation. A
 * naive solve returns a confident-looking number for it anyway. This uses a
 * rank-revealing QR (Householder with column pivoting), solves only on the
 * identifiable subset, and names every coordinate it had to drop. A dropped
 * coordinate is a coordinate the data cannot speak about; publishing a value
 * for it would be the same error as the price-list constants this replaces.
 */

import { pathToFileURL } from 'node:url';

import { readObservations, OBSERVATIONS } from './observe.mjs';
import { KINDS } from './transcripts.mjs';

/** A coordinate name, as it appears in every report: `opus.cacheRead`. */
export function coordName(family, kind) {
  return `${family}.${kind}`;
}

/**
 * How far two `resets_at` values may differ and still be the same window.
 *
 * `resets_at` LOOKS like a stable identifier and is not. Two reads 3 minutes
 * apart returned `15:30:00.245Z` and `15:30:00.319Z` -- the endpoint recomputes
 * it per request and it drifts by tens of milliseconds. The first end-to-end
 * run of this rig classified that pair as straddling a reset and threw away the
 * only row it had.
 *
 * A genuine rollover moves `resets_at` by a whole window: five hours, or seven
 * days. Ten minutes sits four orders of magnitude above the observed jitter and
 * an order of magnitude below the smallest real advance, so it separates the
 * two cleanly with no tuning.
 */
const RESET_JITTER_MS = 10 * 60e3;

export function sameWindowInstance(a, b) {
  if (!a?.resetsAt || !b?.resetsAt) return false;
  return Math.abs(Date.parse(b.resetsAt) - Date.parse(a.resetsAt)) <= RESET_JITTER_MS;
}

/**
 * Turn observations into design rows.
 *
 * Delta mode pairs each observation with the one before it, and keeps the pair
 * only when both sat inside the SAME window instance -- see
 * `sameWindowInstance` for why that is a tolerance and not an equality. Once
 * the meter has rolled over, utilisation has dropped and the difference between
 * the two readings is not a cost of anything.
 */
export function buildRows(observations, { windowKey = 'five_hour', mode = 'deltas' } = {}) {
  const rows = [];
  const skipped = { noWindow: 0, straddlesReset: 0, negativeDelta: 0, noTokens: 0 };

  const usable = observations.filter((o) => o?.windows?.[windowKey]);
  skipped.noWindow = observations.length - usable.length;

  const vectorOf = (w) => {
    const v = new Map();
    for (const [family, totals] of Object.entries(w.byFamily ?? {})) {
      for (const kind of KINDS) v.set(coordName(family, kind), totals[kind] ?? 0);
    }
    return v;
  };

  if (mode === 'levels') {
    for (const o of usable) {
      const w = o.windows[windowKey];
      rows.push({ at: o.at, label: o.label, y: w.percent, x: vectorOf(w), observations: [o.at] });
    }
    return { rows, skipped };
  }

  for (let i = 1; i < usable.length; i++) {
    const prev = usable[i - 1];
    const cur = usable[i];
    const a = prev.windows[windowKey];
    const b = cur.windows[windowKey];
    if (!sameWindowInstance(a, b)) {
      skipped.straddlesReset++;
      continue;
    }
    const dy = b.percent - a.percent;
    if (dy < 0) {
      // Utilisation cannot fall inside one window instance. A negative delta
      // means the meter was corrected or the window identity is not what we
      // think, and either way the row is not evidence about token weights.
      skipped.negativeDelta++;
      continue;
    }
    const va = vectorOf(a);
    const vb = vectorOf(b);
    const x = new Map();
    let any = false;
    for (const key of new Set([...va.keys(), ...vb.keys()])) {
      const d = (vb.get(key) ?? 0) - (va.get(key) ?? 0);
      x.set(key, d);
      if (d !== 0) any = true;
    }
    if (!any) {
      skipped.noTokens++;
      continue;
    }
    rows.push({
      at: cur.at,
      label: cur.label,
      y: dy,
      x,
      observations: [prev.at, cur.at],
      secondsApart: Math.round((Date.parse(cur.at) - Date.parse(prev.at)) / 1000),
      quiet: cur.quiet,
    });
  }
  return { rows, skipped };
}

/**
 * Householder QR with column pivoting.
 *
 * Returns `{ pivots, rank, R, Qty }` where `pivots` is the column order chosen
 * by the pivoting rule (largest remaining column norm first). The pivoting is
 * the whole point: it puts the coordinates the data actually constrains at the
 * front, and pushes the ones it cannot distinguish past the rank cutoff, where
 * they are reported as unidentifiable instead of being handed a number.
 */
function qrColumnPivoting(A, b, tol) {
  const m = A.length;
  const n = A[0]?.length ?? 0;
  const R = A.map((row) => row.slice());
  const y = b.slice();
  const pivots = Array.from({ length: n }, (_, j) => j);

  const colNorm = (j, from) => {
    let s = 0;
    for (let i = from; i < m; i++) s += R[i][j] * R[i][j];
    return Math.sqrt(s);
  };

  // The tolerance is RELATIVE to the largest column norm, so it means "this
  // column carries less than tol of the information the best column carries",
  // which is scale free -- necessary when one coordinate is cache reads in the
  // hundreds of millions and another is input tokens in the hundreds.
  let scale = 0;
  for (let j = 0; j < n; j++) scale = Math.max(scale, colNorm(j, 0));
  const cutoff = scale * tol;

  let rank = 0;
  for (let k = 0; k < Math.min(m, n); k++) {
    let best = k;
    let bestNorm = colNorm(k, k);
    for (let j = k + 1; j < n; j++) {
      const nrm = colNorm(j, k);
      if (nrm > bestNorm) {
        bestNorm = nrm;
        best = j;
      }
    }
    if (bestNorm <= cutoff) break;
    if (best !== k) {
      for (let i = 0; i < m; i++) {
        const t = R[i][k];
        R[i][k] = R[i][best];
        R[i][best] = t;
      }
      const t = pivots[k];
      pivots[k] = pivots[best];
      pivots[best] = t;
    }

    let normx = 0;
    for (let i = k; i < m; i++) normx += R[i][k] * R[i][k];
    normx = Math.sqrt(normx);
    if (normx === 0) break;
    const alpha = R[k][k] > 0 ? -normx : normx;
    const v = new Array(m).fill(0);
    for (let i = k; i < m; i++) v[i] = R[i][k];
    v[k] -= alpha;
    let vtv = 0;
    for (let i = k; i < m; i++) vtv += v[i] * v[i];
    if (vtv > 0) {
      for (let j = k; j < n; j++) {
        let dot = 0;
        for (let i = k; i < m; i++) dot += v[i] * R[i][j];
        const f = (2 * dot) / vtv;
        for (let i = k; i < m; i++) R[i][j] -= f * v[i];
      }
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i] * y[i];
      const f = (2 * dot) / vtv;
      for (let i = k; i < m; i++) y[i] -= f * v[i];
    }
    rank = k + 1;
  }

  return { pivots, rank, R, Qty: y };
}

/**
 * Least-squares fit of theta, with the unidentifiable coordinates named.
 *
 * `theta` holds only the coordinates the data constrains. `dropped` holds the
 * rest, each with the reason it could not be solved -- which is the part a
 * reader has to see, because a dropped coordinate is one the benchmark still
 * has no measured weight for.
 */
export function fit(rows, { tol = 1e-8 } = {}) {
  const names = [...new Set(rows.flatMap((r) => [...r.x.keys()]))].sort();
  const constant = [];
  const varying = [];
  for (const name of names) {
    // A coordinate that is identically zero across every row is not merely
    // poorly determined; NO observation touched it. Naming it here separates
    // "we have no data" from "the data disagrees", which the QR rank alone
    // would blur.
    const allZero = rows.every((r) => (r.x.get(name) ?? 0) === 0);
    if (allZero) constant.push(name);
    else varying.push(name);
  }

  if (!rows.length || !varying.length) {
    return {
      rows: rows.length,
      theta: {},
      dropped: [
        ...constant.map((name) => ({ name, reason: 'no observation moved this coordinate' })),
      ],
      rank: 0,
      residual: null,
      names,
    };
  }

  const A = rows.map((r) => varying.map((name) => r.x.get(name) ?? 0));
  const b = rows.map((r) => r.y);
  const { pivots, rank, R, Qty } = qrColumnPivoting(A, b, tol);

  // Back substitution on the leading rank x rank block. Coordinates past the
  // cutoff are set aside rather than pinned to zero: pinning would silently
  // attribute their share of the cost to whichever coordinate they alias.
  const solved = new Array(rank).fill(0);
  for (let i = rank - 1; i >= 0; i--) {
    let s = Qty[i];
    for (let j = i + 1; j < rank; j++) s -= R[i][j] * solved[j];
    solved[i] = R[i][i] === 0 ? 0 : s / R[i][i];
  }

  const theta = {};
  for (let i = 0; i < rank; i++) theta[varying[pivots[i]]] = solved[i];

  const dropped = [
    ...constant.map((name) => ({ name, reason: 'no observation moved this coordinate' })),
  ];
  for (let i = rank; i < pivots.length; i++) {
    dropped.push({
      name: varying[pivots[i]],
      reason: 'collinear with an already-solved coordinate at this tolerance',
    });
  }

  // Residuals use the FULL rows, with dropped coordinates contributing nothing,
  // so the reported fit is the fit a consumer of `theta` would actually get.
  const predictions = rows.map((r) => {
    let p = 0;
    for (const [name, value] of Object.entries(theta)) p += value * (r.x.get(name) ?? 0);
    return p;
  });
  let sse = 0;
  for (let i = 0; i < rows.length; i++) sse += (predictions[i] - b[i]) ** 2;
  const rmse = Math.sqrt(sse / rows.length);

  // STANDARD ERRORS, BECAUSE RANK IS NOT PRECISION. A coordinate can clear the
  // rank test -- some observation did move it -- and still be worthless, if
  // what it moved was far smaller than the meter's 1 percentage point quantum.
  // On a real run `opus.input` is exactly that: a few hundred thousand input
  // tokens buried under hundreds of millions of cache reads, contributing a
  // fraction of a percent while the rounding error is +/- a whole one. Without
  // this, the report would print such a weight to four figures and a reader
  // would have no way to tell it from a well-determined one -- which is the
  // same mistake as the price-list constants, dressed as a measurement.
  //
  // Ordinary OLS covariance on the identifiable block: var = sigma^2 (R'R)^-1,
  // read off the QR that was already computed. sigma comes from the residuals,
  // and on quantised data it should land near 0.41 -- the standard deviation of
  // the difference of two uniform rounding errors -- which is a free check that
  // the noise model is the one actually in the data.
  const dof = Math.max(1, rows.length - rank);
  const sigma2 = sse / dof;
  const inverse = Array.from({ length: rank }, () => new Array(rank).fill(0));
  for (let i = rank - 1; i >= 0; i--) {
    if (R[i][i] === 0) continue;
    inverse[i][i] = 1 / R[i][i];
    for (let j = i + 1; j < rank; j++) {
      let s = 0;
      for (let k = i + 1; k <= j; k++) s += R[i][k] * inverse[k][j];
      inverse[i][j] = -s / R[i][i];
    }
  }
  const stderr = {};
  const relativeStderr = {};
  for (let i = 0; i < rank; i++) {
    let rowSq = 0;
    for (let j = i; j < rank; j++) rowSq += inverse[i][j] * inverse[i][j];
    const se = Math.sqrt(sigma2 * rowSq);
    const name = varying[pivots[i]];
    stderr[name] = se;
    relativeStderr[name] = theta[name] === 0 ? Infinity : Math.abs(se / theta[name]);
  }

  return {
    rows: rows.length,
    theta,
    stderr,
    relativeStderr,
    sigma: Math.sqrt(sigma2),
    dropped,
    rank,
    residual: rmse,
    predictions,
    names,
    varying,
  };
}

/**
 * The coordinates whose estimates are too uncertain to publish.
 *
 * `identifiable but imprecise` is a THIRD state, distinct from both "solved"
 * and "unidentifiable", and it is the state most of this rig's early
 * observations will be in. A weight whose standard error is a quarter of its
 * own size cannot support a claim that one arm is 10% cheaper than another, and
 * the only correct thing to do with it is say so and collect more observations.
 */
export function imprecise(result, { maxRelativeStderr = 0.25 } = {}) {
  return Object.entries(result.relativeStderr ?? {})
    .filter(([, rel]) => !(rel <= maxRelativeStderr))
    .map(([name, rel]) => ({ name, relativeStderr: rel }))
    .sort((a, b) => b.relativeStderr - a.relativeStderr);
}

/**
 * How many rows the fit actually explains, given that `y` is a rounded integer.
 *
 * Under flooring, an observed delta `d` is consistent with any true movement in
 * `(d - 1, d + 1)`, because each of the two readings it was built from was
 * floored independently. A prediction inside that band is as good as the data
 * can ask for; RMSE alone would keep rewarding a model for moving inside it.
 */
export function bracketAgreement(rows, predictions) {
  let inside = 0;
  for (let i = 0; i < rows.length; i++) {
    if (Math.abs(predictions[i] - rows[i].y) < 1) inside++;
  }
  return { inside, total: rows.length };
}

/**
 * The three constants `cost-model.mjs` asserts, next to what was measured.
 *
 * Everything is expressed relative to a plain input token of the same family,
 * because that is the unit `cost-model.mjs` uses (`W + R * N`, in multiples of
 * an input token). A coordinate that is missing from `theta` prints as
 * unmeasured rather than as a number, since that is the honest answer until
 * enough observations exist.
 */
export const ASSERTED = Object.freeze({
  cacheWrite5m: 1.25,
  cacheWrite1h: 2.0,
  cacheRead: 0.1,
  output: 5,
});

export function compareToAsserted(result, family) {
  const theta = result.theta ?? {};
  const rel = result.relativeStderr ?? {};
  const baseName = coordName(family, 'input');
  const base = theta[baseName];
  const out = [];
  for (const kind of KINDS) {
    if (kind === 'input') continue;
    const name = coordName(family, kind);
    const measured = theta[name];
    const ratio =
      measured === undefined || base === undefined || base === 0 ? null : measured / base;
    // Uncertainty on a RATIO of two fitted coordinates. This propagates their
    // individual relative errors and IGNORES their covariance, which on data
    // this collinear is not small -- so the band printed here is a floor on the
    // real uncertainty, never a bound. It is enough to answer the only question
    // being asked: is the asserted constant even inside the plausible range.
    const relRatio =
      ratio === null
        ? null
        : Math.sqrt((rel[name] ?? Infinity) ** 2 + (rel[baseName] ?? Infinity) ** 2);
    const asserted = ASSERTED[kind] ?? null;
    out.push({
      kind,
      asserted,
      measured: ratio,
      relativeStderr: relRatio,
      // `consistent` is deliberately generous -- two floor-estimate standard
      // errors. A constant that falls OUTSIDE even that band is one the meter
      // contradicts, which is a finding; one inside it is merely not yet ruled
      // out, which is not the same as confirmed.
      consistent:
        ratio === null || asserted === null || !Number.isFinite(relRatio)
          ? null
          : Math.abs(asserted - ratio) <= 2 * relRatio * Math.abs(ratio),
      note:
        base === undefined
          ? `${family}.input not identifiable, so no ratio can be formed`
          : measured === undefined
            ? 'not identifiable from the observations on disk'
            : null,
    });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const windowKey = flag('--window', 'five_hour');
  const mode = argv.includes('--levels') ? 'levels' : 'deltas';
  const minDelta = Number(flag('--min-delta', '1'));
  const family = flag('--family', 'opus');

  const observations = readObservations();
  const { rows: allRows, skipped } = buildRows(observations, { windowKey, mode });
  const rows = allRows.filter((r) => r.y >= minDelta);

  console.log(`observations ${observations.length}  (${OBSERVATIONS})`);
  const skips = Object.entries(skipped)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(
    `${mode} on ${windowKey}: ${allRows.length} rows, ` +
      `${rows.length} with y >= ${minDelta}` +
      (skips ? `  skipped ${skips}` : '')
  );

  if (rows.length < 2) {
    console.log(
      '\nNOT ENOUGH DATA TO FIT ANYTHING. The meter moves in whole percent, so a\n' +
        'usable row needs a workload big enough to move it by at least 1. Run\n' +
        '`node bench/subscription/observe.mjs --label <name>` before and after a\n' +
        'workload, repeatedly, and re-run this. No weight is printed until the\n' +
        'data supports one.'
    );
    process.exit(0);
  }

  const result = fit(rows);
  const agree = bracketAgreement(rows, result.predictions);

  console.log(`\nrank ${result.rank} of ${result.varying.length} varying coordinates`);
  for (const [name, value] of Object.entries(result.theta).sort()) {
    const rel = result.relativeStderr[name];
    const flag = rel <= 0.25 ? '' : '   TOO IMPRECISE TO PUBLISH';
    console.log(
      `  ${name.padEnd(24)} theta ${value.toExponential(4)} % per token  ` +
        `+/- ${(rel * 100).toFixed(0)}%${flag}`
    );
  }
  for (const d of result.dropped) console.log(`  ${d.name.padEnd(24)} UNIDENTIFIABLE - ${d.reason}`);

  console.log(
    `\nresidual ${result.residual.toFixed(3)} percentage points ` +
      `(the meter's own quantum is 1.000, and pure rounding noise on a delta ` +
      `has sd 0.41 -- a residual far below that is overfitting, not precision)`
  );
  console.log(`within the rounding band: ${agree.inside}/${agree.total} rows`);

  const weak = imprecise(result);
  if (weak.length) {
    console.log(
      `\n${weak.length} coordinate(s) are identifiable but too uncertain to use: ` +
        weak.map((w) => `${w.name} (+/-${(w.relativeStderr * 100).toFixed(0)}%)`).join(', ') +
        `\nCollect more observations, or run a workload that moves them specifically.`
    );
  }

  console.log(`\nasserted by cost-model.mjs vs measured, relative to ${family}.input:`);
  for (const c of compareToAsserted(result, family)) {
    if (c.measured === null) {
      console.log(`  ${c.kind.padEnd(14)} asserted ${String(c.asserted ?? '--').padEnd(6)} -- ${c.note}`);
      continue;
    }
    const band = Number.isFinite(c.relativeStderr)
      ? ` +/-${(c.relativeStderr * 100).toFixed(0)}% (floor)`
      : '';
    const verdict =
      c.consistent === null ? '' : c.consistent ? '  consistent' : '  CONTRADICTED BY THE METER';
    console.log(
      `  ${c.kind.padEnd(14)} asserted ${String(c.asserted ?? '--').padEnd(6)} ` +
        `measured ${c.measured.toFixed(3)}${band}${verdict}`
    );
  }
}
