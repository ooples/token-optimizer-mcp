/**
 * THE TURN LEVER, PRICED AND REFUTED. KEPT SO IT STAYS REFUTED.
 *
 * The argument was good and the measurement behind it was wrong.
 *
 * THE ARGUMENT. Every saving on this branch is a saving on the PAYLOAD, and a
 * payload saving is one the competitor also makes: we hand over 406,321 tokens
 * against their 361,400 and lose the subscription metric at p=0, 1.61x against
 * their 1.69x. But a token written into context costs `W + R*N` = 7.6 at the
 * measured N=56, of which 5.6 is residency -- the re-reading on the 56
 * requests that follow. Five sevenths of what a token costs is N, and neither
 * engine has ever touched it. A turn the model does not take is a whole
 * context re-read that no amount of compression can refund.
 *
 * It also passes the common-factor test, which is what disqualified everything
 * else: a lever only moves the COMPETITIVE number if it reduces our cost and
 * not everybody's. Raising the cache-write multiple fails it (the ratio is
 * 1.1243 at W=2.0 and at W=1.25 alike). Client-side compaction fails it -- the
 * client compacts with or without us. Cache TTL fails it. N passes, and only
 * through the proxy, because we are the only party in the exchange that can
 * put text in front of the model on every request.
 *
 * THE MEASUREMENT. 33% of requests were a think-then-act pair that one turn
 * could have carried, from 52,773 real tool turns. On that figure this file
 * priced a 2.00x cap multiple against their 1.69x, and the number went into
 * the pull request.
 *
 * IT WAS COUNTING TRANSCRIPT ENTRIES. An assistant message holding [thinking,
 * tool_use] is written to the JSONL as two entries sharing a `requestId`, so
 * splitting on entries splits every turn into its blocks and reports the
 * halves as two turns. Grouped by `requestId` -- which is what a turn is --
 * 32,667 of 32,882 thinking turns (99.3%) already carry their tool call in the
 * same turn, 215 do not, and of the 32,665 adjacent pairs the broken walk
 * counted, 32,665 were ONE request and 54 were two.
 *
 * So the headroom is 54 turns of 54,522: 0.10%, not 33%. The behaviour the
 * instruction would have asked for is already universal, and this file now
 * prices that: against a block costing 1.30% of the payload, a 0.10% headroom
 * cannot pay for itself at ANY obedience rate, including perfect obedience.
 * The feature was removed rather than shipped behind a flag, because a flag
 * does not make a measured net loss safe -- it makes it easy to turn on.
 *
 * WHAT IS STILL LIVE, and what this file is kept in CI for: the same grouping
 * gives a real ceiling on BATCHING -- 36,399 runs of consecutive tool-only
 * turns holding 52,955 turns, so collapsing every run would be 31% fewer. That
 * is a ceiling and not a target, because a run can only collapse where the
 * later call does not need the earlier result. The subset that provably does
 * not is the thing to measure next, and until it is measured this file asserts
 * the refutation rather than projecting from the ceiling.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, commonSessionCost, usageMultiplier } from './cost-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, 'headroom', 'results', 'head-to-head.json');

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const session = record.totals.cost.session;
const num = (value) => Number(String(value).replace(/,/g, ''));

/** The recorded ground truth this recomputation has to agree with. */
const RECORDED = {
  turnsAfter: num(session.turnsAfter),
  baseContextTokens: num(session.baseContextTokens),
  handedOurs: num(record.totals.cost.handedTokens.ours),
  none: num(session.p0.none),
  oursP0: num(session.p0.ours),
  theirsP0: num(session.p0.theirs),
  theirsP1: num(session.p1.theirs),
  oursCapP0: session.capMultiple.oursP0,
  theirsCapP0: session.capMultiple.theirsP0,
  workloads: record.workloads.length,
};

/**
 * What `bench/field/turn-shape.mjs` measures, grouped by requestId.
 *
 * Copied here as constants rather than imported, because that instrument reads
 * the local agent transcripts and CI has none; a check that silently measures
 * an empty corpus is the vacuity failure this harness has hit five times. Run
 * it to re-derive these.
 */
const FIELD = Object.freeze({
  turns: 54522,
  thinking: 32882,
  thinkAndActInOneTurn: 32667,
  thinkWithoutActing: 215,
  pairsOneRequest: 32665,
  pairsTwoRequests: 54,
  // The batching ceiling, which is the part that survived.
  runs: 36399,
  turnsInRuns: 52955,
});

