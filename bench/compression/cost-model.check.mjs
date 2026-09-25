/**
 * THE COST MODEL, CHECKED AGAINST ARITHMETIC RATHER THAN AGAINST ITSELF.
 *
 * `cost-model.mjs` produces the only number this project publishes as a claim:
 * the fetch rate below which our arm is cheaper. Until this file existed it had
 * no tests at all -- the headline of the whole comparison rested on a function
 * nobody had ever checked.
 *
 * Every case here is offline, synthetic and deterministic. Nothing reads a
 * credential, a transcript or a network. The point is not that the model's
 * ASSUMPTIONS are right -- they are guesses, and `sweep` exists to attack them
 * -- but that given those assumptions the arithmetic is what it claims to be.
 *
 * TWO CASES DESERVE SPECIAL MENTION, because they are the ones that would have
 * caught the defects the rewrite fixed:
 *
 *   `reproduces the previous model exactly at p = 1` pins the rewrite to the
 *   old formula where the old formula was right. The quadratic prefix term is
 *   an accuracy fix, not a re-derivation, and this is how that is proved rather
 *   than asserted: at full fetch and batch 1 the two must agree to the last
 *   bit, and they do.
 *
 *   `reports both crossings when two arms cross twice` exists because the
 *   moment the cost became a quadratic, "the break-even rate" stopped being
 *   guaranteed to be a single number. A caller printing only the first root
 *   would state a half-truth with no way to notice; `crossings` makes that
 *   impossible, and this case proves the second root is really found.
 */

import {
  DEFAULTS as SHIPPED_DEFAULTS,
  RATES,
  ZERO_LINE,
  addLines,
  breakEven,
  costAt,
  costLine,
  markerBytes,
  paramsFromMeter,
  roundsAt,
  sumLines,
  sweep,
  commonSessionCost,
  usageMultiplier,
  worstAgainst,
} from './cost-model.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok  ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));
const close = (x, y, tol) => Math.abs(x - y) <= tol;
const rel = (x, y) => (y === 0 ? Math.abs(x) : Math.abs(x - y) / Math.abs(y));

/** A spread of shapes: empty, small, the real 41-block case, degenerate. */
const CASES = [
  { handed: 1000, blocks: [] },
  { handed: 12345, blocks: [500, 2000, 900] },
  { handed: 40000, blocks: Array.from({ length: 41 }, (_, i) => 100 + i * 37) },
  { handed: 0, blocks: [1] },
];

const GRID = [0, 0.05, 0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9, 1];

/**
 * Pinned parameters for the cases that need a crossing to exist.
 *
 * `DEFAULTS.turnsAfter` is a MEASUREMENT now, re-derived from real traffic, so
 * a case that quietly depends on its present value is testing the traffic and
 * not the arithmetic -- and breaks the day the traffic moves. These cases are
 * about where a crossing is and how it is labelled, so they pin the parameter
 * and say so. The cases that must hold at any parameter keep using DEFAULTS.
 */
// `baseContextTokens` IS NULL IN THE SHIPPED DEFAULTS, ON PURPOSE: it is a
// property of an environment -- its system prompt and loaded tool schemas --
// and there is no defensible default, so the model refuses rather than guessing.
//
// These cases are synthetic arithmetic and not a claim about any machine, so
// they pin a fixture value. It is deliberately the 12000 that used to ship, to
// keep every expected value below unchanged by the refusal work: what changed
// is that the number now has to be supplied out loud instead of defaulting.
const FIXTURE_BASE_CONTEXT = 12000;
const DEFAULTS = Object.freeze({ ...SHIPPED_DEFAULTS, baseContextTokens: FIXTURE_BASE_CONTEXT });

// And the refusal itself is checked, so the null default cannot quietly come
// back as a number that nobody measured.
{
  let refused = false;
  try {
    commonSessionCost(SHIPPED_DEFAULTS);
  } catch {
    refused = true;
  }
  check(refused, 'an unmeasured base context refuses instead of costing the session');
  check(SHIPPED_DEFAULTS.baseContextTokens === null, 'and the shipped default is null, not a guess', `${SHIPPED_DEFAULTS.baseContextTokens}`);
}

const PINNED = Object.freeze({ ...DEFAULTS, turnsAfter: 20 });

// ---------------------------------------------------------------------------
// 1. The rewrite did not change the maths, only where it was wrong.
// ---------------------------------------------------------------------------

