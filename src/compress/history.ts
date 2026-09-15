/**
 * Substituting conversation history with what it was carrying.
 *
 * History is ~65% of a live request and the only part that grows every turn.
 * Measured on a real 27-turn THOL conversation (60,274 chars): signed
 * `thinking` 31,585 (52%), tool results 21,706 (36%), `tool_use` 5,128 (9%),
 * assistant text 1,817 (3%). Everything this project optimised before now
 * attacked the other 35%.
 *
 * WHY THIS IS NOT THE PROBE THAT ALREADY LOST. `server.ts` carries a
 * thinking-drop probe measured at 1.01/0.71/1.32/0.72 against control, beaten
 * by deferral alone on three of four tasks. It REMOVES. This SUBSTITUTES, and
 * the two differ in the one place the bill is decided:
 *
 *   - Removal deletes a signed block and, where that block was the message's
 *     only content, deletes the message. Message count moves, indices shift,
 *     and three existing tests that encode the 1:1 invariant have to be
 *     rewritten to allow it.
 *   - Substitution edits the message IN PLACE, leaving whatever already showed
 *     what the turn did and writing a marker only when nothing would remain.
 *     Message count is preserved, no index moves, and the 1:1 invariant is
 *     never broken -- so the constrained tests need no weakening, which is the
 *     outcome the plan wanted and could not get.
 *
 * THE CACHE ARGUMENT, WHICH IS THE WHOLE DESIGN. A prefix rewrite costs a full
 * 1.25x write on everything kept, against 0.1x to re-read it untouched --
 * break-even `11.5 * after / removed` turns. The probe's first mode exempted
 * the newest assistant turn, which put a boundary in the prefix that MOVED
 * every turn: message A was sent whole on the turn it arrived and rewritten on
 * the next, so the prefix was rewritten on EVERY request. That is visible in
 * its numbers -- code-debug-pipeline-py took 71% fewer turns and still cost 10%
 * more, so per-turn cost had roughly quadrupled.
 *
 * The rule that avoids it entirely: TRANSFORM EVERY MESSAGE THE FIRST TIME IT
 * IS SEEN, AND NEVER RECONSIDER. Then turn N's prefix is turn N-1's prefix plus
 * new content, the provider's cached copy still matches, and the substitution
 * costs no rewrite at all -- not "a rewrite that repays in seven turns", none.
 * That is why `substituteHistory` is a pure function of each message alone. It
 * takes no floor, no turn count and no conversation-level state, because any of
 * those would make the output of message `i` depend on something that changes,
 * and a prefix that changes is a cache miss on everything before it.
 *
 * WHAT GOES BACK IN: ALMOST NOTHING, AND THAT IS THE POINT. A finding in the
 * graph is PROJECT knowledge -- durable, cross-session. History carries TASK
 * STATE: which files this session already edited, which command already failed.
 * No finding records that, so project findings cannot stand in for it.
 *
 * But the state is ALREADY in the message and is already being kept. The
 * `tool_use` blocks name the tool and its target; the `text` block is the
 * model's own conclusion. An earlier version of this file synthesised a digest
 * naming those same tool calls, which restated what the model could already
 * see and cost real bytes to do it -- measured at 312 of 312 messages on one
 * real session. So the substitute is written only where removal would leave an
 * empty message, and everywhere else the answer is silence.
 *
 * A NOTE ON WHAT THE OFFLINE NUMBERS MEASURE. Session transcripts store
 * `thinking: ""` and keep only the ~480-byte signature, so a replay over them
 * prices the removal of SIGNATURES, not of reasoning text. Live requests carry
 * the text as well. Every figure derived from a transcript replay is therefore
 * a lower bound on what this saves in production.
 */

import { type Block, type Message } from './frontier.js';

/** Block types that carry model reasoning rather than content. */
const REASONING = new Set(['thinking', 'redacted_thinking']);

export interface SubstitutionOptions {
  /**
   * Compresses one tool-result body. MUST be a pure function of its input.
   *
   * INJECTED RATHER THAN IMPORTED, for two reasons. It keeps this module free
   * of the engine registry, so the substitution can be tested without one. And
   * it makes the purity requirement a visible part of the contract instead of
   * something a caller has to infer -- a compressor that consulted the current
   * question, the conversation length or a spill sink would produce a different
   * body for the same block on a later turn, break the prefix at that message
   * and cost a full rewrite of everything after it, every turn.
   *
   * That is precisely why `v1Frontier` refuses to compress behind the cache
   * frontier: its compression IS query-dependent on fresh content. Applied from
   * first sight with the query omitted, the same engines become safe to use
   * everywhere.
   */
  readonly compressToolResult?: (text: string) => string;
}

export interface SubstitutionResult {
  /** The rewritten messages. Always the same length as the input. */
  readonly messages: Message[];
  /** Characters of reasoning removed. */
  readonly removedChars: number;
  /** Characters of digest written back in their place. */
  readonly substituteChars: number;
  /** How many messages were substituted at all. */
  readonly substituted: number;
  /** Characters removed from tool results, which are their own region. */
  readonly toolResultChars: number;
}

