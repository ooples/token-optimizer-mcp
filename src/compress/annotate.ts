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

import type { Elision } from './types.js';

/**
 * ONE SHAPE, so a model learns it once.
 *
 * Square brackets and a leading ellipsis, because that is how humans have
 * written elision in quoted text for a century and models have read a great
 * deal of it. Deliberately NOT an angle-bracket sigil: those read as markup and
 * invite the model to treat them as a protocol it must satisfy.
 */
export function marker(
  elision: Pick<Elision, 'removed' | 'recoverAt'>
): string {
  return elision.recoverAt
    ? `[... ${elision.removed} -> ${elision.recoverAt}]`
    : `[... ${elision.removed}]`;
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
export function pathAddressed(line: string): string | null {
  const match = /^\s*\[\.\.\. .* -> ([^\]]+)\]\s*$/.exec(line);
  return match ? match[1] : null;
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
  recoverAt: string | null
): string {
  return marker({ removed, recoverAt });
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