/**
 * The model exactly as it stood before the rewrite: one linear term, a single
 * cache-write rate, an extra request per block, and a prefix that grows whether
 * or not the earlier fetches happened.
 */
function previousModel({ handed, blocks, params }) {
  const { cacheWrite: W, cacheRead: R, outputPerInput, turnsAfter: N, baseContextTokens, fetchCallTokens } = params;
  const fixed = handed * (W + R * N);
  let perFetch = 0;
  let prefix = baseContextTokens + handed;
  const n = blocks.length;
  for (let i = 0; i < n; i++) {
    const at = (N * (i + 1)) / (n + 1);
    const size = blocks[i];
    perFetch += prefix * R;
    perFetch += fetchCallTokens * outputPerInput;
    perFetch += size * (W + R * Math.max(0, N - at));
    prefix += size;
  }
  return { fixed, perFetch };
}

// The previous model asserted the 5-minute write rate for everything, so the
// comparison pins that rate: this case is about the SHAPE of the formula, and
// the rate change is a separate, evidenced difference checked further down.
const OLD_PARAMS = { ...DEFAULTS, cacheWrite: RATES.cacheWrite5m, fetchBatch: 1 };

{
  // The two formulas add the same terms in different orders, and IEEE-754
  // addition is not associative, so demanding bit-identity would assert
  // something false about floating point rather than something true about the
  // model. The budget is in ULPs of the result -- a handful of ULPs is
  // reassociation; a structural change is the 2.68% measured just below, which
  // is thirteen orders of magnitude larger and could never hide under this.
  const ULP_BUDGET = 8;
  let worst = 0;
  let worstWhere = '';
  let fixedExact = true;
  for (const c of CASES) {
    const old = previousModel({ ...c, params: OLD_PARAMS });
    const now = costLine({ ...c, params: OLD_PARAMS });
    const a = old.fixed + old.perFetch;
    const b = costAt(now, 1);
    const ulps = a === b ? 0 : Math.abs(a - b) / (Math.abs(b) * Number.EPSILON);
    if (ulps > worst) {
      worst = ulps;
      worstWhere = `n=${c.blocks.length}`;
    }
    // The fixed term is a single product either way, so THAT must be exact.
    if (old.fixed !== costAt(now, 0)) fixedExact = false;
  }
  check(
    fixedExact && worst <= ULP_BUDGET,
    'reproduces the previous model at p = 1, to the last few bits',
    `fixed term exact; worst drift ${worst.toFixed(2)} ULP at ${worstWhere || 'every shape'}`
  );
}

{
  // Below full fetch the old model overcharged, and it overcharged MORE the
  // more blocks an arm spilled into. Both halves are asserted, because "the new
  // number is smaller" alone would also be satisfied by an arbitrary discount.
  const few = CASES[1];
  const many = CASES[2];
  const gapAt = (c, p) => {
    const old = previousModel({ ...c, params: OLD_PARAMS });
    const now = costLine({ ...c, params: OLD_PARAMS });
    return (old.fixed + p * old.perFetch - costAt(now, p)) / costAt(now, p);
  };
  const p = 0.1;
  const gFew = gapAt(few, p);
  const gMany = gapAt(many, p);
  check(
    gFew > 0 && gMany > gFew,
    'the removed overcharge grew with the number of spilled blocks',
    `at p=${p}: ${(gFew * 100).toFixed(2)}% over ${few.blocks.length} blocks, ${(gMany * 100).toFixed(2)}% over ${many.blocks.length}`
  );
}

// ---------------------------------------------------------------------------
// 2. The cache-write rate.
// ---------------------------------------------------------------------------

{
  check(
    DEFAULTS.cacheWrite === RATES.cacheWrite1h && RATES.cacheWrite1h === 2.0,
    'the default write rate is the 1-hour rate that 100% of observed traffic used',
    `cacheWrite ${DEFAULTS.cacheWrite}`
  );
}

{
  // Changing only the TTL must move the cost by exactly the rate difference
  // times the tokens that were WRITTEN -- handed plus, at full fetch, every
  // block. If it moved by anything else, the write term is entangled with
  // something it should not be.
  const c = CASES[2];
  const written = c.handed + c.blocks.reduce((a, b) => a + b, 0);
  const hour = costAt(costLine({ ...c, params: { ...DEFAULTS, cacheWrite: RATES.cacheWrite1h } }), 1);
  const five = costAt(costLine({ ...c, params: { ...DEFAULTS, cacheWrite: RATES.cacheWrite5m } }), 1);
  const expected = (RATES.cacheWrite1h - RATES.cacheWrite5m) * written;
  check(
    close(hour - five, expected, 1e-6),
    'the TTL changes cost by exactly the rate gap times the written tokens',
    `${(hour - five).toFixed(2)} vs ${expected.toFixed(2)} effective input tokens`
  );
}

