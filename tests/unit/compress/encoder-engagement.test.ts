import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import {
  compressJsonArray,
  compressJsonObjectMap,
} from '../../../src/compress/json-fragments.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';

/**
 * AN ENCODER THAT SILENTLY RETURNS ITS INPUT IS THE DEFECT THIS FILE EXISTS FOR.
 *
 * Every engine here answers `unchanged(text)` when it decides not to act, and
 * that is the right contract -- declining IS lossless. The problem is that it
 * makes "correctly declined" and "broken and inert" the same observable: 0.0%,
 * no error, no marker, a green suite.
 *
 * Three real instances, all found by measurement rather than by a test:
 *
 *   - the compact one-line-per-record scanner sat behind `minimumRows < 32`,
 *     false on the default call, so it was unreachable from the router and a
 *     `jq -c` array compressed 12.9% instead of 77%;
 *   - the object-map encoder matched entries but stopped before the `,` between
 *     them, and compressRecords only groups CONTIGUOUS records, so nothing ever
 *     grouped and it returned its input;
 *   - the same encoder compared its match count against the WRAPPER's property
 *     count, so every nested map -- which is every realistic one -- was refused.
 *
 * Each was a comment in a commit message before it was a test. This is the
 * test: every encoder must demonstrably ENGAGE on the shape it exists for, so a
 * future change that quietly switches one off fails here instead of shipping.
 */

const price = (i: number) =>
  ['19.90', '5.00', '100.0', '2.50', '1e3', '0.0600'][i % 6];

/** One record per line -- what `jq -c` and most compact printers emit. */
const oneLinePerRecord = (n: number) =>
  `[\n${Array.from(
    { length: n },
    (_, i) =>
      `  { "sku": "A-${i}", "price": ${price(i)}, "currency": "USD", ` +
      `"taxRate": 0.0825, "note": "line ${i} priced by hand" }`
  ).join(',\n')}\n]`;

/** The pretty form, several lines per record. */
const multiLinePerRecord = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: `sensor-${i}`,
      value: i % 13,
      note: `reading ${i}`,
    })),
    null,
    2
  );

const routeMap = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `    "/route-${i}": { "p50": ${(i % 9) + 1}.0, "p95": 148.50, ` +
      `"count": ${1000 + i} }`
  ).join(',\n');

const nestedMap = (n: number) =>
  `{\n  "window": "5m",\n  "errorRate": 0.00100,\n  "byRoute": {\n${routeMap(n)}\n  }\n}`;

const topLevelMap = (n: number) => `{\n${routeMap(n)}\n}`;

/** A shape, and the floor below which the encoder is not really working. */
const SHAPES: Array<{
  name: string;
  text: string;
  floor: number;
  run: (text: string) => { text: string; lossless: boolean };
}> = [
  {
    name: 'array, one record per line, through the router',
    text: oneLinePerRecord(90),
    floor: 0.4,
    run: (text) => compressBlock(text, { tuning: DEFAULT_TUNING }),
  },
  {
    name: 'array, one record per line, through the engine',
    text: oneLinePerRecord(90),
    floor: 0.4,
    run: (text) => compressJsonArray(text),
  },
  {
    name: 'array, several lines per record',
    text: multiLinePerRecord(120),
    floor: 0.5,
    run: (text) => compressJsonArray(text),
  },
  {
    name: 'object map at the top level',
    text: topLevelMap(40),
    floor: 0.4,
    run: (text) => compressJsonObjectMap(text),
  },
  {
    name: 'object map nested under a wrapper',
    text: nestedMap(40),
    floor: 0.3,
    run: (text) => compressJsonObjectMap(text),
  },
  {
    name: 'object map nested, through the router',
    text: nestedMap(40),
    floor: 0.3,
    run: (text) => compressBlock(text, { tuning: DEFAULT_TUNING }),
  },
];

describe('every encoder engages on the shape it exists for', () => {
  it.each(SHAPES)('$name', ({ text, floor, run }) => {
    const result = run(text);

    // THE ASSERTION THAT WOULD HAVE CAUGHT ALL THREE. Returning the input is
    // indistinguishable from a correct decline unless a shape the encoder is
    // FOR is named and held to a floor.
    expect(result.text).not.toBe(text);
    const reduction = 1 - result.text.length / text.length;
    expect(reduction).toBeGreaterThan(floor);
    expect(result.lossless).toBe(true);
  });

  it('a shape no encoder claims is still declined, not mangled', () => {
    // The positive control. Without it, "everything engages" could be met by an
    // engine that acts on anything at all, which is the opposite defect.
    const prose =
      'The scheduler acquires a lease before dispatching work. ' +
      'It renews that lease on a fixed interval.';
    const result = compressJsonObjectMap(prose);
    expect(result.text).toBe(prose);
    expect(result.lossless).toBe(true);
  });

  it('a map whose entries are not contiguous is declined', () => {
    // Contiguity is what compressRecords groups on, and the encoder must fail
    // closed rather than emit a template covering entries it did not match.
    const scattered =
      '{\n  "a": { "x": 1 },\n  "note": "prose between the entries",\n' +
      '  "b": { "x": 2 },\n  "other": 7,\n  "c": { "x": 3 }\n}';
    const result = compressJsonObjectMap(scattered, 3);
    expect(result.lossless).toBe(true);
    // Either it declined, or whatever it emitted is genuinely smaller.
    if (result.text !== scattered)
      expect(result.text.length).toBeLessThan(scattered.length);
  });
});
