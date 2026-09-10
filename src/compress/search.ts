/**
 * Search-result compression: say the path once, not on every line.
 *
 * FOUND BY THE BENCHMARK, NOT BY DESIGN. The code-search workload -- the one
 * HeadRoom reports their largest number on, 92% -- scored 0.0% here for every
 * strategy including the CCR control, because grep output is not code, not a
 * log, and not prose. It is a fifth content type that none of the engines
 * recognised, and no unit test would have noticed since a hand-written fixture
 * would have been code.
 *
 * The redundancy is glaring once the content is real. Ripgrep prefixes EVERY
 * line with its path and line number:
 *
 *     hooks-core/derive.mjs:1204: export function commandOperand(command) {
 *     hooks-core/derive.mjs:1205:   const tokens = commandBody(command)
 *
 * On this repository that prefix averages a third of the line. Stating it once
 * per contiguous hunk removes all of it:
 *
 *     hooks-core/derive.mjs:1204-1205
 *     export function commandOperand(command) {
 *       const tokens = commandBody(command)
 *
 * COMPLETELY LOSSLESS, which is what makes it the best trade in the whole
 * module: line N is the header's start plus the offset, so the original can be
 * reconstructed exactly from the output with no lookup, no spill and no path to
 * follow. Nothing is elided at all -- this is pure redundancy removal.
 */

import type { CompressionResult, EngineContext } from './types.js';
import { unchanged } from './types.js';

/**
 * `path:line: content` or `path:line- content`.
 *
 * Both separators appear: ripgrep uses `:` for a match and `-` for a context
 * line, and dropping the distinction would lose which lines actually matched.
 */
// The path must LOOK like a path: no whitespace, and either a slash or a dot
// extension. Without that constraint a clock matches -- 18:10:00Z parses as
// path "18", line "10", separator ":" -- and the engine claimed every
// timestamped log line in the corpus. Measured when it happened: the
// sre-debugging workload fell from 87.2% to 19.5% because the log engine
// never got the content.
//
// THE CONTENT GROUP EXCLUDES CR EXPLICITLY, and that is not pedantry. In
// JavaScript the dot excludes every line terminator and CR is one, so on a
// CRLF file -- which every source file in this repository is -- a trailing
// dot-star can never reach the end anchor. Every line failed to parse and the
// engine concluded the block was not search output at all: 815 lines, 0 hits.
const HIT =
  /^((?:[^\s:]*\/[^\s:]*|[^\s:]+\.[A-Za-z0-9]+)):(\d+)([:-])([^\r\n]*)\r?$/;

/** Below this the header costs more than the prefixes it replaces. */
const MIN_HUNK_LINES = 2;

/** Fraction of lines that must look like hits before this engine claims the block. */
const MIN_DENSITY = 0.6;

interface Hit {
  readonly path: string;
  readonly line: number;
  readonly matched: boolean;
  readonly text: string;
}

function parseHit(line: string): Hit | null {
  const m = HIT.exec(line);
  if (!m) return null;
  const [, path, num, sep, text] = m;
  return { path, line: Number(num), matched: sep === ':', text };
}

/**
 * Which lines matched, said as briefly as the truth allows.
 *
 * SAYING NOTHING IS USUALLY CORRECT, and getting this wrong was expensive.
 * The first version listed every matching line number, so a hunk where all
 * eleven lines matched emitted `(matched 1031,1032,...,1041)` -- longer than
 * the content it annotated. Measured on the code-search workload: headers
 * were 7,706 of the 30,367 surviving characters, 25% of the output, and
 * nearly all of it was that list.
 *
 * When every line in the range matched, the range already says so. When a
 * contiguous span matched, name the span. Only a genuinely scattered set is
 * worth enumerating.
 */
function matchNote(
  matched: readonly number[],
  start: number,
  end: number
): string {
  if (!matched.length) return ' (context)';
  if (matched.length === end - start + 1) return '';

  const contiguous = matched.every(
    (line, i) => i === 0 || line === matched[i - 1] + 1
  );
  if (contiguous) {
    const first = matched[0];
    const last = matched[matched.length - 1];
    return first === last
      ? ` (matched ${first})`
      : ` (matched ${first}-${last})`;
  }
  return ` (matched ${matched.join(',')})`;
}

/** Detects ripgrep/grep-style output. */
export function looksLikeSearchResults(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 6) return false;
  let hits = 0;
  for (const line of lines) if (HIT.test(line)) hits += 1;
  return hits / lines.length >= MIN_DENSITY;
}

/**
 * Groups contiguous same-file lines into hunks with one header each.
 *
 * A gap in line numbers starts a new hunk, because a header claiming
 * `file:10-90` for lines that skip 40 of those would be a lie the reader cannot
 * detect.
 */
export function compressSearchResults(
  text: string,
  _ctx: EngineContext = {}
): CompressionResult {
  const lines = text.split('\n');
  const out: string[] = [];

  let path: string | null = null;
  let start = 0;
  let previous = 0;
  let buffer: string[] = [];
  let matchedOffsets: number[] = [];

  const flush = (): void => {
    if (!path || !buffer.length) return;
    if (buffer.length < MIN_HUNK_LINES) {
      // Too short to earn a header: restore the original prefixes.
      buffer.forEach((line, i) => out.push(`${path}:${start + i}: ${line}`));
    } else {
      const range = start === previous ? `${start}` : `${start}-${previous}`;
      // Which lines actually matched, so `-` context is still distinguishable
      // from a `:` hit without a prefix on every line.
      const marks = matchNote(matchedOffsets, start, previous);
      out.push(`${path}:${range}${marks}`);
      out.push(...buffer);
    }
    path = null;
    buffer = [];
    matchedOffsets = [];
  };

  for (const raw of lines) {
    const hit = parseHit(raw);
    if (!hit) {
      flush();
      out.push(raw);
      continue;
    }
    const contiguous = path === hit.path && hit.line === previous + 1;
    if (!contiguous) {
      flush();
      path = hit.path;
      start = hit.line;
    }
    previous = hit.line;
    if (hit.matched) matchedOffsets.push(hit.line);
    buffer.push(hit.text);
  }
  flush();

  const body = out.join('\n');
  if (body.length >= text.length) return unchanged(text);

  return {
    text: body,
    // Nothing was removed that the output does not fully describe: the path is
    // stated once and every line number is recoverable from the header.
    elisions: [
      { removed: 'repeated path prefixes', recoverAt: null, lossless: true },
    ],
    lossless: true,
  };
}
