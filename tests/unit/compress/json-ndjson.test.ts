/**
 * NDJSON is real tool output, and we used to remove nothing from it.
 *
 * One JSON value per line is what docker, kubectl, `jq -c` and most structured
 * loggers emit. It fails `JSON.parse` on its second line, so `compressJson`
 * took its "not our content" refusal and returned the input untouched --
 * measured at 0.0% on 10.9KB, 55.4KB and 83.3KB alike, against 94.6% for the
 * identical rows spelled as an array. The head-to-head never caught it because
 * the competitor's dumped fixtures are pretty-printed arrays.
 *
 * The refusal it sits behind is a good one and these tests pin BOTH halves: a
 * clean NDJSON document must compress, and a damaged one must still be refused.
 * Relaxing the second to get the first is the corruption the original comment
 * was written to prevent.
 */
import { test, expect } from '@jest/globals';
import { compressJson } from '../../../src/compress/json.js';

/** A spill sink, so elision has somewhere to put what it removes. */
function ctx() {
  const spilled: string[] = [];
  return {
    spilled,
    engine: {
      spill: (content: string, hint: string) => {
        spilled.push(content);
        return `.token-optimizer/spill/${spilled.length}-${hint}`;
      },
      query: 'which host errored?',
    },
  };
}

/** 300 log rows, one anomalous, in whichever spelling is asked for. */
function rows(): Record<string, unknown>[] {
  return Array.from({ length: 300 }, (_, i) => ({
    ts: `2025-01-06T00:00:${String(i % 60).padStart(2, '0')}Z`,
    level: i === 137 ? 'ERROR' : 'INFO',
    logger: 'scheduler',
    message: i === 137 ? 'disk full on worker-03' : `job_${i} completed`,
    service: 'bench',
    host: `worker-0${i % 8}`,
    trace: `trace_${100000 + i}`,
  }));
}

const asLines = (r: Record<string, unknown>[]) =>
  r.map((x) => JSON.stringify(x)).join('\n');

test('compresses an ndjson log substantially', () => {
  const text = asLines(rows());
  const out = compressJson(text, ctx().engine);
  // The array spelling of this content reaches ~94%. Anything in that region
  // proves the engine engaged; the exact figure is the benchmark's business,
  // not this test's, so the bound is deliberately loose and far above zero.
  expect(out.text.length).toBeLessThan(text.length * 0.5);
});

test('keeps the one anomalous row while actually compressing', () => {
  const text = asLines(rows());
  const out = compressJson(text, ctx().engine);
  // BOTH ASSERTIONS, TOGETHER. Checking only that the ERROR survived passes
  // identically on a compressor that returned its input -- verified by
  // reverting the fix and watching this test stay green. Untouched text
  // contains every row by definition, so the retention claim is only
  // meaningful alongside evidence that something was removed.
  expect(out.text.length).toBeLessThan(text.length * 0.5);
  expect(out.text).toContain('disk full on worker-03');
});

test('still refuses a document with one damaged line', () => {
  const lines = asLines(rows()).split('\n');
  lines[57] = '{"ts":"broken';
  const text = lines.join('\n');
  // The strictness IS the safety property: every non-empty line must parse, or
  // this is damaged JSON rather than NDJSON and must come back untouched.
  expect(compressJson(text, ctx().engine).text).toBe(text);
});

test('refuses a document too small for the reshaping to pay', () => {
  const text = '{"a":1}\n{"a":2}';
  // Two lines do parse, so the NDJSON path engages -- and then the array
  // spelling is LARGER than the lines it replaced. Returning it anyway would
  // make the compressor a decompressor on short input.
  expect(compressJson(text, ctx().engine).text).toBe(text);
});

test('a single malformed line is not treated as ndjson', () => {
  // One line would already have parsed as ordinary JSON if it were valid, so
  // reaching the fallback with a single line means that line is broken.
  const text = '{"ts":"broken';
  expect(compressJson(text, ctx().engine).text).toBe(text);
});

test('the array spelling of the same rows also compresses', () => {
  // NON-VACUITY. If this failed, the first test would be measuring an engine
  // that cannot compress this content at all rather than the ndjson path.
  const text = JSON.stringify(rows(), null, 2);
  const out = compressJson(text, ctx().engine);
  expect(out.text.length).toBeLessThan(text.length * 0.5);
});