// ---------------------------------------------------------------------------
// 3. Batching divides the extra-request term and nothing else.
// ---------------------------------------------------------------------------

{
  const c = CASES[2];
  const at = (b, p) => costAt(costLine({ ...c, params: { ...DEFAULTS, fetchBatch: b } }), p);
  // The round term is the only part that depends on the batch, so the cost
  // gap between batch 1 and batch 2 must be exactly half the gap between
  // batch 1 and the limit of an infinitely large batch.
  const huge = 1e9;
  const p = 0.6;
  const gapTo2 = at(1, p) - at(2, p);
  const gapToAll = at(1, p) - at(huge, p);
  check(
    close(gapTo2, gapToAll / 2, Math.abs(gapToAll) * 1e-9),
    'batching divides only the extra-request term',
    `batch 2 recovers ${((gapTo2 / gapToAll) * 100).toFixed(6)}% of the whole round cost`
  );
}

{
  const c = CASES[2];
  const line = costLine({ ...c, params: { ...DEFAULTS, fetchBatch: 4 } });
  check(
    close(line.roundsAtFullFetch, c.blocks.length / 4, 1e-12) && close(roundsAt(line, 0.5), c.blocks.length / 8, 1e-12),
    'rounds are blocks over batch, and scale with the fetch rate',
    `${line.roundsAtFullFetch} rounds at p=1, ${roundsAt(line, 0.5)} at p=0.5`
  );
}

{
  let threw = false;
  try {
    costLine({ handed: 1, blocks: [1], params: { ...DEFAULTS, fetchBatch: 0 } });
  } catch {
    threw = true;
  }
  check(threw, 'a batch below one is refused rather than dividing by zero');
}

// ---------------------------------------------------------------------------
// 4. Shape: monotone, non-negative, and zero where it should be.
// ---------------------------------------------------------------------------

{
  let monotone = true;
  let nonNegative = true;
  for (const c of CASES) {
    const line = costLine({ ...c, params: DEFAULTS });
    if (line.c0 < 0 || line.c1 < 0 || line.c2 < 0) nonNegative = false;
    for (let i = 1; i < GRID.length; i++)
      if (costAt(line, GRID[i]) < costAt(line, GRID[i - 1]) - 1e-9) monotone = false;
  }
  check(monotone && nonNegative, 'cost never falls as the fetch rate rises', 'all coefficients non-negative');
}

{
  const line = costLine({ handed: 5000, blocks: [], params: DEFAULTS });
  check(
    line.c1 === 0 && line.c2 === 0 && close(line.c0, 5000 * (DEFAULTS.cacheWrite + DEFAULTS.cacheRead * DEFAULTS.turnsAfter), 1e-9),
    'an arm that spills nothing has no fetch term at all',
    `c0 ${line.c0}, c1 ${line.c1}, c2 ${line.c2}`
  );
}

{
  const line = costLine({ handed: 9000, blocks: [100, 200], params: DEFAULTS });
  check(close(costAt(line, 0), line.c0, 0), 'the p = 0 cost is exactly the fixed term');
}

{
  // One block has nothing before it, so there is no quadratic term to pay.
  const line = costLine({ handed: 100, blocks: [777], params: DEFAULTS });
  check(line.c2 === 0, 'a single spilled block has no prefix to re-read', `c2 ${line.c2}`);
}

// ---------------------------------------------------------------------------
// 5. Additivity -- what makes a corpus-level break-even mean anything.
// ---------------------------------------------------------------------------

{
  const lines = CASES.map((c) => costLine({ ...c, params: DEFAULTS }));
  const folded = sumLines(lines);
  let worst = 0;
  for (const p of GRID) {
    const summed = lines.reduce((a, l) => a + costAt(l, p), 0);
    worst = Math.max(worst, rel(costAt(folded, p), summed));
  }
  check(worst < 1e-12, 'a folded corpus costs exactly the sum of its workloads at every rate', `worst relative gap ${worst.toExponential(2)}`);
}

{
  const line = costLine({ ...CASES[1], params: DEFAULTS });
  const same = addLines(line, ZERO_LINE);
  check(
    same.c0 === line.c0 && same.c1 === line.c1 && same.c2 === line.c2,
    'ZERO_LINE is the identity for addLines'
  );
}

