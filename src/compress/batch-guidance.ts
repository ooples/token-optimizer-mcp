/**
 * A BATCHING INSTRUCTION, WHICH IS THE ONE LEVER ON N THAT SURVIVED.
 *
 * WHY N AT ALL. A token written into context costs `W + R*N` -- 2.0 to write
 * it, then 0.1 on each of the N requests that follow -- which at the measured
 * N=56 is 7.6, of which 5.6 is residency. Five sevenths of what a token costs
 * is the re-reading, so N is the larger half of the bill, and every saving on
 * this branch until now has been a saving on the payload instead.
 *
 * WHY IT HAS TO BE OURS. A lever only moves the competitive number if it cuts
 * our cost and not everybody's. The cache-write multiple fails that test (the
 * ratio is 1.1243 at W=2.0 and at W=1.25 alike); client-side compaction fails
 * it, because the client compacts with or without us; cache TTL fails it. N
 * passes, and only through the proxy: we are the only party in the exchange
 * that can put text in front of the model on every request, and a turn the
 * model does not take is a whole context re-read that no compression refunds.
 *
 * WHY BATCHING AND NOT THE OTHER ONE. The first instruction written here asked
 * the model to act in the turn it decides in, priced on a measured 33% of
 * requests being a think-then-act pair. That figure was an artefact of counting
 * transcript entries instead of grouping them by `requestId`: grouped, 99.3% of
 * thinking turns ALREADY act in the same turn and the headroom is 0.10% of
 * turns, against a block costing 1.30% of the payload. It was a net loss at
 * perfect obedience and the module was deleted.
 *
 * Batching is the opposite case. The behaviour is demonstrably not happening --
 * 1.15 tool calls per turn, 92.1% of turns carrying exactly one -- and
 * `bench/field/batch-headroom.mjs` brackets how much of that is reachable from
 * real transcripts: 37.6% of adjacent pairs inside a run had every distinctive
 * token of the later call already in context before the earlier call went out
 * (the lower bound), and 57.8% shared no token with the earlier result at all
 * (the upper). The lower bound alone removes 36.1% of acting turns, takes N to
 * 35.8, and prices at 2.05x against the competitor's 1.69x with the block's own
 * residency charged -- see `bench/compression/turn-lever.check.mjs`, which also
 * says the block pays for itself at 4.85% obedience and takes the p=0 column at
 * 27.5%.
 *
 * WHAT IS NOT MEASURED: whether an instruction moves calls-per-turn at all.
 * Neither bracket arm measures logical dependence -- a model can hold every
 * token of a call in hand and still be right to wait for the previous result
 * before deciding to make it. So this ships OFF, and the thing that would turn
 * it on is an obedience measurement, not an argument.
 */

/** The environment variable an operator sets to enable the block. */
export const BATCH_GUIDANCE_ENV = 'TOKEN_OPTIMIZER_BATCH_GUIDANCE';

/**
 * Short on purpose.
 *
 * Every character sits in the cached prefix for the life of the session and is
 * charged `W + R*N` once and `R` on every turn after, so a sentence that does
 * not change behaviour is a permanent tax. The break-even above is quoted for
 * THIS text at THIS length; a longer one raises it.
 *
 * THIS IS THE AGGRESSIVE WORDING, AND THE CONSERVATIVE ONE IT REPLACES WAS
 * MEASURED AS A NET LOSS. Both were run through the real agent CLI over 30
 * tasks with correctness holding at 30/30 in every arm and the work identical:
 * the conservative text ("only the calls whose results are not needed by each
 * other") moved turns 0.7%, which against the fixture's 58% headroom is 1.2%
 * obedience -- below the 4.85% break-even this block needs to repay its own
 * residency. The aggressive wording moved 4.2%, or 7.2% obedience, and clears
 * it.
 *
 * Neither is large. At 7.2% obedience the block takes 2.6% off N, so it is a
 * contributor to a stack and not a lever on its own; batching reached 1.67x
 * against the competitor's 1.69x even at the 23% obedience a ten-task arm
 * reported before a thirty-task arm cut it to 7.2%.
 *
 * It asks for parallel calls unless a dependence is known, which is the upper
 * arm of the headroom bracket (57.8% of adjacent pairs shared no token with
 * the earlier result) rather than the lower one (37.6% had every input in hand
 * a turn early). That is the more permissive instruction, so correctness is
 * the thing to watch: measured, it did not move.
 */
const GUIDANCE =
  'Make your tool calls in parallel in a single message unless a call needs ' +
  'the result of an earlier one. Each turn re-reads the whole conversation, ' +
  'so calls split across turns are paid for repeatedly.';

/**
 * The guidance block, or null when the operator has not asked for it.
 *
 * `null` rather than an empty string so a caller cannot inject nothing and
 * record it as an injection; `injectKnowledge` already treats a falsy block as
 * "leave the request alone", and this keeps that contract.
 */
export function batchGuidance(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env[BATCH_GUIDANCE_ENV];
  if (value === undefined) return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === '' || normalised === '0' || normalised === 'false')
    return null;
  if (normalised === 'off') return null;
  return GUIDANCE;
}
