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
    const blocks = Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ text: content }]
        : [];
    for (const block of blocks) {
      const text = (block as { text?: unknown })?.text;
      if (typeof text !== 'string' || text.length === 0) continue;
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
