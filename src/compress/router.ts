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
import { foldLongRepeats } from './runs.js';
import { foldRepeatedSegments, looksRepetitive } from './segments.js';
import type { CompressionResult, ContentKind, EngineContext } from './types.js';
import { spillFor, unchanged } from './types.js';
import { marker } from './annotate.js';
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
/**
 * The smallest block worth moving out of the request whole.
 *
 * Below this the marker and its path are a real share of what they replace, and
 * the reader has lost a block they could simply have read.
 */
const MIN_SUBSTITUTE_BYTES = 4_000;

/**
 * May this block be moved out of the request whole?
 *
 * SUBSTITUTION, NOT REDUCTION. Nothing here makes a block smaller: it takes the
 * block out and writes `[... n bytes, moved whole -> path]` where it was. The
 * ratio that produces is a measurement of a move, and `spillWholeBlockBelow` is
 * documented to say exactly that, because a 99% in a table says the opposite.
 *
 * Moving a block is lossy by the definition this codebase uses -- the output no
 * longer determines what was removed -- so the lossless dial forbids it for the
 * same reason it forbids eliding a function body.
 */
function movable(text: string, ctx: EngineContext): boolean {
  return (
    (ctx.tuning?.spillWholeBlockBelow ?? 0) > 0 &&
    ctx.tuning?.allowLossy === true &&
    text.length >= MIN_SUBSTITUTE_BYTES &&
    // THE OUTERMOST BLOCK ONLY, or the same bytes are written twice. A string
    // inside a JSON document is routed back through here, so a nested value
    // would be moved to its own file and then moved again inside the block
    // containing it -- and the outer spill holds the ORIGINAL text, which makes
    // the inner one dead weight. Measured at 2.34x the input on disk before
    // this clause and 1.44x after, for identical output.
    (ctx.stringDepth ?? 0) === 0
  );
}

/** The block moved out whole, or null when there is nowhere to put it. */
function moveOut(
  text: string,
  ctx: EngineContext
): CompressionResult | null {
  // A SINK THAT FAILED IS NOT A PATH. `spillFor` normalises the proxy's empty
  // string to null, and without somewhere to put the block the honest answer is
  // whatever the engine managed, however modest it was.
  const at = spillFor(ctx, text, 'block');
  if (at === null) return null;

  const removed = `${text.length.toLocaleString('en-US')} bytes, moved whole`;
  const line = marker({ removed, recoverAt: at });
  return {
    text: line,
    insertedLines: [line],
    elisions: [{ removed, recoverAt: at, lossless: false }],
    lossless: false,
  };
}

/**
 * Moves a block that barely compressed out of the request, leaving its path.
 *
 * GATED ON THE SAVING RATHER THAN THE SIZE. HeadRoom's content-cache references
 * do this to every block over a size floor, which is where their ~99.7% comes
 * from. Gating on what the engines actually achieved keeps every block they
 * compressed well IN the request -- the reader still has it, and the ratio on it
 * is a real one -- and matches the cache reference only where our engines had
 * nothing to offer. That is the better trade in both directions, which is the
 * only reason to ship this at all.
 *
 * OFF UNLESS ASKED. Default `spillWholeBlockBelow` is 0, so this returns its
 * input untouched and no shipped measurement moves. See the dial.
 */
function substitute(
  text: string,
  result: CompressionResult,
  ctx: EngineContext
): CompressionResult {
  if (!movable(text, ctx)) return result;
  const saving = 1 - result.text.length / text.length;
  if (saving >= (ctx.tuning?.spillWholeBlockBelow ?? 0)) return result;
  return moveOut(text, ctx) ?? result;
}

/**
 * Dispatch and run, with no pass that reads the whole block afterwards.
 *
 * SPLIT OUT SO THE NUMBERED PATH CAN SKIP THE FOLD. A numbered read is
 * compressed on its bare content and renumbered afterwards, and `restore`
 * fails closed unless every line it did not expect is one the engine declared
 * as inserted. `foldLongRepeats` rewrites the inside of a line and can span a
 * line break, so it has nothing to declare -- running it there turned a good
 * compression into an untouched block. It belongs above this, once.
 */
function routed(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const engine = engineFor(text, ctx);
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
  // NO ENGINE RUN AT ALL WHERE NOTHING IT PRODUCED COULD BE KEPT. At a threshold
  // of 1 no saving is good enough, so running the engine first only writes spill
  // files the move then supersedes: 1.44x the input on disk against 1.00x, for
  // byte-identical output. Below 1 the saving has to be measured, so the engine
  // runs and the decision waits for it.
  if (movable(text, tuned) && (tuned.tuning?.spillWholeBlockBelow ?? 0) >= 1) {
    const moved = moveOut(text, tuned);
    if (moved !== null) return moved;
  }

  // A BLOCK NOBODY CLAIMED IS THE STRONGEST CASE FOR MOVING IT, not a case to
  // skip: its saving is zero by definition. It used to return here, above the
  // substitution pass, which meant the dial did nothing for the one shape it
  // most obviously applies to.
  return substitute(
    text,
    engine ? runEngine(engine, text, tuned) : unchanged(text),
    tuned
  );
}

/**
 * Compresses one block.
 *
 * Two things happen here that `routed` deliberately does not do: a numbered
 * read is stripped, compressed and renumbered, and whatever survives is
 * offered to the long-repeat fold.
 *
 * THE FOLD RUNS LAST AND ONLY AT THE TOP. Last, because it should see what
 * the engine left rather than what it was given -- an engine that already
 * removed the second copy leaves nothing here to find, and one that could not
 * reach inside a line leaves the whole of it. Only at the top, because a
 * string inside a JSON document is routed back through here with a depth, and
 * a marker folded into a nested value would be re-escaped by the document
 * around it and read back through a different grammar than the one that wrote
 * it. `movable` draws the same line for the same reason.
 *
 * The fold is offered the ORIGINAL text as well, so a block no engine claimed
 * is still eligible: an unclaimed block is the one most likely to be a large
 * opaque payload sent twice.
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
    const inner = routed(numbering.stripped, ctx);
    if (inner.text === numbering.stripped) return unchanged(text);
    // Only exact inserted markers may be unnumbered; rewrites fail closed.
    const restored = numbering.restore(inner.text, inner.insertedLines);
    return restored === null ? unchanged(text) : { ...inner, text: restored };
  }

  const result = routed(text, ctx);
  if ((ctx.stringDepth ?? 0) !== 0) return result;
  const folded = foldLongRepeats(result.text);
  if (folded === null) return result;
  return {
    ...result,
    text: folded.text,
    elisions: [...result.elisions, ...folded.elisions],
    lossless: result.lossless && folded.lossless,
  };
}