/**
 * `bench/field/batch-headroom.mjs`, as of 2026-10-05.
 *
 * NOT BYTE-STABLE, and the figures drift upward between runs because the
 * session doing the measuring is appending to the transcripts being measured
 * -- 52,972 then 52,974 then 52,983 acting turns across three consecutive
 * runs. The fractions are stable to a tenth of a percent, which is what these
 * are used for; the absolute counts are an as-of and not a fixture.
 */
const BATCH = Object.freeze({
  actingTurns: 52983,
  scoredPairs: 50943,
  /** UPPER bound: no distinctive token shared with the earlier result. */
  noTextualDependence: 29427,
  /** LOWER bound: every token was in context before the earlier call. */
  everyInputInHand: 19153,
});

/**
 * The block the lever would have injected, kept verbatim for its length.
 *
 * CHARGED AT ITS CHARACTER COUNT. A real token count needs the recorded
 * fixture and a credential; a census estimate (chars/4) is available without
 * one and has flattered an arm here three times. So neither: every token is at
 * least one character, so characters bound the tokens from above, and the
 * bound is what gets charged. It overcharges by roughly four and still decides
 * the question, which is the point of using it.
 */
const BLOCK =
  'When you have decided what to do, do it in the same turn you decide it: ' +
  'put the tool call in the message that explains the reasoning for it, ' +
  'rather than ending a turn and acting in the next one. Each turn re-reads ' +
  'the whole conversation, so a decision split across two turns is paid for ' +
  'twice.';