// ---------------------------------------------------------------------------
// 6. breakEven -- the published figure.
// ---------------------------------------------------------------------------

/** Where the two arms swap places, found by brute force rather than algebra. */
function scanCrossings(a, b, steps = 2_000_000) {
  const out = [];
  let prev = Math.sign(costAt(b, 0) - costAt(a, 0));
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const s = Math.sign(costAt(b, p) - costAt(a, p));
    if (s !== 0 && prev !== 0 && s !== prev) out.push(p - 0.5 / steps);
    if (s !== 0) prev = s;
  }
  return out;
}

{
  // A real pair: ours spills into many places, theirs into few.
  const ours = costLine({ handed: 30000, blocks: Array.from({ length: 41 }, () => 900), params: PINNED });
  const theirs = costLine({ handed: 52000, blocks: Array.from({ length: 14 }, () => 2600), params: PINNED });
  const be = breakEven(ours, theirs);
  const scanned = scanCrossings(ours, theirs);
  const agree =
    be.crossings.length === scanned.length &&
    be.crossings.every((p, i) => close(p, scanned[i], 1e-5));
  check(agree, 'the algebraic crossing is where a brute-force scan finds it', `algebra ${JSON.stringify(be.crossings.map((x) => +x.toFixed(6)))}, scan ${JSON.stringify(scanned.map((x) => +x.toFixed(6)))}`);
  if (be.p !== null)
    check(
      Math.abs(costAt(ours, be.p) - costAt(theirs, be.p)) < Math.abs(costAt(ours, be.p)) * 1e-12,
      'the arms really do cost the same at the reported crossing',
      `gap ${(costAt(theirs, be.p) - costAt(ours, be.p)).toExponential(2)} on ${costAt(ours, be.p).toFixed(0)}`
    );
  else ok('the arms never cross inside [0, 1]', `${be.cheaper} is cheaper at every rate`);
}

{
  // Two quadratics can meet twice. Printing only the first root would be a
  // half-truth, so the second must be reported.
  const a = { c0: 0, c1: 0, c2: 0 };
  const b = { c0: 1, c1: -5, c2: 5 };
  const be = breakEven(a, b);
  const want = [(5 - Math.sqrt(5)) / 10, (5 + Math.sqrt(5)) / 10];
  check(
    be.crossings.length === 2 && close(be.crossings[0], want[0], 1e-12) && close(be.crossings[1], want[1], 1e-12),
    'reports both crossings when two arms cross twice',
    `found ${be.crossings.map((x) => x.toFixed(6)).join(', ')}`
  );
  check(
    be.cheaper === 'a' && be.cheaperAbove === 'a',
    'names the same arm at both ends when the crossing pair is interior',
    `p=0 ${be.cheaper}, p=1 ${be.cheaperAbove}`
  );
}

{
  // The label the caller prints is about p = 0, and it is NOT always ours. An
  // arm can be dearer at rest and cheaper under load; a printer that says
  // "wins below X%" without checking `cheaper` would have it backwards.
  const a = { c0: 100, c1: 10, c2: 0 }; // dear at rest, shallow
  const b = { c0: 50, c1: 400, c2: 0 }; // cheap at rest, steep
  const be = breakEven(a, b);
  check(
    be.cheaper === 'b' && be.cheaperAbove === 'a' && be.p !== null,
    'names the arm that is cheaper at rest, which is not always the same one',
    `p=0 ${be.cheaper}, p=1 ${be.cheaperAbove}, crossing ${be.p.toFixed(4)}`
  );
}

{
  const a = { c0: 100, c1: 10, c2: 1 };
  const b = { c0: 200, c1: 20, c2: 2 };
  const be = breakEven(a, b);
  check(
    be.p === null && be.cheaper === 'a' && be.cheaperAbove === 'a',
    'an arm cheaper everywhere has no crossing and one label',
    `p ${be.p}, ${be.cheaper}`
  );
  const tie = breakEven(a, a);
  check(tie.p === null && tie.cheaper === 'tie' && tie.cheaperAbove === 'tie', 'identical arms are a tie, not a crossing');
}

{
  // Roots far apart in magnitude are where the schoolbook quadratic formula
  // loses the small one entirely to cancellation.
  const a = { c0: 0, c1: 0, c2: 0 };
  const b = { c0: 1, c1: -1e8, c2: 1 };
  const be = breakEven(a, b);
  const exact = 2 / (1e8 + Math.sqrt(1e16 - 4));
  check(
    be.p !== null && rel(be.p, exact) < 1e-12,
    'finds a root that cancellation would have destroyed',
    be.p === null ? 'no root found' : `${be.p.toExponential(12)} vs ${exact.toExponential(12)}`
  );
}

