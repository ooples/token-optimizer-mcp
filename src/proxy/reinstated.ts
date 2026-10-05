import { createHash } from 'node:crypto';

/**
 * COUNTING THE WITHHELD UNITS A REQUEST HAS BROUGHT BACK.
 *
 * Withholding a unit saves its residency for every remaining turn and costs
 * nothing unless it is wanted again, so the rate at which that happens is the
 * only thing the withholding case turns on. The denominator -- how many units
 * left -- has been counted at the spill sink all along. This is the numerator.
 *
 * It lives here rather than inside the proxy's closure so it can be tested
 * against a known answer. A counter that always reads zero passes every test
 * that only checks the proxy still runs, and zero is exactly the reading that
 * would make the arm look best.
 */

/** A digest of one withheld unit, as the spill sink records it. */
export const digestOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/**
 * How many of `withheld` appear as block text in this request body.
 *
 * Counted once per unit however many times it appears, because the question is
 * whether it was wanted, not how often it was pasted. A body that does not
 * parse, or carries no messages, answers zero rather than throwing: a
 * malformed request is not evidence about the reference rate.
 */
/** The text a tool-result block carries, in either shape the API allows. */
function toolResultText(block: unknown): string[] {
  const candidate = block as { type?: unknown; content?: unknown };
  if (candidate?.type !== 'tool_result') return [];
  const content = candidate.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (part as { text?: unknown })?.text)
    .filter((text): text is string => typeof text === 'string');
}

/**
 * How many withheld units this request brings back AS A RETRIEVAL.
 *
 * ONLY TOOL RESULTS COUNT, and the first version of this counted every block.
 * In a conversation the client resends the whole history every turn, so a unit
 * withheld at turn 5 arrives again at turns 6, 7 and 8 -- and counting those
 * made `reinstated` five times `spilled` over a real run, which is not a rate
 * at all. The client never reinstates anything here: it sends originals, the
 * proxy removes them on the way out, and the proxy re-decides every turn.
 *
 * What a retrieval actually looks like is the model calling the expand tool and
 * the content arriving as a NEW tool-result block. That is the only shape that
 * means somebody wanted the unit back, so it is the only shape counted.
 *
 * Counted once per unit however many times it appears, because the question is
 * whether it was wanted, not how often it was pasted. A body that does not
 * parse, or carries no messages, answers zero rather than throwing: a malformed
 * request is not evidence about the reference rate.
 */
export function reinstatedIn(
  body: string,
  withheld: ReadonlySet<string>
): number {
  if (withheld.size === 0) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 0;
  }
  const messages = (parsed as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return 0;
  const seen = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content)
      for (const text of toolResultText(block)) {
        if (text.length === 0) continue;
        const digest = digestOf(text);
        if (withheld.has(digest)) seen.add(digest);
      }
  }
  return seen.size;
}

/**
 * The reference rate: how often a withheld unit was wanted back.
 *
 * NULL WHEN NOTHING WAS WITHHELD, NEVER ZERO. Zero is the reading that makes
 * the withholding arm look best -- it says every unit was dropped for free --
 * and it is also what `0/0` produces when the arm never ran. Those two have to
 * be distinguishable, or a session with the arm switched off reports the most
 * flattering number available.
 *
 * The rate this returns is the whole subscription case: a withheld unit saves
 * its residency for every remaining turn and costs nothing unless it is wanted
 * again, so the arm's value is almost entirely a function of this one figure.
 * It has been estimated once, at 0.23, from textual recurrence on a corpus
 * belonging to the engine we are measuring against -- a method blind to a unit
 * the model read and reasoned about without quoting, so biased low, in the
 * direction that flatters us.
 */
export function referenceRate(counts: {
  readonly spilled?: number;
  readonly reinstated?: number;
}): number | null {
  const spilled = counts.spilled ?? 0;
  if (!Number.isFinite(spilled) || spilled <= 0) return null;
  const reinstated = counts.reinstated ?? 0;
  if (!Number.isFinite(reinstated) || reinstated < 0) return null;
  // A unit cannot come back more often than it left. If it reads that way the
  // two counters are measuring different populations, and a rate over 1 would
  // be reported as a catastrophic arm rather than as the defect it is.
  if (reinstated > spilled) return null;
  return reinstated / spilled;
}