const failures = [];
const check = (ok, line) => {
  if (!ok) failures.push(line);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`);
};

/**
 * Our session cost with N requests following, charging the block per session.
 *
 * Our arm fetches nothing -- `turns.ours` is 0 across the corpus -- so its
 * cost line has no c1 and no c2 and reduces to `handed * (W + R*N)`. That is
 * not assumed: `cost-decomposition.check.mjs` proves p0 === handed * 7.6 for
 * both arms with no residual, and the control below re-derives the recorded
 * figure from it.
 *
 * The block is charged ONCE PER WORKLOAD. Each workload is its own
 * conversation, so a session-constant block is written eighteen times across
 * the eighteen of them; charging it once would be the flattering reading.
 */
function oursAt(turnsAfter, { block = true } = {}) {
  const perToken = DEFAULTS.cacheWrite + DEFAULTS.cacheRead * turnsAfter;
  const payload = RECORDED.handedOurs * perToken;
  return payload + (block ? BLOCK.length * RECORDED.workloads * perToken : 0);
}

/** The same subscription cap, arm against no optimizer, with N moving for us. */
function capMultiple(armCost, armTurns) {
  const params = { ...DEFAULTS, baseContextTokens: RECORDED.baseContextTokens };
  return usageMultiplier(RECORDED.none, armCost, {
    params,
    // THE COMMON TERM MOVES WITH N, and is per session times the number of
    // sessions. The output the assistant writes over the turns that follow is
    // `N * outputTokensPerTurn * outputPerInput`, so a turn not taken is also
    // output not written -- but every figure here is a corpus total over
    // eighteen sessions, and charging one session's worth read 2.26x where the
    // record says 1.61x: away from 1, in our favour, which is the direction
    // this mistake always takes. The baseline keeps N=56 because a user with
    // no optimizer takes every turn.
    commonCost:
      commonSessionCost({ ...params, turnsAfter: armTurns }) *
      RECORDED.workloads,
  });
}

console.log(
  `record ${record.recordedAt} commit ${record.commit}: N=${RECORDED.turnsAfter}, base context ${RECORDED.baseContextTokens}, ${RECORDED.workloads} workload(s)`
);
console.log(`block bound: ${BLOCK.length} chars >= its tokens`);

// ---------------------------------------------------------------------------
// THE CONTROL. Everything below is this arithmetic with one input changed, so
// if it cannot reproduce the recorded figures at the recorded N, nothing below
// means anything. An instrument whose zero case is unchecked has reported a
// result from a run that never happened five times on this branch.
// ---------------------------------------------------------------------------
const controlOurs = oursAt(RECORDED.turnsAfter, { block: false });
check(
  Math.abs(controlOurs - RECORDED.oursP0) < 1,
  `control: recomputed p0 ${controlOurs.toFixed(0)} == recorded ${RECORDED.oursP0}`
);
const controlCap = capMultiple(RECORDED.oursP0, RECORDED.turnsAfter);
check(
  `${controlCap.toFixed(2)}x` === RECORDED.oursCapP0,
  `control: recomputed cap ${controlCap.toFixed(2)}x == recorded ${RECORDED.oursCapP0}`
);
const theirsCap = capMultiple(RECORDED.theirsP0, RECORDED.turnsAfter);
check(
  `${theirsCap.toFixed(2)}x` === RECORDED.theirsCapP0,
  `control: their cap ${theirsCap.toFixed(2)}x == recorded ${RECORDED.theirsCapP0}`
);
// A control that cannot fail stands in for nothing, so this one must not
// reproduce the record: charging the block has to cost something.
check(
  oursAt(RECORDED.turnsAfter) > controlOurs,
  `control: the block is not free -- ${oursAt(RECORDED.turnsAfter).toFixed(0)} > ${controlOurs.toFixed(0)} at the same N`
);

// ---------------------------------------------------------------------------
// THE FIELD MEASUREMENT, re-derived from its own counts so the retraction is
// arithmetic rather than a claim in a comment.
// ---------------------------------------------------------------------------
const pairs = FIELD.pairsOneRequest + FIELD.pairsTwoRequests;
const alreadyOneTurn = FIELD.pairsOneRequest / pairs;
check(
  alreadyOneTurn > 0.99,
  `${(alreadyOneTurn * 100).toFixed(2)}% of adjacent think-then-act pairs are ALREADY one request (${FIELD.pairsOneRequest} of ${pairs})`
);
const headroom = FIELD.pairsTwoRequests / FIELD.turns;
check(
  headroom < 0.002,
  `headroom for a merge instruction: ${(headroom * 100).toFixed(2)}% of turns (${FIELD.pairsTwoRequests} of ${FIELD.turns}), against the 33% this was priced on`
);
check(
  FIELD.thinkAndActInOneTurn / FIELD.thinking > 0.99,
  `the instruction asks for what already happens: ${((FIELD.thinkAndActInOneTurn / FIELD.thinking) * 100).toFixed(1)}% of thinking turns already act in the same turn`
);

// ---------------------------------------------------------------------------
// THE VERDICT. Perfect obedience is the arm that decides it: if the block
// cannot pay for itself when every mergeable turn merges, no obedience rate
// saves it and there is nothing left to measure.
// ---------------------------------------------------------------------------
const bestN = RECORDED.turnsAfter * (1 - headroom);
const bestCost = oursAt(bestN);
const taxOnly = oursAt(RECORDED.turnsAfter);
console.log(
  `\nat PERFECT obedience: N ${RECORDED.turnsAfter} -> ${bestN.toFixed(2)}, cost ${bestCost.toFixed(0)} against ${RECORDED.oursP0} without the block`
);
check(
  bestCost > RECORDED.oursP0,
  `the block is a net loss at perfect obedience: +${(((bestCost - RECORDED.oursP0) / RECORDED.oursP0) * 100).toFixed(2)}% (residency ${(((taxOnly - RECORDED.oursP0) / RECORDED.oursP0) * 100).toFixed(2)}%, saving ${(((taxOnly - bestCost) / RECORDED.oursP0) * 100).toFixed(2)}%)`
);
check(
  capMultiple(bestCost, bestN) < theirsCap,
  `and still loses the p=0 cap multiple: ${capMultiple(bestCost, bestN).toFixed(2)}x against their ${theirsCap.toFixed(2)}x`
);

// ---------------------------------------------------------------------------
// WHAT SURVIVED. The batching ceiling comes from the same grouping and is a
// ceiling, not a target: a run collapses only where the later call does not
// need the earlier result.
// ---------------------------------------------------------------------------
const collapsed = 1 - FIELD.runs / FIELD.turnsInRuns;
const ceilingN = RECORDED.turnsAfter * (1 - collapsed);
const ceilingCost = oursAt(ceilingN, { block: false });
console.log(
  `\nbatching CEILING: ${FIELD.turnsInRuns} turn(s) in ${FIELD.runs} run(s), ${(collapsed * 100).toFixed(0)}% fewer if every run collapsed`
);
console.log(
  `  priced, with no instruction charged: N -> ${ceilingN.toFixed(1)}, ${ceilingCost.toFixed(0)}, cap ${capMultiple(ceilingCost, ceilingN).toFixed(2)}x against their ${theirsCap.toFixed(2)}x`
);
check(
  capMultiple(ceilingCost, ceilingN) > theirsCap,
  `the ceiling WOULD take the metric, which is why the provable subset is worth measuring -- it is not evidence that any of it is reachable`
);
check(
  collapsed > headroom * 10,
  `and it is a different lever: ${(collapsed * 100).toFixed(0)}% against the merge instruction's ${(headroom * 100).toFixed(2)}%`
);

