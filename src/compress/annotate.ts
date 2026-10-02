/**
 * How an elision is written into the text the model reads.
 *
 * THE WHOLE COMPETITIVE ARGUMENT IS IN THIS FILE, so it is worth being explicit
 * about what is being avoided.
 *
 * HeadRoom emits `<<ccr:a1b2c3d4e5f6 38_rows_offloaded>>` and, to make that
 * redeemable, appends to every compressed request a `## Compressed Context
 * Available` system message plus a `headroom_retrieve` tool definition
 * (`headroom/ccr/tool_injection.py:143`). Roughly 200 tokens of preamble per
 * request, and around 8,000 across a forty-turn session -- context spent in
 * order to save context.
 *
 * A marker here costs nothing extra. It is a sentence naming what went and a
 * path the agent can already read, so:
 *
 *   - no system message, no tool definition, no hash, nothing injected;
 *   - a model that does not need the content spends nothing;
 *   - a model that does need it uses `Read`, which it already knows;
 *   - and if our bookkeeping is gone the path still resolves to the real file,
 *     where their marker resolves to `[unresolved: entry not found]`.
 */

import { createHmac, randomBytes } from 'node:crypto';

import type { Elision, EngineContext, Stamp } from './types.js';

/*
 * WHY A MARKER CARRIES A STAMP.
 *
 * The marker grammar is the decoder's grammar, so content that writes a line in
 * it is content that speaks to the decoder. A `[... 400 lines -> /attacker/x]`
 * line planted in a log we were asked to compress is byte-identical to one this
 * file emits, and the decoder honoured it: `rehydrate` refused the whole block
 * and quoted the path the attacker chose back at the caller. Measured at 7 of
 * 12 cells of the adversarial grid, costing 20 points of reduction.
 *
 * The asymmetry worth exploiting is that the ENCODER knows which markers it
 * wrote and the output carried no way to tell. So each marker now carries a
 * stamp, and the decoder honours only the stamp it was given.
 *
 * IT HAS TO BE RANDOM PER CALL, not derived from the text. A verifier holding
 * no secret can only check what it can recompute, and anything it can recompute
 * from the output the author of the content can compute too -- they have our
 * source and they write their line before we compress it. A value they cannot
 * predict is the only thing that separates us from them, which is why
 * `compressBlock` returns the stamp rather than hiding it in the output.
 *
 * SIX BASE-32 CHARACTERS is ~2^30 guesses against a block that cannot hold a
 * thousand lines, and costs two or three tokens per marker. That cost is real
 * and it is paid on the product's core output; it buys the only version of this
 * fix under which planted content cannot address the decoder at all.
 */
/*
 * EXPORTED, because a caller that prices a marker has to price the stamp in it.
 * `dedup.ts` decides whether a reference pays for itself by rendering the widest
 * marker it could emit and comparing it with the block it would replace, and a
 * bound that left these characters out would approve a reference that costs more
 * than it saves.
 */
export const STAMP_CHARS = 6;

/** The alphabet, with no vowels, so a stamp never renders as a word. */
const ALPHABET = '0123456789bcdfghjklmnpqrstvwxyz';

/*
 * THE SECRET, MINTED ONCE PER PROCESS AND NEVER EMITTED.
 *
 * A per-call random stamp was the first thing tried and it is wrong, measurably:
 * compressing the same text twice then returns different bytes, and a BYTE-
 * IDENTICAL prefix turn after turn is the whole of what the proxy sells -- a
 * cached prefix that changes is a cached prefix that misses. Eight suites said
 * so, including `the compressed prefix is reproducible turn over turn`.
 *
 * Keying fixes that without giving the property up. The stamp is a MAC over the
 * content, so the same content always stamps the same way, while the author of
 * that content still cannot compute it: the earlier argument -- whatever a
 * verifier can recompute from the output, the author of the output can compute
 * first -- turns on the verifier holding NO secret. This one holds one.
 *
 * PER BLOCK, NOT PER PROCESS, although a single process-wide value would also
 * be deterministic. Learning one block's stamp then says nothing about any
 * other block's, so an attacker who somehow reads one of our outputs cannot
 * forge a marker into the next thing we are asked to compress.
 *
 * It does not survive a restart, and nothing should expect it to: a stamp is
 * read back by the same process that wrote it, within the turn it wrote it in.
 * Persisting compressed text and decoding it later needs the stamp stored
 * beside it, which is why `CompressionResult` carries it as data.
 */
const SECRET = randomBytes(32);

