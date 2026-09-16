import { createRequire } from 'node:module';
import type { Tiktoken } from 'tiktoken';

const require = createRequire(import.meta.url);
let encoder: Tiktoken | undefined;
const decisions = new Map<
  string,
  Map<string, { accepted: boolean; bytes: number }>
>();
let retainedBytes = 0;
let decisionCount = 0;
const counts = new Map<string, number>();
let countBytes = 0;

function count(text: string): number {
  const hit = counts.get(text);
  if (hit !== undefined) return hit;
  const value = encoder!.encode(text, [], []).length;
  const bytes = text.length * 2;
  while (counts.size >= 128 || countBytes + bytes > 1024 * 1024) {
    const oldest = counts.keys().next().value!;
    countBytes -= oldest.length * 2;
    counts.delete(oldest);
  }
  counts.set(text, value);
  countBytes += bytes;
  return value;
}

/** o200k_base is a local estimate, NOT a claim about an unknown model's billing
 * tokenizer. Require a margin, count only changed bounded units, and memoize the
 * decision. Unknown encodings / oversized units require substantial byte savings.
 * Loading lazily keeps untouched and null-proxy traffic free of tokenizer work.
 */
export function tokenBenefit(before: string, after: string): boolean {
  if (after === before) return false;
  // A full encoding and its later reference are different candidates for the
  // same original. Keep both decisions so every turn doesn't recount both.
  const hit = decisions.get(before)?.get(after);
  if (hit) return hit.accepted;
  if (
    Buffer.byteLength(after) >= Buffer.byteLength(before) ||
    Buffer.byteLength(JSON.stringify(after)) >=
      Buffer.byteLength(JSON.stringify(before))
  )
    return false;
  let accepted = Buffer.byteLength(after) <= Buffer.byteLength(before) * 0.75;
  if (before.length <= 128 * 1024 && after.length <= 128 * 1024) {
    try {
      encoder ??= (
        require('tiktoken') as typeof import('tiktoken')
      ).get_encoding('o200k_base');
      // Treat special-token-looking tool content as ordinary text.
      // A later reference has a different candidate but the same source. Reuse
      // individual counts as well as final decisions, without retaining buffers.
      const a = count(before);
      const b = count(after);
      accepted = b <= a * 0.9 && a - b >= 8;
    } catch {
      // Forwarding must not depend on tokenizer availability.
    }
  }
  const bytes = 2 * (before.length + after.length);
  if (bytes <= 1024 * 1024) {
    while (decisionCount >= 128 || retainedBytes + bytes > 2 * 1024 * 1024) {
      const first = decisions.keys().next().value!;
      const candidates = decisions.get(first)!;
      const oldest = candidates.keys().next().value!;
      retainedBytes -= candidates.get(oldest)!.bytes;
      candidates.delete(oldest);
      decisionCount--;
      if (!candidates.size) decisions.delete(first);
    }
    let candidates = decisions.get(before);
    if (!candidates) {
      candidates = new Map();
      decisions.set(before, candidates);
    }
    candidates.set(after, { accepted, bytes });
    decisionCount++;
    retainedBytes += bytes;
  }
  return accepted;
}