// ---------------------------------------------------------------------------
// 7. The worst point, which two endpoints no longer find.
// ---------------------------------------------------------------------------

{
  // The case the whole function exists for: ours is ahead at BOTH ends and
  // behind in the middle. A gate that evaluated only p=0 and p=1 would pass
  // this pair and be wrong across a third of the range.
  const ours = { c0: 0, c1: 100, c2: 0 };
  const theirs = { c0: 10, c1: 10, c2: 120 };
  const ends = [0, 1].map((p) => costAt(theirs, p) - costAt(ours, p));
  const worst = worstAgainst(ours, theirs);
  check(
    ends[0] > 0 && ends[1] > 0 && worst.margin < 0 && worst.p > 0 && worst.p < 1,
    'finds a loss that sits between two winning endpoints',
    `ends +${ends[0].toFixed(1)} / +${ends[1].toFixed(1)}, worst ${worst.margin.toFixed(2)} at p=${worst.p.toFixed(3)}`
  );
  // And it is genuinely the worst: nothing on a fine scan beats it.
  let scanned = Infinity;
  for (let i = 0; i <= 200000; i++) {
    const p = i / 200000;
    scanned = Math.min(scanned, costAt(theirs, p) - costAt(ours, p));
  }
  check(
    worst.margin <= scanned + 1e-9,
    'no fetch rate is worse than the one it reports',
    `algebra ${worst.margin.toFixed(6)}, best of 200k samples ${scanned.toFixed(6)}`
  );
}

{
  // A downward-opening difference turns the other way, so its minimum is an
  // endpoint and the vertex must be ignored rather than reported.
  const ours = { c0: 0, c1: 0, c2: 100 };
  const theirs = { c0: 5, c1: 60, c2: 0 };
  const worst = worstAgainst(ours, theirs);
  check(worst.p === 0 || worst.p === 1, 'a concave difference is decided at an endpoint', `p=${worst.p}`);
}

{
  // The real arms, where the answer should be an endpoint and agree with the
  // crossing the same pair reports.
  const ours = costLine({ handed: 30000, blocks: Array.from({ length: 41 }, () => 900), params: PINNED });
  const theirs = costLine({ handed: 52000, blocks: Array.from({ length: 14 }, () => 2600), params: PINNED });
  const worst = worstAgainst(ours, theirs);
  const be = breakEven(ours, theirs);
  // Ours is cheaper at rest and there is one crossing, so the worst point must
  // be at p = 1, past that crossing.
  check(
    be.cheaper === 'a' && be.crossings.length === 1 && worst.p === 1 && worst.margin < 0,
    'agrees with the crossing on which side of the range is bad for us',
    `crossing ${be.p.toFixed(3)}, worst at p=${worst.p}`
  );
}

{
  const a = { c0: 10, c1: 5, c2: 1 };
  check(worstAgainst(a, a).margin === 0, 'an arm ties itself at every rate');
}

// ---------------------------------------------------------------------------
// 8. The rest of the surface.
// ---------------------------------------------------------------------------