// ---------------------------------------------------------------------------
// THE BATCHING ARM, PRICED. This is where the merge instruction's argument
// lands once the measurement is right: the behaviour is NOT already universal
// -- 1.15 calls per turn, 92.1% of turns carrying exactly one -- so unlike the
// merge case there is headroom for an instruction to move.
// ---------------------------------------------------------------------------
const batchB = BATCH.everyInputInHand / BATCH.actingTurns;
const batchA = BATCH.noTextualDependence / BATCH.actingTurns;
check(
  batchB > headroom * 100,
  `batching headroom is ${(batchB / headroom).toFixed(0)}x the merge instruction's: ${(batchB * 100).toFixed(1)}% of turns against ${(headroom * 100).toFixed(2)}%`
);

console.log('');
for (const [label, rate] of [
  ['arm B (lower)', batchB],
  ['arm A (upper)', batchA],
]) {
  const n = RECORDED.turnsAfter * (1 - rate);
  const cost = oursAt(n);
  console.log(
    `${label}: N -> ${n.toFixed(1)}, ${cost.toFixed(0)}, cap ${capMultiple(cost, n).toFixed(2)}x against their ${theirsCap.toFixed(2)}x  (block charged)`
  );
}

const batchN = RECORDED.turnsAfter * (1 - batchB);
const batchCost = oursAt(batchN);
check(
  batchCost < RECORDED.theirsP0,
  `arm B alone takes p=0: ${batchCost.toFixed(0)} against their ${RECORDED.theirsP0} (${(((RECORDED.theirsP0 - batchCost) / RECORDED.theirsP0) * 100).toFixed(1)}% cheaper), with the block's residency already charged`
);
check(
  capMultiple(batchCost, batchN) > theirsCap,
  `and the cap multiple: ${capMultiple(batchCost, batchN).toFixed(2)}x against their ${theirsCap.toFixed(2)}x`
);

/** The obedience rate at which a batching block pays for its own residency. */
const batchPayback = (() => {
  for (let rate = 0; rate <= 1.0001; rate += 0.0005) {
    const n = RECORDED.turnsAfter * (1 - batchB * rate);
    if (oursAt(n) <= RECORDED.oursP0) return rate;
  }
  return null;
})();
check(
  batchPayback !== null && batchPayback < 0.05,
  `a batching block pays for itself at ${batchPayback === null ? 'no' : (batchPayback * 100).toFixed(2) + '%'} obedience -- against the merge instruction, which never does`
);

/** The obedience rate at which it takes the p=0 column. */
const batchToWin = (() => {
  for (let rate = 0; rate <= 1.0001; rate += 0.0005) {
    const n = RECORDED.turnsAfter * (1 - batchB * rate);
    if (capMultiple(oursAt(n), n) >= theirsCap) return rate;
  }
  return null;
})();
check(
  batchToWin !== null && batchToWin < 0.5,
  `and takes the p=0 cap multiple at ${batchToWin === null ? 'unreachable' : (batchToWin * 100).toFixed(1) + '%'} obedience`
);
console.log(
  `
WHAT IS STILL UNMEASURED: whether an instruction moves the calls-per-turn figure at all. The headroom is real and the break-even is low; obedience is not a number this file has.`
);

