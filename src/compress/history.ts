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
 *   - Substitution replaces the block IN PLACE with a compact digest of what
 *     that same message did. Message count is preserved, no index moves, and
 *     the 1:1 invariant is never broken -- so the constrained tests need no
 *     weakening, which is the outcome the plan wanted and could not get.
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
 * WHAT GOES BACK IN, AND WHY IT IS FREE. A finding in the graph is PROJECT
 * knowledge -- durable, cross-session. History carries TASK STATE: which files
 * this session already edited, which command already failed. No finding records
 * that, so project findings cannot stand in for it. But the state is already in
 * the message: `tool_use` blocks name the tool and its target. Digesting those
 * costs no model call, is deterministic, and preserves the one thing the
 * removed reasoning was load-bearing for -- what this turn actually did.
 */

import { type Block, type Message } from './frontier.js';

/** Block types that carry model reasoning rather than content. */
const REASONING = new Set(['thinking', 'redacted_thinking']);

/**
 * How much of a tool's argument is worth keeping in the digest.
 *
 * Enough to identify WHICH file or command, not enough to reproduce it. A path
 * is the identifying part and paths are short; a Bash command's first clause
 * says what it was for. Past that the digest stops being a digest.
 */
const HINT_CHARS = 60;

export interface SubstitutionResult {
  /** The rewritten messages. Always the same length as the input. */
  readonly messages: Message[];
  /** Characters of reasoning removed. */
  readonly removedChars: number;
  /** Characters of digest written back in their place. */
  readonly substituteChars: number;
  /** How many messages were substituted at all. */
  readonly substituted: number;
}

/**
 * The identifying part of a tool call, for the digest.
 *
 * Deliberately narrow and deliberately ordered: a file path answers "what did
 * this turn touch", which is the question the digest exists to answer, and the
 * common tools all spell it one of these three ways. Anything else falls back
 * to the first scalar argument, because a digest naming only the tool is a
 * digest that says a turn happened without saying what it did.
 */
function hintFor(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > HINT_CHARS
        ? `${flat.slice(0, HINT_CHARS)}...`
        : flat;
    }
  }
  return '';
}

/** One tool call, as the digest names it. */
function describeCall(block: Block): string | null {
  const name = typeof block.name === 'string' ? block.name : null;
  if (!name) return null;
  const hint = hintFor(block.input);
  return hint ? `${name}(${hint})` : name;
}

/**
 * The line that stands in for a message's removed reasoning.
 *
 * Returns null when there is nothing worth saying -- a message whose reasoning
 * led to no tool call and no text is a message whose reasoning left no trace,
 * and inventing a placeholder for it would spend bytes to say "something
 * happened here". The caller drops the blocks and writes nothing.
 *
 * Marked as elided rather than passed off as the model's own words. The model
 * reads its own history as a record of what it did; a digest presented as
 * original text would be a false memory, and one it cannot tell from the real
 * thing.
 */
function digestFor(content: readonly Block[]): string | null {
  const calls: string[] = [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    const described = describeCall(block);
    if (described) calls.push(described);
  }
  if (!calls.length) return null;
  return `[earlier reasoning elided; this turn called ${calls.join(', ')}]`;
}

/** Text length of a reasoning block, for the accounting. */
function reasoningChars(block: Block): number {
  const thinking = block.thinking;
  if (typeof thinking === 'string') return thinking.length;
  if (typeof block.data === 'string') return block.data.length;
  return 0;
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
  messages: readonly Message[] | undefined
): SubstitutionResult {
  const out: Message[] = [];
  let removedChars = 0;
  let substituteChars = 0;
  let substituted = 0;

  for (const message of messages ?? []) {
    const content = message?.content;
    if (message?.role !== 'assistant' || !Array.isArray(content)) {
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

  return { messages: out, removedChars, substituteChars, substituted };
}
