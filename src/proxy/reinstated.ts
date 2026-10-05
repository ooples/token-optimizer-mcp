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