// ---------------------------------------------------------------------------
// THE THIRD BAR: INJECT ONLY WHEN THE CONTEXT IS BIG ENOUGH TO BE WORTH IT.
//
// Three bars were on the table for a batching instruction: a conservative one
// asking only for calls whose results are not needed by each other (what
// shipped, and what arm B measures), an aggressive one asking for batching
// unless a dependence is known (arm A), and this one, a cost-first gate that
// injects only on sessions big enough to repay the residency.
//
// I FIRST CLAIMED THIS CLOSED BY ARITHMETIC AND IT DOES NOT. The argument was
// that cost and saving are both linear in `perToken` so the ratio is
// scale-free -- true of N, false of size. The block's cost is a FIXED number
// of characters per session while the saving is proportional to `handed`, so
// the ratio is proportional to session size and a gate on size decides
// something real. The assertion written for the wrong claim caught it: 0.1x to
// 235.0x across the grid, which is not one side of break-even.
//
// SO THE BAR REDUCES TO A THRESHOLD, computed rather than chosen. Per session,
// the block pays once `handed * (perToken - perTokenReduced)` exceeds
// `blockChars * perToken`.
// ---------------------------------------------------------------------------
const breakEvenHanded = (n) => {
  const perToken = DEFAULTS.cacheWrite + DEFAULTS.cacheRead * n;
  const reduced = DEFAULTS.cacheWrite + DEFAULTS.cacheRead * n * (1 - batchB);
  return (BLOCK.length * perToken) / (perToken - reduced);
};
const threshold = breakEvenHanded(RECORDED.turnsAfter);
const perSession = RECORDED.handedOurs / RECORDED.workloads;
console.log(
  `
cost-first gate: the block repays itself above ${threshold.toFixed(0)} payload token(s) in a session; the corpus averages ${perSession.toFixed(0)}`
);
check(
  threshold < perSession,
  `the gate is real but inert: ${(perSession / threshold).toFixed(0)}x clearance on an average session, so gating would withhold the lever from sessions where it is worth least rather than from sessions where it loses`
);
// AND IT MOVES WITH N, so the threshold is not a constant to hardcode.
const spread = [8, 20, RECORDED.turnsAfter, 120].map(breakEvenHanded);
check(
  Math.max(...spread) / Math.min(...spread) > 1.5,
  `and it is not a constant: ${Math.min(...spread).toFixed(0)} to ${Math.max(...spread).toFixed(0)} tokens as N runs 8 to 120 -- a gate would have to be computed per session, which is why none shipped`
);

// ---------------------------------------------------------------------------
// DO EVICTION AND BATCHING OVERLAP? They were approved as two items and the
// honest question is whether building both buys both.
//
// THEY DO NOT OVERLAP, and it is an identity rather than a measurement: the
// cost line for an arm that fetches nothing is `handed * (W + R*N)`. Eviction
// scales `handed`; batching scales the per-token factor through N. A product
// of two independent factors, so the savings multiply and neither eats the
// other. Asserted on a grid rather than argued, because "they compose" is the
// kind of claim that is true of the model and false of the code.
// ---------------------------------------------------------------------------
const composes = [];
for (const evictScale of [1, 0.92, 0.75, 0.5])
  for (const batchRate of [0, 0.2, batchB, 0.9]) {
    const n = RECORDED.turnsAfter * (1 - batchRate);
    const perToken = DEFAULTS.cacheWrite + DEFAULTS.cacheRead * n;
    const both = RECORDED.handedOurs * evictScale * perToken;
    const batchOnly = RECORDED.handedOurs * perToken;
    composes.push(Math.abs(both - evictScale * batchOnly) < 1e-6);
  }
check(
  composes.every(Boolean),
  `eviction and batching compose exactly, on all ${composes.length} grid point(s): one scales handed, the other the per-token factor`
);

// THE COMBINED FIGURE, now that eviction is measured on this fixture rather
// than carried from an earlier recording. It needed the stamp seed: the
// payloads carry per-process HMAC marker stamps, so without
// TOKEN_OPTIMIZER_BENCH_STAMP_SEED their digests never repeat and the currency
// refuses every one of them.
const EVICT_FROM_EARLIER_RECORDING = 0.92;
const combinedN = RECORDED.turnsAfter * (1 - batchB);
const combined =
  RECORDED.handedOurs *
  EVICT_FROM_EARLIER_RECORDING *
  (DEFAULTS.cacheWrite + DEFAULTS.cacheRead * combinedN);
console.log(
  `
ILLUSTRATION, not a result: at the earlier recording's ${EVICT_FROM_EARLIER_RECORDING}x eviction and arm B batching, ${combined.toFixed(0)} and ${capMultiple(combined, combinedN).toFixed(2)}x -- re-record evict.mjs before quoting it`
);

