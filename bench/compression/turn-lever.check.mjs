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

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nthe merge instruction is refuted; the batching ceiling stands');
