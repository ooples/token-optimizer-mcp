import { describe, it, expect } from '@jest/globals';
import { compressCode } from '../../../src/compress/code.js';
import { compressProse } from '../../../src/compress/prose.js';
import { compressJson } from '../../../src/compress/json.js';
import { foldRepeatedSegments } from '../../../src/compress/segments.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';
import { expandLog } from '../../helpers/expand-log.js';
import { rehydrate } from '../../support/rehydrate.js';

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

  it('the lossless decoder refuses to reconstruct a lossy output', () => {
    // expandLog is the oracle the lossless gate trusts. Handed output that
    // recovers through a PATH, it must refuse rather than hand back a
    // string: every marker it cannot rebuild is content it never restored,
    // and passing one through as a literal line reports a successful
    // reconstruction that did not happen. This is the one crossing point
    // between the two gates, so it is tested from real engine output.
    const lossy = compressCode(CODE, {
      sourcePath: SOURCE,
      tuning: DEFAULT_TUNING,
    });
    expect(lossy.lossless).toBe(false);
    expect(lossy.text).toContain(`-> ${SOURCE}:`);
    expect(() => expandLog(lossy.text)).toThrow(/unrecognised marker/);

    // The positive control: the same decoder on output it CAN rebuild.
    // Without this the assertion above passes on a decoder that throws on
    // everything, which would be no oracle at all.
    expect(expandLog('alpha\nbeta')).toBe('alpha\nbeta');
  });
});

/**
 * A repetitive document: `segment` needs MIN_SEGMENTS parts and a duplicate
 * share high enough that folding pays for the note it adds.
 */
const SECTIONS = [
  'alpha block with enough text in it to be worth folding away entirely',
  'beta block with enough text in it to be worth folding away entirely',
  'alpha block with enough text in it to be worth folding away entirely',
  'gamma block with enough text in it to be worth folding away entirely',
  'alpha block with enough text in it to be worth folding away entirely',
  'beta block with enough text in it to be worth folding away entirely',
  'delta block with enough text in it to be worth folding away entirely',
  'beta block with enough text in it to be worth folding away entirely',
].join('\n\n');

const ROWS = JSON.stringify(
  Array.from({ length: 60 }, (_, i) => ({
    id: i,
    region: 'us-east-1',
    status: 'ok',
    latencyMs: 20 + (i % 7),
  }))
);

describe('the spill is the only way back, so it must hold what went', () => {
  it('segments spills the original, not the folded result', () => {
    const sink = recordingSpill();
    const result = foldRepeatedSegments(SECTIONS, { spill: sink.spill });

    // An engine that declined would satisfy the recovery assertions for free.
    expect(result.text.length).toBeLessThan(SECTIONS.length);
    expect(result.lossless).toBe(false);
    expect(sink.files.size).toBe(1);

    const [path, content] = [...sink.files][0];
    expect(result.elisions.map((e) => e.recoverAt)).toEqual([path]);
    // THE NOTE NAMES A COUNT, NEVER WHICH SECTION STOOD WHERE, so `A B A` and
    // `A A B` fold identically. The spill is the whole original precisely
    // because the output cannot say that, and a spill holding only the folded
    // copies would leave the order gone with nowhere to look.
    expect(content).toBe(SECTIONS);
  });

  it('segments prefers a real source path and then writes no spill', () => {
    const sink = recordingSpill();
    const result = foldRepeatedSegments(SECTIONS, {
      sourcePath: 'docs/guide.md',
      spill: sink.spill,
    });

    expect(result.elisions.map((e) => e.recoverAt)).toEqual(['docs/guide.md']);
    // A spill written and never named is a file nobody will read and bytes
    // nobody asked for.
    expect(sink.files.size).toBe(0);
  });

  it('segments declines rather than folding into a sink that failed', () => {
    const result = foldRepeatedSegments(SECTIONS, { spill: failingSpill });
    expect(result.text).toBe(SECTIONS);
    expect(result.lossless).toBe(true);
    expect(result.elisions).toHaveLength(0);
  });

  it('the json tail spill holds every row, kept and dropped alike', () => {
    const sink = recordingSpill();
    const result = compressJson(ROWS, {
      spill: sink.spill,
      tuning: DEFAULT_TUNING,
    });

    expect(result.text.length).toBeLessThan(ROWS.length);
    expect(result.lossless).toBe(false);
    expect(sink.files.size).toBe(1);

    const [path, content] = [...sink.files][0];
    const lossy = result.elisions.filter((e) => !e.lossless);
    expect(lossy).not.toHaveLength(0);
    for (const elision of lossy) expect(elision.recoverAt).toBe(path);

    // EVERY ROW, not just the dropped ones. The marker says "N more rows" and
    // names one path; an agent that reads it has no offset to apply, so a
    // spill holding only the tail would answer a question nobody can ask.
    expect(JSON.parse(content)).toEqual(JSON.parse(ROWS));
  });

  it('json keeps the minification and the rows when the sink fails', () => {
    const result = compressJson(ROWS, {
      spill: failingSpill,
      tuning: DEFAULT_TUNING,
    });

    // Declining the ELISION is not declining the engine: the lossless
    // encodings lose nothing, so they survive the refusal. Since #423 the
    // engine picks whichever of them is smaller, and for uniform rows that is
    // the records template rather than plain minification -- so the rows are
    // read back through the decoder, which is the only thing that can see
    // them. `JSON.parse` on the emitted text used to work here only because
    // minification was the sole outcome.
    expect(result.elisions.every((e) => e.lossless)).toBe(true);
    expect(JSON.parse(rehydrate(result.text))).toEqual(JSON.parse(ROWS));
  });

  it('code with no source path recovers through the block it spilled', () => {
    const sink = recordingSpill();
    const result = compressCode(CODE, {
      spill: sink.spill,
      tuning: DEFAULT_TUNING,
    });

    expect(result.text.length).toBeLessThan(CODE.length);
    expect(result.lossless).toBe(false);
    expect(sink.files.size).toBe(1);

    // THE HALF OF `code` THAT HAD NO GATE. The range test above supplies a
    // sourcePath, which is the branch a grep hit or a pasted excerpt never
    // takes -- and `anchorPath` reaches for the spill exactly then. The line
    // numbers are the original block's either way, so the same reconstruction
    // applies with the spilled file standing in for the source.
    const [path, content] = [...sink.files][0];
    expect(content).toBe(CODE);
    expect(followRanges(result.text, content, path)).toBe(CODE);
  });

  it('code declines rather than pointing markers at a sink that failed', () => {
    const result = compressCode(CODE, {
      spill: failingSpill,
      tuning: DEFAULT_TUNING,
    });
    expect(result.text).toBe(CODE);
    expect(result.lossless).toBe(true);
    expect(result.elisions).toHaveLength(0);
  });
});
