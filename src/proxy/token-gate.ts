import { createRequire } from 'node:module';
import type { Tiktoken } from 'tiktoken';

const require = createRequire(import.meta.url);
let encoder: Tiktoken | undefined;
const decisions = new Map<
  string,
  { after: string; accepted: boolean; bytes: number }
>();
let retainedBytes = 0;

/** o200k_base is a local estimate, NOT a claim about an unknown model's billing
 * tokenizer. Require a margin, count only changed bounded units, and memoize the
 * decision. Unknown encodings / oversized units require substantial byte savings.
 * Loading lazily keeps untouched and null-proxy traffic free of tokenizer work.
 */
export function tokenBenefit(before: string, after: string): boolean {
  if (after === before) return false;
  const hit = decisions.get(before);
  if (hit?.after === after) return hit.accepted;
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
      const a = encoder.encode(before, [], []).length;
      const b = encoder.encode(after, [], []).length;
      accepted = b <= a * 0.9 && a - b >= 8;
    } catch {
      // Forwarding must not depend on tokenizer availability.
    }
  }
  const bytes = 2 * (before.length + after.length);
  if (bytes <= 1024 * 1024) {
    const previous = decisions.get(before);
    if (previous) {
      retainedBytes -= previous.bytes;
      decisions.delete(before);
    }
    while (decisions.size >= 128 || retainedBytes + bytes > 2 * 1024 * 1024) {
      const first = decisions.keys().next().value!;
      retainedBytes -= decisions.get(first)!.bytes;
      decisions.delete(first);
    }
    decisions.set(before, { after, accepted, bytes });
    retainedBytes += bytes;
  }
  return accepted;
}