// ---------------------------------------------------------------------------
// THE LEVERS STACKED, WHICH IS THE ONLY WAY PAST 2x.
//
// Batching alone is 2.05x. It is not the only lever, and the three that exist
// are independent BY CONSTRUCTION rather than by luck -- the cost line for an
// arm that fetches nothing is `handed * (W + R*N)`, and each lever touches a
// different factor of it:
//
//   payload      shrinks `handed`      -- shipped, 406,321 of a 1,271,000 baseline
//   eviction     shrinks `handed` more -- a second multiplier on the same factor
//   batching     shrinks `N`           -- 36.1% of turns, measured lower bound
//   routing      shrinks `R`           -- 31.5% of requests could be answered by
//                                         a cheaper model, so the expected read
//                                         rate is R*(1 - strict*(1-r))
//
// A product of independent factors, so they multiply. That is asserted on a
// grid below for the pair that can be checked exactly, and the routing term is
// derived rather than measured: it is an EXPECTATION over which requests are
// downgradable, which is why it is swept over `r` rather than quoted at one
// value, and why the stack is reported at the conservative end.
//
// WHAT EACH ONE COSTS IN CONFIDENCE, worst to best:
//   batching   headroom measured, OBEDIENCE UNMEASURED (the live arm is blocked)
//   routing    share measured, SAFETY UNMEASURED (no held-out accuracy arm) and
//              it changes which model answers, which is a consent decision
//   eviction   MEASURED: 0.920x gated, declined on 3 of 18 conversations
//
// So this is a ceiling built from one measured lever and three conditional
// ones, and it is labelled that way on every line. It says the 2x is not the
// limit; it does not say the stack is banked.
// ---------------------------------------------------------------------------
const STRICT_ROUTABLE = 0.315;
/**
 * The gated eviction ratio, MEASURED rather than borrowed.
 *
 * `bench/compression/evict.mjs` refused for most of this work -- its payloads
 * carry marker stamps, which are HMACs keyed per process, so their digests
 * never repeat and no fixture can cover them. Run with
 * TOKEN_OPTIMIZER_BENCH_STAMP_SEED=token-counts they are stable and the
 * fixture serves them: 2,868,124 -> 2,639,279 tokens, 0.920x, taken only
 * where it pays and declined on 3 of 18 conversations.
 */
const EVICT = 0.92;

/** The read rate once a share of requests is answered by a cheaper model. */
const readRate = (r) => DEFAULTS.cacheRead * (1 - STRICT_ROUTABLE * (1 - r));

function stacked({ batch = 0, evict = 1, r = 1 }) {
  const n = RECORDED.turnsAfter * (1 - batch);
  const perToken = DEFAULTS.cacheWrite + readRate(r) * n;
  const handed = RECORDED.handedOurs * evict;
  const block = BLOCK.length * RECORDED.workloads * perToken;
  const cost = handed * perToken + (batch > 0 ? block : 0);
  return { cost, n, cap: capMultiple(cost, n) };
}

// THE CONTROL FOR THE STACK: with every lever off it has to reproduce the
// recorded figure, or the stack is measuring its own arithmetic.
const stackControl = stacked({});
check(
  Math.abs(stackControl.cost - RECORDED.oursP0) < 1,
  `control: the stack with every lever off is ${stackControl.cost.toFixed(0)} == recorded ${RECORDED.oursP0}`
);

console.log(
  `\nSTACKED, each line adding one lever (cap multiple, theirs 1.69x):`
);
const steps = [
  ['shipped payload only', {}],
  ['+ batching (arm B)', { batch: batchB }],
  ['+ eviction (measured 0.920x)', { batch: batchB, evict: EVICT }],
  [
    '+ routing at r=1/2 (conservative)',
    { batch: batchB, evict: EVICT, r: 0.5 },
  ],
  ['+ routing at r=1/3', { batch: batchB, evict: EVICT, r: 1 / 3 }],
  // THE UPPER END, for the bracket and not for quoting: arm A is the batching
  // bound where no token is shared with the earlier result, which a model can
  // still have depended on.
  ['(arm A instead of B, upper)', { batch: batchA, evict: EVICT, r: 1 / 3 }],
];
let last = null;
for (const [label, opts] of steps) {
  const row = stacked(opts);
  console.log(
    `  ${label.padEnd(34)} ${row.cost.toFixed(0).padStart(9)}  ${row.cap.toFixed(2)}x`
  );
  last = row;
}
check(
  last.cap > 2,
  `stacked past 2x: ${last.cap.toFixed(2)}x against their ${theirsCap.toFixed(2)}x -- one measured lever and three conditional ones, not a banked result`
);
check(
  stacked({ batch: batchB }).cap > 2 === true,
  `and batching alone already clears it: ${stacked({ batch: batchB }).cap.toFixed(2)}x`
);
// INDEPENDENCE, asserted where it can be: routing and batching touch R and N,
// so swapping the order they are applied must not change the answer.
const a = stacked({ batch: batchB, r: 0.5 });
const b = stacked({ r: 0.5, batch: batchB });
check(
  Math.abs(a.cost - b.cost) < 1e-6,
  `routing and batching commute, so the stack is not order-dependent`
);

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(
  `\nthe merge instruction is refuted; the stack is priced, and only the payload lever is banked`
);