export function stampFor(text: string): string {
  const mac = createHmac('sha256', SECRET).update(text).digest();
  let out = '';
  for (let i = 0; i < STAMP_CHARS; i++)
    out += ALPHABET[mac[i] % ALPHABET.length];
  return out;
}

/**
 * The context an engine should work from: the caller's, with a stamp.
 *
 * EVERY ENGINE ENTRY POINT GOES THROUGH THIS, so no caller can get output it
 * has no way to decode. An engine run with a bare context used to emit markers
 * and leave the caller to guess; it now mints one from the content and hands it
 * back on the result, which is the only shape under which `rehydrate` can be
 * called correctly by someone who did not build the context.
 *
 * `null` IS A CHOICE AND IS KEPT. A caller who passes it means `do not stamp`,
 * and gets markers nothing will honour -- which is what the published arm of
 * the comparator wants, where the output is scored as text and never decoded.
 * Only `undefined` means `I did not think about this`.
 */
export function withStamp(
  ctx: EngineContext,
  text: string
): EngineContext & { readonly stamp: Stamp } {
  return ctx.stamp === undefined
    ? { ...ctx, stamp: stampFor(text) }
    : { ...ctx, stamp: ctx.stamp };
}

/**
 * NULL IS NOT "ANY". A decoder handed no stamp honours no marker: every
 * marker-shaped line is then content, and content is returned verbatim. That is
 * the safe direction -- the cost of being wrong is a line that reads like a
 * marker surviving into the output, against a block denied and an attacker's
 * path quoted back at the caller.
 */
export type { Stamp };

/** Does this marker body carry the stamp we are expecting? */
export function stamped(body: string, stamp: Stamp): boolean {
  return stamp !== null && body.endsWith(` ~${stamp}`);
}

/**
 * ONE SHAPE, so a model learns it once.
 *
 * Square brackets and a leading ellipsis, because that is how humans have
 * written elision in quoted text for a century and models have read a great
 * deal of it. Deliberately NOT an angle-bracket sigil: those read as markup and
 * invite the model to treat them as a protocol it must satisfy.
 */
export function marker(
  elision: Pick<Elision, 'removed' | 'recoverAt'>,
  stamp: Stamp = null
): string {
  const body =
    stamp === null ? elision.removed : `${elision.removed} ~${stamp}`;
  return elision.recoverAt
    ? `[... ${body} -> ${elision.recoverAt}]`
    : `[... ${body}]`;
}

/**
 * Is this line a marker THIS decoder wrote?
 *
 * The one definition of that question, because every decoder in this directory
 * has to ask it and they must all answer it the same way. A line in the marker
 * envelope carrying the stamp is ours: expand it, or refuse with the reason.
 * Anything else is content, and content is returned as it arrived.
 *
 * THE STAMP SITS BEFORE THE ARROW, not at the very end: `recoverAt` is a path
 * and a path has no business carrying our authenticator. So the suffix is cut
 * off before the body is checked, which also means a marker whose stamp is in
 * the PATH -- `[... 400 lines -> /x ~abc]` -- is not ours, which is correct:
 * nothing we emit puts it there.
 */
export function isStamped(line: string, stamp: Stamp): boolean {
  if (stamp === null) return false;
  const match = /^\s*\[\.\.\. (.*)\]\s*$/.exec(line);
  if (match === null) return false;
  const arrow = / -> [^\]]+$/.exec(match[1]);
  const body = arrow === null ? match[1] : match[1].slice(0, arrow.index);
  return stamped(body, stamp);
}

/**
 * The stamp suffix a decoder pattern has to allow for, as regex source.
 *
 * EVERY DECODER PATTERN IN THIS DIRECTORY ANCHORS ON `]`, so the stamp this
 * encoder appends sits between the last thing those patterns match and that
 * bracket. They each need the same fragment spliced in, and they need it to
 * match NOTHING when there is no stamp -- a decoder handed none honours no
 * marker, which is what makes planted content inert.
 *
 * The tag is narrowed to the alphabet `stampFor` draws from, so a caller
 * cannot smuggle a quantifier or a group into a decoder pattern through it.
 */
export function stampPattern(stamp: Stamp): string {
  assertStamp(stamp);
  if (stamp === null) return '(?!)';
  return ' ~' + stamp.replace(/[^0-9a-z]/g, '');
}

