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
 *   prose       10   the most permissive claim of the content engines
 *   records      5   a SHAPE, not a kind, so it goes last of all: it may only
 *                    see text every engine above deliberately declined
 */

import { compressCode, looksLikeCode, looksLikeDiff } from './code.js';
import { compressJson, looksLikeJson } from './json.js';
import {
  compressJsonSections,
  looksLikeJsonSections,
} from './json-sections.js';
import { compressLog, looksLikeLog, looksTemplated } from './log.js';
import { compressTap, looksLikeTap } from './tap.js';
import {
  compressJsonFragments,
  looksLikeJsonFragments,
} from './json-fragments.js';
import { compressProse, looksLikeProse } from './prose.js';
import { compressSearchResults, looksLikeSearchResults } from './search.js';
import { engineFor, registerEngine, runEngine } from './registry.js';
import { readNumbering } from './numbering.js';
import { foldRepeatedSegments, looksRepetitive } from './segments.js';
import type { CompressionResult, ContentKind, EngineContext } from './types.js';
import { unchanged } from './types.js';
import { DEFAULT_TUNING } from './options.js';

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

/**
 * Repeated sections inside one document, folded losslessly.
 *
 * PRIORITY ABOVE json BUT BELOW diff, because it must see a document before
 * an engine that would treat it as prose or code, and must never see a diff.
 * It claims only text that is genuinely repetitive -- a real majority of its
 * segments byte-identical -- so ordinary documents fall straight through to
 * the engines that already handle them.
 */
registerEngine({
  name: 'segments',
  priority: 65,
  // NEVER JSON, WHATEVER IT LOOKS LIKE. A large array of similar objects,
  // pretty-printed with blank lines between them, satisfies `looksRepetitive`
  // -- and this engine outranks `json` (65 against 60), so it won the claim,
  // removed whole blocks and appended a plain-English note. The result is not
  // parseable JSON, which is a different and worse failure than compressing it
  // badly: a consumer that parses the value gets an exception rather than a
  // smaller document. `json` handles this content correctly and is right
  // behind it.
  claims: (text) => !looksLikeJson(text) && looksRepetitive(text),
  compress: foldRepeatedSegments,
});

registerEngine({
  name: 'json',
  priority: 60,
  claims: (text) => looksLikeJson(text) || looksLikeJsonSections(text),
  compress: (text, ctx) => {
    const result = compressJson(text, ctx);
    return result.text === text ? compressJsonSections(text, ctx) : result;
  },
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
  claims: (text) =>
    looksLikeJsonFragments(text) || looksLikeTap(text) || looksLikeLog(text),
  compress: (text, ctx) =>
    looksLikeJsonFragments(text)
      ? compressJsonFragments(text)
      : looksLikeTap(text)
        ? compressTap(text)
        : compressLog(text, ctx),
});

registerEngine({
  name: 'code',
  priority: 30,
  claims: (text, ctx) => looksLikeCode(text, ctx),
  compress: compressCode,
});

/**
 * Content that belongs to another engine even when that engine declines it.
 *
 * `engineFor` takes the first claim and never falls through, so a shape-based
 * claim down here only ever sees text nothing above wanted -- and "nothing
 * wanted it" turned out to include two cases where a better-informed engine had
 * deliberately looked away:
 *
 *   - source code read so the agent can edit it exactly. `looksLikeCode` misses
 *     a module whose every line begins `export const`, so `code` never claimed
 *     it and the block survived by accident. Folding it would have broken the
 *     exact string edit it was read for.
 *   - a truncated or invalid JSON document. `json` refuses it precisely BECAUSE
 *     it is malformed; templating its lines instead would rewrite bytes the
 *     caller must see verbatim to know they are broken.
 *
 * Both are recognised here rather than by widening the engines' own predicates,
 * because widening those would change which engine COMPRESSES the healthy case
 * and this only needs to change who declines the sick one.
 */
const JSON_MEMBER = /^\s*"[^"\n]+":\s/m;
const CODE_KEYWORD =
  /^\s*(?:export|import|from|function|class|const|let|var|def|func|impl|public|private|protected|return|if|for|while|switch|type|interface|enum)\b/m;

// BELOW EVERY OTHER ENGINE ON PURPOSE, so it can only pick up what nothing else
// wanted. Repeated same-shape records are not a kind of content, they are a
// SHAPE that several kinds of content happen to have, and claiming on shape from
// anywhere higher stole from engines that knew better: at the log engine's
// priority of 40 it took source code away from `code`, which refuses to touch a
// file the agent read in order to edit it exactly.
//
// Sitting last means the only text reaching it is text the router would
// otherwise have returned as `unknown` and left at full width -- which is
// exactly where the browser accessibility trees were.
registerEngine({
  name: 'records',
  priority: 5,
  claims: (text, ctx) =>
    looksTemplated(text) &&
    !JSON_MEMBER.test(text) &&
    !CODE_KEYWORD.test(text) &&
    !looksLikeCode(text, ctx),
  compress: (text, ctx) => compressLog(text, ctx),
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
  'segments',
  'json',
  'search',
  'log',
  'code',
  'prose',
  'records',
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
  // A numbered read is detected on its BARE content and re-numbered
  // afterwards. Detecting on the numbered form finds nothing at all --
  // see readNumbering, where the measurement is recorded.
  const numbering = readNumbering(text);
  if (numbering) {
    const inner = compressBlock(numbering.stripped, ctx);
    if (inner.text === numbering.stripped) return unchanged(text);
    // Only exact inserted markers may be unnumbered; rewrites fail closed.
    const restored = numbering.restore(inner.text, inner.insertedLines);
    return restored === null ? unchanged(text) : { ...inner, text: restored };
  }
  const engine = engineFor(text, ctx);
  if (!engine) return unchanged(text);
  // RESOLVED ONCE, HERE. An engine reading `ctx.tuning?.keepRows ?? 3`
  // would put the default in two places, and the second copy is the one
  // that drifts. Filling it in at the single dispatch point means every
  // engine sees a complete object and the defaults live in exactly one
  // file.
  const tuned: EngineContext = {
    ...ctx,
    tuning: ctx.tuning ?? DEFAULT_TUNING,
    // The router hands ITSELF to the engines, so a string found inside a
    // document is routed by exactly the same rules as one found at the top.
    // Supplied here rather than imported by the engine, which would cycle.
    compressNested: ctx.compressNested ?? compressBlock,
  };
  return runEngine(engine, text, tuned);
}
