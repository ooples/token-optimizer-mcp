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
 * ORDER MATTERS IN CLASSIFICATION. Diff is checked before code because a diff
 * of a source file passes every code test while being the one thing that must
 * never have its bodies elided. JSON is checked before prose because a
 * pretty-printed payload of English strings reads as wordy lines.
 */

import { compressCode, looksLikeCode, looksLikeDiff } from './code.js';
import { compressJson, looksLikeJson } from './json.js';
import { compressLog, looksLikeLog } from './log.js';
import { compressProse, looksLikeProse } from './prose.js';
import { compressSearchResults, looksLikeSearchResults } from './search.js';
import type { CompressionResult, ContentKind, EngineContext } from './types.js';
import { unchanged } from './types.js';

/** What kind of content this is. Pure; depends only on its arguments. */
export function classify(text: string, ctx: EngineContext = {}): ContentKind {
  if (looksLikeJson(text)) return 'json';
  // BEFORE code and log. Grep output carries source lines, and can carry
  // timestamped ones, so either engine would claim it and then find nothing
  // it recognises -- what is really there is `path:line: content`. The
  // benchmark found this the hard way: the code-search workload scored 0.0%
  // for every arm, including the CCR control, until this type existed.
  if (looksLikeSearchResults(text)) return 'search';
  // Before `code`: a diff passes every code test and must not be elided.
  if (looksLikeDiff(text)) return 'unknown';
  if (looksLikeLog(text)) return 'log';
  if (looksLikeCode(text, ctx)) return 'code';
  if (looksLikeProse(text)) return 'prose';
  return 'unknown';
}

/**
 * Compresses one block.
 *
 * A result that grew is discarded. Compression that adds tokens is a defect
 * their own changelog records fixing in other systems ("compression increasing
 * prompt size"), and it is trivially preventable by measuring rather than
 * trusting.
 */
export function compressBlock(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const kind = classify(text, ctx);

  let result: CompressionResult;
  switch (kind) {
    case 'json':
      result = compressJson(text, ctx);
      break;
    case 'search':
      result = compressSearchResults(text, ctx);
      break;
    case 'log':
      result = compressLog(text, ctx);
      break;
    case 'code':
      result = compressCode(text, ctx);
      break;
    case 'prose':
      result = compressProse(text, ctx);
      break;
    default:
      return unchanged(text);
  }

  return result.text.length < text.length ? result : unchanged(text);
}