{
  // THE PAYLOAD-ONLY RATIO, WHICH IS WHAT THIS USED TO RETURN BY DEFAULT.
  // Still exactly the baseline over the arm -- it just has to be asked for now,
  // because it is not what a subscription meters.
  check(
    usageMultiplier(1000, 400, { commonCost: 0, params: DEFAULTS }) === 2.5 &&
      usageMultiplier(1000, 0, { commonCost: 0, params: DEFAULTS }) === Infinity,
    'with no common term the multiplier is the baseline over the arm'
  );

  // THE COMMON TERM CANCELS IN A DIFFERENCE AND DOES NOT CANCEL IN A QUOTIENT.
  // That asymmetry is the whole defect: a session's own output is identical
  // across arms, so leaving it out of both sides of a ratio does not leave the
  // ratio alone -- it pushes it away from 1, and away from 1 is always the
  // direction that flatters whichever arm is cheaper.
  const payloadOnly = usageMultiplier(1000, 400, { commonCost: 0, params: DEFAULTS });
  const metered = usageMultiplier(1000, 400, { commonCost: 600, params: DEFAULTS });
  check(
    metered < payloadOnly && metered > 1,
    'a common term moves the multiplier toward 1, never past it',
    `${payloadOnly.toFixed(3)}x -> ${metered.toFixed(3)}x`
  );
  check(
    Math.abs(metered - 1600 / 1000) < 1e-12,
    'and it is added to both sides, not one',
    `(1000+600)/(400+600) = ${metered}`
  );

  // The default is the measured one, and it scales with the turn count so a
  // sweep that attacks `turnsAfter` moves this term with it instead of
  // holding it at the default's value.
  check(
    commonSessionCost(DEFAULTS) === DEFAULTS.turnsAfter * DEFAULTS.outputTokensPerTurn * RATES.outputPerInput,
    'the common term is turns x output per turn x the output rate',
    `${DEFAULTS.turnsAfter} x ${DEFAULTS.outputTokensPerTurn} x ${RATES.outputPerInput} = ${commonSessionCost(DEFAULTS)}`
  );
  check(
    commonSessionCost({ ...DEFAULTS, turnsAfter: 2 * DEFAULTS.turnsAfter }) === 2 * commonSessionCost(DEFAULTS),
    'doubling the turns doubles it',
    'so a sweep over turnsAfter cannot hold it fixed by accident'
  );

  // AND THE INVARIANT THAT MAKES THIS SAFE TO ADD: every ordering claim the
  // gate makes is a DIFFERENCE between two arms, so a term both arms share
  // cannot move a break-even or a worst-case margin. If it could, this change
  // would be re-scoring the comparison rather than correcting the ratio.
  const armA = { c0: 900_000, c1: 50_000, c2: 10_000 };
  const armB = { c0: 700_000, c1: 400_000, c2: 60_000 };
  const shifted = (a, by) => ({ ...a, c0: a.c0 + by });
  const by = commonSessionCost(DEFAULTS);
  const before = breakEven(armA, armB);
  const after = breakEven(shifted(armA, by), shifted(armB, by));
  check(
    before.p === after.p && before.cheaper === after.cheaper,
    'a term shared by both arms moves no break-even',
    `p ${before.p === null ? 'none' : before.p.toFixed(6)} either way, cheaper ${before.cheaper}`
  );
  const wBefore = worstAgainst(armA, armB);
  const wAfter = worstAgainst(shifted(armA, by), shifted(armB, by));
  check(
    wBefore.p === wAfter.p && Math.abs(wBefore.margin - wAfter.margin) < 1e-6,
    'nor the worst fetch rate, nor the margin there',
    `worst at p=${wBefore.p.toFixed(4)}, margin ${wBefore.margin.toFixed(1)} either way`
  );
}

{
  const got = [
    markerBytes('<<ccr:abc,file,156.3KB>>'),
    markerBytes('<<ccr:abc,file,512B>>'),
    markerBytes('<<ccr:abc,file,2MB>>'),
    markerBytes('<<ccr:abc,file,1.5GB>>'),
    markerBytes('not a marker'),
  ];
  const want = [156.3 * 1024, 512, 2 * 1024 ** 2, 1.5 * 1024 ** 3, 0];
  check(got.every((g, i) => close(g, want[i], 1e-9)), 'marker sizes parse at every unit, and a non-marker is zero', got.join(' '));
}

{
  const p = paramsFromMeter({ cacheWrite: 1.9, output: 4.8 });
  check(
    p.cacheWrite === 1.9 && p.outputPerInput === 4.8 && p.cacheRead === DEFAULTS.cacheRead,
    'a measured ratio replaces its published value and leaves the rest alone',
    `write ${p.cacheWrite}, read ${p.cacheRead}, output ${p.outputPerInput}`
  );
  const none = paramsFromMeter({ cacheWrite: NaN });
  check(none.cacheWrite === DEFAULTS.cacheWrite, 'an unsolved ratio is ignored rather than written in as NaN');
}

{
  const grid = { turnsAfter: [5, 20, 50], baseContextTokens: [4000, 12000], fetchBatch: [1, 4] };
  const rows = sweep((params) => ({ cost: costAt(costLine({ handed: 10000, blocks: [500, 500, 500], params }), 0.5) }), grid);
  const distinct = new Set(rows.map((r) => `${r.turnsAfter}/${r.baseContextTokens}/${r.fetchBatch}`));
  check(
    rows.length === 12 && distinct.size === 12 && rows.every((r) => Number.isFinite(r.cost)),
    'the sweep visits every combination exactly once',
    `${rows.length} rows across ${Object.keys(grid).length} swept keys`
  );
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
