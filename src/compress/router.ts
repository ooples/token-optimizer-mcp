/**
 * Dispatch: classify a block, then hand it to the engine that fits.
 *
 * NO INSTANCE STATE, AND THAT IS THE WHOLE DESIGN. HeadRoom's open issue #3486
 * is "Concurrent requests cross-contaminate compression options -- one shared
 * `ContentRouter` stores per-request state on `self`". A proxy is concurrent by
 * definition: two agents, or one agent with parallel tool calls, are two
 * requests in flight through the same router at the same time. Per-request
 * state on a shared object means request A's options silently decide how
 * request B's content is compressed.
 *
 * The fix is not care, it is shape. Everything here is a pure function of
 * (text, context). There is no object to hold state on, so the bug is not
 * something we avoid -- it is something that cannot be written.
 *
 * THE BUILT-INS REGISTER LIKE ANYBODY ELSE'S. They are ordinary registry
 * entries, so there is one dispatch path to test and a custom engine can claim
 * content ahead of them. What used to be the order of a `switch` is now
 * priority, which makes the reasoning explicit:
 *
 *   diff        70   its hunks ARE the content; nothing may elide them
 *   json        60   before prose, since a pretty-printed payload of English
 *                    strings reads as wordy lines
 *   search      50   grep output carries source lines AND timestamps, so both
 *                    code and log would claim it and then find nothing
 *   log         40
 *   code        30
 *   prose       10   the most permissive claim, so it goes last
 */

import { compressCode, looksLikeCode, looksLikeDiff } from './code.js';
import { compressJson, looksLikeJson } from './json.js';
import { compressLog, looksLikeLog } from './log.js';
import { compressProse, looksLikeProse } from './prose.js';
import { compressSearchResults, looksLikeSearchResults } from './search.js';
import { engineFor, registerEngine, runEngine } from './registry.js';
import type { CompressionResult, ContentKind, EngineContext } from './types.js';
import { unchanged } from './types.js';

/**
 * A diff is claimed and then deliberately left alone.
 *
 * Claiming it is the point: if nothing claimed a diff, `code` would, and its
 * hunks are the entire content of the change. Registering the refusal is how it
 * survives somebody adding another engine later.
 */
registerEngine({
  name: 'diff',
  priority: 70,
  claims: (text) => looksLikeDiff(text),
  compress: (text) => unchanged(text),
});

registerEngine({
  name: 'json',
  priority: 60,
  claims: (text) => looksLikeJson(text),
  compress: compressJson,
});

registerEngine({
  name: 'search',
  priority: 50,
  claims: (text) => looksLikeSearchResults(text),
  compress: compressSearchResults,
});

registerEngine({
  name: 'log',
  priority: 40,
  claims: (text) => looksLikeLog(text),
  compress: compressLog,
});

registerEngine({
  name: 'code',
  priority: 30,
  claims: (text, ctx) => looksLikeCode(text, ctx),
  compress: compressCode,
});

registerEngine({
  name: 'prose',
  priority: 10,
  claims: (text) => looksLikeProse(text),
  compress: compressProse,
});

/** Built-in names, so a caller can tell ours from a third party's. */
export const BUILT_IN_ENGINES = Object.freeze([
  'diff',
  'json',
  'search',
  'log',
  'code',
  'prose',
]);

/**
 * What kind of content this is.
 *
 * Answers with the winning engine's name, so a custom engine appears in a
 * report rather than being invisible.
 */
export function classify(text: string, ctx: EngineContext = {}): ContentKind {
  const engine = engineFor(text, ctx);
  if (!engine) return 'unknown';
  // `diff` claims in order to refuse, and reports as unknown so nothing
  // downstream treats it as a compressible kind.
  if (engine.name === 'diff') return 'unknown';
  return (
    BUILT_IN_ENGINES.includes(engine.name) ? engine.name : 'custom'
  ) as ContentKind;
}

/** The engine that would handle this block, built-in or not. */
export function engineNameFor(
  text: string,
  ctx: EngineContext = {}
): string | null {
  return engineFor(text, ctx)?.name ?? null;
}

/**
 * Compresses one block.
 *
 * The boundary in `runEngine` applies to every engine equally: a result that
 * grew is discarded, a throw passes the input through untouched, and a lossy
 * elision with nowhere to recover from is refused.
 */
export function compressBlock(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const engine = engineFor(text, ctx);
  if (!engine) return unchanged(text);
  return runEngine(engine, text, ctx);
}