/**
 * Refuses a stamp that is neither a string nor `null`, by name.
 *
 * A DECODER TAKES ITS STAMP AS A SECOND ARGUMENT, which makes every decoder
 * entry point accidentally shaped like an `Array.prototype.map` callback --
 * `texts.map(decode)` then hands it the INDEX, and a number reaches a regex
 * builder as `stamp.replace is not a function` from four frames down. That
 * happened at four call sites while this was being written. Naming the mistake
 * where it is made costs one comparison per pattern built.
 *
 * It throws rather than coercing, because every quiet reading of a number is
 * wrong: as a stamp it honours no marker and the output silently keeps lines
 * that should have expanded, and as `null` it says the caller meant `do not
 * decode` when the caller meant nothing of the kind.
 */
export function assertStamp(stamp: Stamp): void {
  if (stamp !== null && typeof stamp !== 'string')
    throw new TypeError(
      'a marker stamp is a string or null, received ' +
        typeof stamp +
        " -- a decoder's second argument is a stamp, so `map(decode)` passes it the index; call it with one argument"
    );
}

/**
 * The path out of a lossy marker, or null when the line is not one.
 *
 * `rehydrate` rebuilds the input from the output ALONE, so a `-> path` marker
 * is something it can never expand: the path is the whole point of it. That is
 * a completely different fact from "a marker family nobody registered", and a
 * caller which cannot tell the two apart files by-design behaviour on a defect
 * queue -- which is exactly what the head-to-head harness was doing, reporting
 * six refusals that were the design working.
 *
 * The parser lives here because this file owns the envelope both forms share.
 */
export function pathAddressed(
  line: string,
  stamp: Stamp = null
): string | null {
  const match = /^\s*\[\.\.\. (.*) -> ([^\]]+)\]\s*$/.exec(line);
  if (!match) return null;
  // UNSTAMPED IS CONTENT. Before this check the path below could be one the
  // author of the compressed text chose, and the caller was told the content
  // had been moved there.
  return stamped(match[1], stamp) ? match[2] : null;
}

/**
 * A marker that was recognised and is recoverable, just not from here.
 *
 * Carries the path so a caller can score the content as retrieved-in-one-read
 * rather than lost.
 */
export class PathAddressedError extends Error {
  readonly recoverAt: string;
  constructor(recoverAt: string) {
    super(`expandLog: content was moved to ${recoverAt}; read it there`);
    this.name = 'PathAddressedError';
    this.recoverAt = recoverAt;
  }
}

/** An inline elision, written where the content used to be. */
export function inlineMarker(
  removed: string,
  recoverAt: string | null,
  stamp: Stamp = null
): string {
  return marker({ removed, recoverAt }, stamp);
}

/**
 * A short, plural-correct count phrase.
 *
 * Small thing, but "1 duplicate lines" reads as a bug in the tool and invites a
 * model to distrust the number beside it.
 */
export function count(
  n: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** `path:start-end`, or `path:line` when the span is one line. */
export function span(path: string, start: number, end: number): string {
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

/**
 * An ascending index list, as gaps rather than absolutes.
 *
 * `positions=[...]` on a log template held one absolute line number per
 * occurrence, and on a dense template that is most of what the template costs:
 * on the `raw-build-log` fixture the four lists were 7,897 of the block's
 * 46,064 characters, 17%, to say something the reader almost never reads
 * digit by digit. The positions are ascending and usually near-consecutive, so
 * the gap between them is a one-digit number where the absolute is four, and a
 * run of equal gaps folds. Same 1,800 line numbers, 3,347 characters.
 *
 * The form is `first,gap,gap*repeat,...` where every gap is the step from the
 * previous position. Gaps are >= 1, so `*` can only ever mean a repeat count
 * and the grammar stays unambiguous.
 */
export function encodeGaps(positions: readonly number[]): string {
  if (!positions.length) return '[]';
  const out: string[] = [String(positions[0])];
  let gap = 0;
  let run = 0;
  const flush = () => {
    if (!run) return;
    out.push(run > 1 ? `${gap}*${run}` : String(gap));
  };
  for (let i = 1; i < positions.length; i += 1) {
    const step = positions[i] - positions[i - 1];
    if (step === gap) {
      run += 1;
      continue;
    }
    flush();
    gap = step;
    run = 1;
  }
  flush();
  return `[${out.join(',')}]`;
}

/** The inverse of {@link encodeGaps}. */
export function decodeGaps(encoded: string): number[] {
  const inner = encoded.slice(1, -1);
  if (!inner) return [];
  const tokens = inner.split(',');
  const positions = [Number(tokens[0])];
  for (const token of tokens.slice(1)) {
    const [gap, repeat] = token.split('*');
    for (let n = 0; n < (repeat ? Number(repeat) : 1); n += 1)
      positions.push(positions[positions.length - 1] + Number(gap));
  }
  return positions;
}
