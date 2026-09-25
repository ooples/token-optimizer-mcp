import { compressBlock } from '../compress/router.js';
import { compressJsonArray } from '../compress/json-fragments.js';
import type { Tuning } from '../compress/options.js';
import type { CompressionResult, SpillSink } from '../compress/types.js';

type Entry = {
  result: CompressionResult;
  spills: { content: string; hint: string; path: string }[];
  bytes: number;
};
const caches = new WeakMap<
  object,
  { tuning: string; bytes: number; entries: Map<string, Entry> }
>();
const NO_SINK: object = Object.freeze({});
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 128;

/** Scope cached output to its proxy's spill function. Recheck recovery paths on
 * hits so a removed spill file is recreated and a changed path never goes stale.
 * Exact text keys avoid collisions; options changes invalidate the whole cache.
 */
export function cachedOutput(
  text: string,
  spill: SpillSink,
  tuning?: Tuning
): CompressionResult {
  const options = JSON.stringify(tuning ?? null);
  // A CALLER WITH NO SINK STILL GETS A CACHE. `undefined` is not a key a
  // WeakMap will take, and keying it on a shared sentinel is correct rather
  // than a workaround: every zero-turn caller compresses identically, so they
  // may share entries, and nothing in an entry can point at a spill path
  // because none was written.
  const key: object = spill ?? NO_SINK;
  let cache = caches.get(key);
  if (!cache || cache.tuning !== options) {
    cache = { tuning: options, bytes: 0, entries: new Map() };
    caches.set(key, cache);
  }
  const hit = cache.entries.get(text);
  if (hit) {
    const reusable =
      spill === undefined ||
      hit.spills.every((s) => spill(s.content, s.hint) === s.path);
    cache.entries.delete(text);
    if (reusable) {
      cache.entries.set(text, hit);
      return hit.result;
    }
    cache.bytes -= hit.bytes;
  }
  const spills: Entry['spills'] = [];
  const sink: SpillSink =
    spill === undefined
      ? undefined
      : (content, hint) => {
          const path = spill(content, hint);
          spills.push({ content, hint, path });
          return path;
        };
  let result = compressBlock(text, { tuning, spill: sink });
  // Small complete arrays can use the same exact lexical record template as
  // large tables, without batching across turns or creating recovery reads.
  if (
    text.length >= 512 &&
    text.length < 1024 &&
    text.trimStart().startsWith('[')
  ) {
    const exact = compressJsonArray(text, 3);
    if (exact.text.length < result.text.length) result = exact;
  }
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