/**
 * The line that stands in for a message's removed reasoning -- when one is
 * needed at all, which is rarer than it looks.
 *
 * THE FIRST VERSION OF THIS WAS EXACTLY BACKWARDS, and measurement said so. It
 * built a digest naming the tools the message called, and wrote it whenever
 * such calls existed -- but those `tool_use` blocks are KEPT, in the same
 * message, already naming the same tool and the same target. The digest
 * restated what the model could already see. Counted on two real sessions: 312
 * of 312 and 99 of 100 messages carrying reasoning also carried `tool_use`, so
 * the digest was pure added cost in essentially every case, while the branch
 * that would have earned its bytes -- a reasoning-only message -- fired zero
 * times in 412 messages.
 *
 * That redundancy is why the substituting arm lost to plain removal at every
 * length measured: 0.901 against 0.886 at ten turns, 0.768 against 0.757 at
 * forty, 0.729 against 0.716 at two hundred. Made subtractive it wins instead,
 * 0.749 and 0.710 at forty and two hundred, while keeping the message structure
 * that removal destroys.
 *
 * So the rule is: say nothing when the message still shows what it did. A
 * digest is written only when removing the reasoning would leave NOTHING
 * behind, which is the one case where the turn would vanish from the record --
 * and, being an empty content array, would also be a 400.
 *
 * Marked as elided rather than passed off as the model's own words. The model
 * reads its own history as a record of what it did; a digest presented as
 * original text would be a false memory it cannot tell from the real thing.
 */
function digestFor(content: readonly Block[]): string | null {
  // Anything the model can still see makes a digest redundant. Both kinds are
  // kept by the caller, so both are evidence already present in the message.
  for (const block of content) {
    if (block?.type === 'tool_use' || block?.type === 'text') return null;
  }
  return '[reasoning elided]';
}

/**
 * What a reasoning block costs on the wire, for the accounting.
 *
 * THE WHOLE BLOCK, not its text. Counting `thinking` alone understated this
 * badly and silently: a signed block carries a ~480-byte `signature` that is
 * sent, billed, and removed along with everything else, and on a transcript
 * where the text has been stripped to "" the signature IS the entire cost --
 * so the old form reported exactly zero for blocks whose removal was the only
 * thing producing a saving.
 */
function reasoningChars(block: Block): number {
  try {
    return JSON.stringify(block).length;
  } catch {
    // A block that cannot be serialised cannot be costed; it also cannot have
    // been sent, so zero is the honest answer rather than a guess.
    return 0;
  }
}

/**
 * Replaces model reasoning in history with a digest of what it produced.
 *
 * PURE PER MESSAGE. The result for message `i` depends on message `i` and
 * nothing else -- not on how long the conversation is, not on where the cache
 * frontier sits, not on which turn this is. That is the property that makes the
 * transform free rather than merely profitable: applied from the first turn a
 * message appears, it never rewrites a prefix the provider has already cached.
 *
 * ONLY ASSISTANT MESSAGES, and only their reasoning. A `tool_result` lives in a
 * user message and is left entirely alone here; compressing those is a separate
 * concern with a separate risk profile, and mixing them would make a regression
 * unattributable to either.
 */
export function substituteHistory(
  messages: readonly Message[] | undefined,
  options: SubstitutionOptions = {}
): SubstitutionResult {
  const out: Message[] = [];
  let removedChars = 0;
  let substituteChars = 0;
  let substituted = 0;
  let toolResultChars = 0;

  for (const message of messages ?? []) {
    const content = message?.content;
    if (message?.role !== 'assistant' || !Array.isArray(content)) {
      // TOOL RESULTS ARE THE OTHER 36% OF HISTORY, and the plan had written
      // them off. Its arithmetic said compressing them alone repays a prefix
      // rewrite only after ~36 turns against a 13-turn workload, so the whole
      // feature "stands or falls entirely on removing thinking".
      //
      // That conclusion was downstream of assuming a REWRITE. Under the rule
      // this module is built on -- transform every message the first time it is
      // seen and never reconsider -- there is no rewrite to repay, so the
      // break-even is not 36 turns, it is absent. The region becomes worth
      // taking for the same reason the reasoning was.
      //
      // Only with a compressor the caller vouches is pure; otherwise untouched.
      const compress = options.compressToolResult;
      if (compress && message?.role === 'user' && Array.isArray(content)) {
        let changed = false;
        const next = content.map((block) => {
          if (block?.type !== 'tool_result') return block;
          const body = block.content;
          if (typeof body !== 'string' || !body) return block;
          const compressed = compress(body);
          if (compressed === body) return block;
          toolResultChars += body.length - compressed.length;
          changed = true;
          return { ...block, content: compressed };
        });
        if (changed) {
          out.push({ ...message, content: next });
          continue;
        }
      }
      out.push(message);
      continue;
    }
    const hasReasoning = content.some(
      (block) => block && REASONING.has(block.type ?? '')
    );
    if (!hasReasoning) {
      out.push(message);
      continue;
    }

    const digest = digestFor(content);
    const next: Block[] = [];
    let wrote = false;
    for (const block of content) {
      if (block && REASONING.has(block.type ?? '')) {
        removedChars += reasoningChars(block);
        // The digest lands where the FIRST reasoning block was, so a message
        // that reasoned twice does not get two digests -- and so the digest
        // precedes the tool calls it describes, which is the order the model
        // wrote them in.
        if (digest && !wrote) {
          next.push({ type: 'text', text: digest });
          substituteChars += digest.length;
          wrote = true;
        }
        continue;
      }
      next.push(block);
    }

    // NEVER SEND AN EMPTY MESSAGE. A message whose only content was reasoning,
    // and whose reasoning produced no tool call, has nothing left -- and an
    // empty content array is a 400. Keeping the original is strictly safer than
    // inventing filler: it costs the bytes it always cost and cannot be wrong.
    if (!next.length) {
      out.push(message);
      continue;
    }

    out.push({ ...message, content: next });
    substituted += 1;
  }

  return {
    messages: out,
    removedChars,
    substituteChars,
    substituted,
    toolResultChars,
  };
}
