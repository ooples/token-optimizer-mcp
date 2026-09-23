/**
 * Reducing what the model WRITES, not what it reads.
 *
 * Every other engine in this package attacks the prompt. Output is the token
 * class nobody here has touched, and on Opus-class models it bills at about
 * five times input -- so a modest reduction there is worth more than a large
 * one on the cheap side of the ledger. Much of that output is ceremony:
 * "Great, let me...", code printed straight back at you, and full reasoning
 * effort spent resuming after a file read that answered nothing.
 *
 * TWO LEVERS, BOTH DELIBERATELY TIMID.
 *
 * 1. VERBOSITY STEERING appends a short instruction to the END of the system
 *    prompt. The end matters: a provider prompt cache keys on a prefix, so
 *    anything prepended or inserted invalidates every cached token behind it.
 *    This package has already measured that mistake costing 1.77x when a
 *    reordered tool array moved bytes at the front of the prefix, so the
 *    placement here is not stylistic.
 *
 * 2. EFFORT ROUTING lowers the thinking budget when a turn is only the model
 *    resuming after a tool result -- a file read, a passing test. A new
 *    question or an error keeps whatever the client asked for.
 *
 * CLAMP-ONLY, IN ONE DIRECTION. Neither lever ever raises a setting the client
 * chose, adds a field the client omitted, or changes a request it marked as
 * needing full effort. A proxy that increases spend while advertising a saving
 * is worse than a proxy that does nothing, so every branch here can only
 * reduce or pass through.
 *
 * MEASURED, NOT ESTIMATED. Output savings are counterfactual: we never see what
 * the model would have written. So a holdout fraction of conversations is left
 * unshaped, which turns the figure from an estimate into a measurement with a
 * band. `TOKEN_OPTIMIZER_OUTPUT_HOLDOUT=0.1` leaves one in ten alone.
 */

import { createHash } from 'node:crypto';

/** The instruction appended to the system prompt. Kept short: it is paid for on every request. */
const TERSE_NOTE =
  'Answer directly. Do not restate the question, summarise what you just did, ' +
  'or reprint unchanged code. Prefer the shortest correct reply.';

/** Thinking budget, in tokens, for a turn that is only resuming after a tool result. */
const RESUMPTION_BUDGET = 1024;

/** The OpenAI effort level used for the same case. */
const RESUMPTION_EFFORT = 'low';

/** Effort levels in ascending order, so "never raise" is decidable. */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high'] as const;

export type WireFormat = 'messages' | 'chat-completions' | 'responses';

export interface ShaperOptions {
  readonly wireFormat: WireFormat;
  /** Off unless the operator turned it on. */
  readonly enabled?: boolean;
  /** Fraction of conversations left unshaped, so the saving can be measured. */
  readonly holdout?: number;
  /** Stable per-conversation key, so a conversation stays in or out of the holdout. */
  readonly conversationKey?: string;
}

export interface ShaperResult {
  /** The request to forward. Identical object when nothing applied. */
  readonly body: Record<string, unknown>;
  /** Labels for the accounting ledger, e.g. `output_shaper:verbosity`. */
  readonly labels: readonly string[];
  /** Why nothing was done, when nothing was done. */
  readonly skipped?: string;
}

/** Reads the switch. Absent means off: this changes what the model writes. */
export function shaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.TOKEN_OPTIMIZER_OUTPUT_SHAPER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';
}

/** The unshaped fraction. Invalid or absent means none. */
export function holdoutFraction(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(
    (env.TOKEN_OPTIMIZER_OUTPUT_HOLDOUT ?? '').trim()
  );
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 1 ? 1 : raw;
}

/**
 * Whether this conversation is in the unshaped control arm.
 *
 * Hashed rather than random, so a conversation does not flip arms mid-flight.
 * A conversation shaped on turn 3 and unshaped on turn 4 would pollute both
 * arms and measure nothing.
 */
export function inHoldout(key: string | undefined, fraction: number): boolean {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  if (!key) return false;
  const digest = createHash('sha256').update(key).digest();
  // First four bytes as a fraction of the range: deterministic and uniform.
  const scaled = digest.readUInt32BE(0) / 0xffffffff;
  return scaled < fraction;
}

/** Is this turn only the model resuming after a tool result? */
export function isResumption(
  body: Record<string, unknown>,
  wireFormat: WireFormat
): boolean {
  const list = wireFormat === 'responses' ? body.input : body.messages;
  if (!Array.isArray(list) || !list.length) return false;
  const last = list[list.length - 1] as Record<string, unknown> | undefined;
  if (!last || typeof last !== 'object') return false;

  // Chat Completions and Responses name the role outright.
  if (last.role === 'tool' || last.type === 'function_call_output') return true;

  // The Messages dialect carries tool results as blocks on a user turn, and
  // the distinction that matters is whether the user SAID anything: a turn
  // holding only tool results is a resumption, whereas one that also carries
  // text is a fresh instruction that happens to follow a tool call.
  if (last.role === 'user' && Array.isArray(last.content)) {
    const blocks = last.content as Record<string, unknown>[];
    if (!blocks.length) return false;
    return blocks.every((b) => b && b.type === 'tool_result');
  }
  return false;
}

/**
 * Appends the terseness note to the end of the system prompt.
 *
 * Returns null when there is nowhere safe to put it. An absent system prompt
 * is left absent rather than created: inventing one would add tokens to every
 * request, which is the opposite of the point.
 */
