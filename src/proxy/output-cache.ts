import { compressBlock } from '../compress/router.js';
import type { Tuning } from '../compress/options.js';
import type { CompressionResult } from '../compress/types.js';

type Spill = (content: string, hint: string) => string;
type Entry = {
  result: CompressionResult;
  spills: { content: string; hint: string; path: string }[];
  bytes: number;
};
const caches = new WeakMap<
  Spill,
  { tuning: string; bytes: number; entries: Map<string, Entry> }
>();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 128;

/** Scope cached output to its proxy's spill function. Recheck recovery paths on
 * hits so a removed spill file is recreated and a changed path never goes stale.
 * Exact text keys avoid collisions; options changes invalidate the whole cache.
 */
export function cachedOutput(
  text: string,
  spill: Spill,
  tuning?: Tuning
): CompressionResult {
  const options = JSON.stringify(tuning ?? null);
  let cache = caches.get(spill);
  if (!cache || cache.tuning !== options) {
    cache = { tuning: options, bytes: 0, entries: new Map() };
    caches.set(spill, cache);
  }
  const hit = cache.entries.get(text);
  if (hit) {
    const reusable = hit.spills.every(
      (s) => spill(s.content, s.hint) === s.path
    );
    cache.entries.delete(text);
    if (reusable) {
      cache.entries.set(text, hit);
      return hit.result;
    }
    cache.bytes -= hit.bytes;
  }
  const spills: Entry['spills'] = [];
  const result = compressBlock(text, {
    tuning,
    spill: (content, hint) => {
      const path = spill(content, hint);
      spills.push({ content, hint, path });
      return path;
    },
  });
  // UTF-16 upper bound for retained strings; entry count also bounds overhead.
  const bytes =
    2 *
    (text.length +
      result.text.length +
      spills.reduce(
        (n, s) => n + s.content.length + s.hint.length + s.path.length,
        0
      ));
  if (bytes <= MAX_BYTES) {
    while (
      cache.entries.size >= MAX_ENTRIES ||
      cache.bytes + bytes > MAX_BYTES
    ) {
      const oldest = cache.entries.keys().next().value!;
      cache.bytes -= cache.entries.get(oldest)!.bytes;
      cache.entries.delete(oldest);
    }
    cache.entries.set(text, { result, spills, bytes });
    cache.bytes += bytes;
  }
  return result;
}
