import { describe, it, expect } from '@jest/globals';
import { compressJsonObjectMap } from '../../../src/compress/json-fragments.js';
import { expandJsonRecords } from '../../../src/compress/rehydrate.js';

/**
 * A KEYED MAP IS ANNOUNCED UNDER A HEADER NOBODY COULD DECODE.
 *
 * `compressRecords` writes one body under four different prose headers. A list
 * of records says `array records` and counts `records`; a keyed map says
 * `object map` and counts `entries`; a partial group says `missing records
 * remain unknown`; the short-header variant drops the sentence. Only the first
 * was ever matched by `expandJsonRecords`, so every keyed map reached
 * `rehydrate`'s UNCONSUMED guard and threw
 *
 *   rehydrate: unconsumed marker "[JSON object map; ALL 40 entries preserved,
 *   39 encoded here. ..."
 *
 * which lost the WHOLE block instead of the rows the encoding could not state.
 * That is how the human-authored-json workload came back with 116 of its 154
 * identifiers: not an encoder that dropped them, a decoder that refused to read
 * what the encoder had written.
 *
 * THE ORACLE IS THE INPUT BYTES. The encoder claims the entries are preserved,
 * so the only honest check is that the original text comes back out of the
 * marker and nothing else -- a shape assertion on the header would pass again
 * the moment the two sides drift apart, which is the bug being fixed.
 */
describe('a keyed object map survives its own encoding', () => {
  /** Forty contiguous route entries, the shape the metrics fixture has. */
  const fixture = () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      `    "/route-${i}": { "p50": ${1000 + i}, "p95": 148.50, "count": ${i} }`
    ).join(',\n');
    return `{\n  "byRoute": {\n${rows}\n  }\n}`;
  };

  it('is announced as an object map', () => {
    const out = compressJsonObjectMap(fixture());
    expect(out.text).toContain('[JSON object map; ALL 40 entries preserved');
    expect(out.text.length).toBeLessThan(fixture().length);
  });

  it('rebuilds byte for byte from the marker alone', () => {
    const text = fixture();
    const out = compressJsonObjectMap(text);
    expect(expandJsonRecords(out.text)).toBe(text);
  });

  it('leaves no marker behind for the unconsumed guard to find', () => {
    const out = compressJsonObjectMap(fixture());
    const rebuilt = expandJsonRecords(out.text);
    expect(rebuilt).not.toContain('[JSON object map');
    expect(rebuilt).not.toContain('[/JSON fragment records]');
  });
});