function steerVerbosity(
  body: Record<string, unknown>,
  wireFormat: WireFormat
): Record<string, unknown> | null {
  // THE RESPONSES DIALECT IS NOT THE MESSAGES DIALECT. It carries its
  // system text in `instructions` as a plain string, which this branch
  // originally conflated with `system` -- so shaping silently did nothing
  // on that wire format. Verified against this repo's own handler:
  // responses-knowledge.ts both reads and appends to request.instructions.
  if (wireFormat === 'responses') {
    const instructions = body.instructions;
    if (typeof instructions !== 'string' || !instructions.length) return null;
    if (instructions.includes(TERSE_NOTE)) return null;
    return { ...body, instructions: `${instructions}\n\n${TERSE_NOTE}` };
  }

  if (wireFormat === 'messages') {
    const system = body.system;
    if (typeof system === 'string' && system.length) {
      if (system.includes(TERSE_NOTE)) return null;
      return { ...body, system: `${system}\n\n${TERSE_NOTE}` };
    }
    if (Array.isArray(system) && system.length) {
      const blocks = system as Record<string, unknown>[];
      if (
        blocks.some(
          (b) => typeof b?.text === 'string' && b.text.includes(TERSE_NOTE)
        )
      )
        return null;
      // A NEW TRAILING BLOCK, never an edit of an existing one. The client may
      // have put a cache_control breakpoint on the last block; appending after
      // it leaves every cached block byte-identical, where rewriting one would
      // invalidate it and everything behind it.
      return {
        ...body,
        system: [...blocks, { type: 'text', text: TERSE_NOTE }],
      };
    }
    return null;
  }

  // Chat Completions keeps the system prompt as the first message.
  if (!Array.isArray(body.messages)) return null;
  const messages = body.messages as Record<string, unknown>[];
  const index = messages.findIndex(
    (m) => m?.role === 'system' || m?.role === 'developer'
  );
  if (index === -1) return null;
  const current = messages[index];
  if (typeof current.content !== 'string' || !current.content.length)
    return null;
  if (current.content.includes(TERSE_NOTE)) return null;
  const copy = messages.slice();
  copy[index] = { ...current, content: `${current.content}\n\n${TERSE_NOTE}` };
  return { ...body, messages: copy };
}

/** Lowers thinking effort for a resumption turn, never raising it. */
function routeEffort(
  body: Record<string, unknown>,
  wireFormat: WireFormat
): Record<string, unknown> | null {
  // Responses nests effort under `reasoning`, and the rest of that object
  // must survive -- it can carry a summary setting and, on a continuation,
  // encrypted reasoning this proxy is careful never to disturb.
  if (wireFormat === 'responses') {
    const reasoning = body.reasoning;
    if (!reasoning || typeof reasoning !== 'object') return null;
    const block = reasoning as Record<string, unknown>;
    const level = block.effort;
    if (typeof level !== 'string') return null;
    const at = EFFORT_ORDER.indexOf(level as (typeof EFFORT_ORDER)[number]);
    const floor = EFFORT_ORDER.indexOf(RESUMPTION_EFFORT);
    if (at === -1 || at <= floor) return null;
    return { ...body, reasoning: { ...block, effort: RESUMPTION_EFFORT } };
  }

  if (wireFormat === 'chat-completions') {
    const current = body.reasoning_effort;
    // Only narrow what the client already asked for. An absent field means the
    // provider default, and guessing at that is how a clamp becomes a raise.
    if (typeof current !== 'string') return null;
    const now = EFFORT_ORDER.indexOf(current as (typeof EFFORT_ORDER)[number]);
    const target = EFFORT_ORDER.indexOf(RESUMPTION_EFFORT);
    if (now === -1 || now <= target) return null;
    return { ...body, reasoning_effort: RESUMPTION_EFFORT };
  }

  const thinking = body.thinking;
  if (!thinking || typeof thinking !== 'object') return null;
  const block = thinking as Record<string, unknown>;
  const budget = block.budget_tokens;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return null;
  if (budget <= RESUMPTION_BUDGET) return null;
  return { ...body, thinking: { ...block, budget_tokens: RESUMPTION_BUDGET } };
}

/**
 * Applies both levers, or explains why it did not.
 *
 * The body is never mutated in place: a caller that decides not to forward the
 * shaped version must still hold the original bytes.
 */
export function shapeOutput(
  body: Record<string, unknown>,
  opts: ShaperOptions
): ShaperResult {
  if (!opts.enabled) return { body, labels: [], skipped: 'shaper off' };
  if (!body || typeof body !== 'object')
    return { body, labels: [], skipped: 'not an object' };

  const fraction = opts.holdout ?? 0;
  if (inHoldout(opts.conversationKey, fraction))
    return { body, labels: ['output_shaper:holdout'], skipped: 'holdout arm' };

  let shaped = body;
  const labels: string[] = [];

  const steered = steerVerbosity(shaped, opts.wireFormat);
  if (steered) {
    shaped = steered;
    labels.push('output_shaper:verbosity');
  }

  if (isResumption(shaped, opts.wireFormat)) {
    const routed = routeEffort(shaped, opts.wireFormat);
    if (routed) {
      shaped = routed;
      labels.push('output_shaper:effort');
    }
  }

  if (!labels.length) return { body, labels: [], skipped: 'nothing to shape' };
  return { body: shaped, labels };
}
