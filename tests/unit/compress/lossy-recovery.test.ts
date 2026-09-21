import { describe, it, expect } from '@jest/globals';
import { compressCode } from '../../../src/compress/code.js';
import { compressProse } from '../../../src/compress/prose.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';

/**
 * THE LOSSY PATH, held to the promise its marker makes.
 *
 * `lossless: false` is not "we lost something". It is a narrower and stronger
 * claim: what went is at `recoverAt`. `annotate.ts` rests the entire
 * competitive argument on that -- a marker costs nothing extra because the
 * agent already owns `Read`, and when our bookkeeping is gone the path still
 * resolves to the real file where the competitor's marker resolves to
 * `[unresolved: entry not found]`.
 *
 * NOTHING CHECKED THAT PROMISE. Every existing spill stub in the suite is
 * `{ spill: () => '/spill/log.txt' }` -- it returns a path and DISCARDS the
 * content, so it cannot tell a value that was destroyed from one that was
 * relocated. And the engines that recover by line range were never checked at
 * all. An off-by-one in `span` sends the agent to the wrong lines: silently
 * wrong, indistinguishable from correct in every test that reads the marker
 * text, and worse than a dead marker because it looks like an answer.
 *
 * TWO MECHANISMS, TWO INVARIANTS.
 *
 * `code` quotes a RANGE IN THE SOURCE. Its promise is exact and needs no
 * instrument: read the named lines out of the original and they must be the
 * body that was removed. So the whole input reconstructs from the output plus
 * the file it came from, byte for byte.
 *
 * `prose` has no file of its own and quotes a SPILL. Its promise needs a sink
 * that keeps what it is given, and then the spill must reproduce the content.
 * It also carries the control that matters most: `spillFor` normalises a
 * failed sink to null, and an engine seeing null must DECLINE rather than
 * elide into nowhere. `types.ts` records `json` and `prose` doing exactly that
 * wrong once already, so the refusal is tested, not assumed.
 */

/** A sink that keeps what it is handed, which no existing stub does. */
function recordingSpill() {
  const files = new Map<string, string>();
  return {
    files,
    spill: (content: string, hint: string): string => {
      const path = `/spill/${files.size}-${hint}`;
      files.set(path, content);
      return path;
    },
  };
}

/** A sink that fails the way the real one does: an empty string, not a throw. */
const failingSpill = () => '';

const CODE = Array.from(
  { length: 30 },
  (_, i) =>
    `export function handler${i}(input: string): number {\n` +
    `  const parsed = Number.parseInt(input, 10);\n` +
    `  if (Number.isNaN(parsed)) throw new Error('bad input ${i}');\n` +
    `  const scaled = parsed * ${i + 2};\n` +
    `  return scaled + ${i};\n` +
    `}\n`
).join('\n');

const PROSE = Array.from(
  { length: 40 },
  (_, i) =>
    `Section ${i}. The scheduler acquires a lease before it dispatches any ` +
    `work, and it renews that lease on a fixed interval so a partitioned ` +
    `worker cannot keep processing after the coordinator has moved on. ` +
    `Unique token alpha${i}beta here.`
).join('\n\n');

const SOURCE = 'src/handlers.ts';

/** `[... body, N lines -> path:A-B]`, or `path:A` when the span is one line. */
const BODY = /^(\s*)\[\.\.\. body, (\d+) lines? -> (.+?):(\d+)(?:-(\d+))?\]$/;

/**
 * Rebuilds the input from the output plus the file the markers point into.
 *
 * Reads ONLY what a model with `Read` could: the marker's own path and line
 * numbers. If a range is off by one, or names the wrong count, the result
 * stops matching the original.
 */
function followRanges(output: string, original: string, path: string): string {
  const source = original.split('\n');
  const out: string[] = [];
  for (const line of output.split('\n')) {
    const m = BODY.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, , count, quoted, from, to] = m;
    expect(quoted).toBe(path);
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    const body = source.slice(start - 1, end);
    // The marker's own count must describe the range it names.
    expect(body).toHaveLength(Number(count));
    out.push(...body);
  }
  return out.join('\n');
}

describe('a lossy elision delivers what its marker promises', () => {
  it('code bodies reconstruct from the line ranges the markers name', () => {
    const result = compressCode(CODE, {
      sourcePath: SOURCE,
      tuning: DEFAULT_TUNING,
    });

    // An inert engine would satisfy every assertion below by doing nothing.
    expect(result.text.length).toBeLessThan(CODE.length);
    expect(result.lossless).toBe(false);
    expect(result.elisions.length).toBeGreaterThan(0);
    for (const elision of result.elisions)
      expect(elision.recoverAt).not.toBeNull();

    expect(followRanges(result.text, CODE, SOURCE)).toBe(CODE);
  });

  it('a damaged range is rejected', () => {
    const text = compressCode(CODE, {
      sourcePath: SOURCE,
      tuning: DEFAULT_TUNING,
    }).text;

    const damaged = [
      // Off by one at the start: the agent reads the signature, not the body.
      text.replace(/-> (.+?):(\d+)-/, (_, p, a) => `-> ${p}:${Number(a) - 1}-`),
      // Off by one at the end: the last line of the body never arrives.
      text.replace(/:(\d+)-(\d+)\]/, (_, a, b) => `:${a}-${Number(b) - 1}]`),
      // The count no longer describes the range.
      text.replace(
        /\[\.\.\. body, (\d+) lines/,
        (_, n) => `[... body, ${Number(n) + 1} lines`
      ),
    ].filter((candidate) => candidate !== text);
    expect(damaged).toHaveLength(3);

    for (const candidate of damaged) {
      let rebuilt: string | null = null;
      try {
        rebuilt = followRanges(candidate, CODE, SOURCE);
      } catch {
        rebuilt = null;
      }
      expect(rebuilt).not.toBe(CODE);
    }
  });

  it('prose puts in the spill exactly what it took out of the text', () => {
    const sink = recordingSpill();
    const result = compressProse(PROSE, {
      spill: sink.spill,
      tuning: DEFAULT_TUNING,
    });

    expect(result.text.length).toBeLessThan(PROSE.length);
    expect(result.lossless).toBe(false);
    expect(sink.files.size).toBe(1);

    const [path, content] = [...sink.files][0];
    // Every lossy elision names the spill that was actually written.
    for (const elision of result.elisions)
      if (!elision.lossless) expect(elision.recoverAt).toBe(path);
    // And following that path recovers the content, not a truncation of it.
    expect(content).toBe(PROSE);
  });

  it('prose declines rather than eliding into a sink that failed', () => {
    const result = compressProse(PROSE, {
      spill: failingSpill,
      tuning: DEFAULT_TUNING,
    });

    // Declining IS lossless: the original is handed back untouched.
    expect(result.text).toBe(PROSE);
    expect(result.lossless).toBe(true);
    expect(result.elisions).toHaveLength(0);
  });
});
