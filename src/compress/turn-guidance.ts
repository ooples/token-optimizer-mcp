/**
 * ASKING THE MODEL NOT TO SPLIT ONE DECISION ACROSS TWO REQUESTS.
 *
 * The session bill is `handed * (W + R*N)` and N carries 5.6 of the 7.6, so a
 * request that need not have happened is the most expensive thing in the
 * system. Measured across local transcripts: of 114,721 assistant turns, 37,545
 * carry thinking, 60,779 carry a tool call, and exactly TWO carry both. 32,591
 * of the thinking turns -- 86.8% -- are immediately followed by a turn that
 * acts. A third of all requests are a think-then-act pair that could have been
 * one turn.
 *
 * WHY THIS IS OURS AND NOT THE CLIENT'S. Fewer turns only helps the arm that
 * causes them. If the same guidance lived in Claude Code's own prompt every
 * optimizer in this position would get it, N would fall for all of them, and
 * the comparison would not move -- which is exactly what happens with the cache
 * write multiplier, a common factor worth about 10% of a bill and nothing at
 * all against a competitor. Injected by the proxy, the reduction belongs to the
 * arm that injected it.
 *
 * OFF BY DEFAULT, because it is an instruction to the model and not a
 * transformation of bytes. A prompt that changes how a model sequences its work
 * can change what it concludes, and no offline instrument can tell you whether
 * it did. The operator turns it on.
 *
 * AND THERE IS A PRECEDENT AGAINST IT WORKING. Claude Code already asks for
 * multi-call batching -- "make all of the independent calls in the same
 * response" -- and the measured result is 1.15 calls per turn with 92% of turns
 * making exactly one. Asking for batching achieves very little. This is a
 * narrower request: not to plan further ahead, only to say what has already
 * been decided in the turn that acts on it. Whether that lands is a question
 * for a live session, which is why this ships gated and measured rather than
 * on.
 *
 * WHERE IT MUST BE INJECTED, learned by putting it in the wrong place first.
 * strategy.ts injects the knowledge block at the end of `v1Frontier`, and that
 * line is downstream of an early return: with nothing compressible -- which is
 * every first request, since the frontier only works on the span after the
 * breakpoint it saw LAST turn -- the function returns before reaching it.
 * Wired there, the guidance never appeared at all: `injectedChars` stayed 0 and
 * the system block was byte-identical with the flag on and off.
 *
 * It is worse than useless there even when it does fire. A constant instruction
 * has to be present from the first request or not at all: arriving on the turn
 * compression first happens changes the cached prefix mid-session, so it would
 * pay a full cache write on everything after it for the privilege of arriving
 * late. It belongs where the proxy rewrites every request, unconditionally when
 * enabled.
 *
 * AND THAT COSTS THE CLIENT'S PREFIX, CONSISTENTLY, WHICH IS THE TRADE.
 * Injecting on every request means parsing and re-serialising every request,
 * and cached-prefix.ts exists precisely to avoid that: a re-serialised body
 * agrees with the client's bytes for 57 characters, so the provider sees a
 * miss and charges a write.
 *
 * But the provider caches OUR outgoing bytes, not the client's. Inject the same
 * block the same way every turn and our own prefix is stable turn to turn, so
 * the loss is one-time against what the client sent rather than recurring. That
 * is the acceptable shape, and it is the opposite of the conditional injection
 * tried in strategy.ts, where the block arrived mid-session and moved the
 * prefix for every turn after it.
 *
 * So the implementation is: parse once, inject when enabled, serialise the same
 * way every time -- and `serialiseKeepingPrefix` is deliberately defeated for
 * the life of the session rather than intermittently. That is a real cost and
 * has to be measured against the turn reduction before the feature is claimed,
 * not assumed smaller.
 */

/** The env var an operator sets to turn this on. */
export const TURN_GUIDANCE_ENV = 'TOKEN_OPTIMIZER_TURN_GUIDANCE';

/**
 * Short on purpose.
 *
 * Every character sits in the cached prefix for the life of the session and is
 * charged `W + R*N` once and `R` on every turn after, so a paragraph that does
 * not change behaviour is a permanent tax. At roughly 60 tokens this costs
 * about 460 token-equivalents against a session that would otherwise run to
 * three million, which is the only reason a speculative instruction is worth
 * trying at all.
 */
const GUIDANCE =
  'When you have decided what to do, do it in the same turn you decide it: ' +
  'put the tool call in the message that explains the reasoning for it, ' +
  'rather than ending a turn and acting in the next one. Each turn re-reads ' +
  'the whole conversation, so a decision split across two turns is paid for ' +
  'twice.';

/**
 * The guidance block, or null when the operator has not asked for it.
 *
 * `null` rather than an empty string so the caller cannot accidentally inject
 * nothing and record it as an injection -- `injectKnowledge` already treats a
 * falsy block as "leave the request alone", and this keeps that contract.
 */
export function turnGuidance(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = (env[TURN_GUIDANCE_ENV] ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'off')
    return null;
  return GUIDANCE;
}
