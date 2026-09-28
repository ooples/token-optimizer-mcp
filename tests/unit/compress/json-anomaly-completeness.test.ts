import { expect, test } from '@jest/globals';
import { compressJson } from '../../../src/compress/json.js';
test('unsafe integer lexemes survive with no parsed extrema', () => {
  const text =
    '[' +
    Array.from(
      { length: 50 },
      (_, i) =>
        `{"id":${i % 2 ? '9007199254740993' : '9007199254740992'},"description":"repeated text"}`
    ).join(',') +
    ']';
  let spilled = '';
  const result = compressJson(text, {
    spill: (s) => {
      spilled = s;
      return '/rows.json';
    },
  });
  expect(result.text).toContain('9007199254740993');
  expect(result.text).toContain('9007199254740992');
  expect(spilled).toBe('');
  const nested = '{"data":' + text + '}';
  expect(compressJson(nested).text).toBe(nested);
});

test('capped shape representatives do not claim the whole population survives', () => {
  // THE DEVIATING ROWS ARE INTERLEAVED, so that this still reaches the capped
  // path. They used to be one contiguous block (`i >= 140`), which the array
  // templater now encodes whole and losslessly -- 74811 bytes to 2624, decoding
  // byte for byte -- so that fixture stopped exercising capping at all and the
  // `lossless` assertion below was passing for the wrong reason. Alternating the
  // shape leaves no run of three alike for the templater to group, which is what
  // sends the array down the anomaly path this test is about.
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: i,
    description: 'ordinary payload '.repeat(20),
    ...(i % 2 ? { relationships: [i] } : {}),
  }));
  let recovery = '';
  const result = compressJson(JSON.stringify(rows), {
    spill: (text) => {
      recovery = text;
      return '/recovery/rows.json';
    },
  });
  expect(result.lossless).toBe(false);
  expect(result.text).not.toContain('that differ are kept above');
  expect(result.text).not.toContain('"id":170,');
  expect(JSON.parse(recovery)).toEqual(rows);
});

test('complete exceptional shapes still report the actual retained population', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: i,
    description: 'ordinary payload '.repeat(20),
    ...(i === 140 || i === 170 ? { relationships: [i] } : {}),
  }));
  const result = compressJson(JSON.stringify(rows), {
    spill: () => '/recovery/rows.json',
  });
  expect(result.text).toContain('all 2 rows that differ are kept above');
  expect(result.text).toContain('"id":140,');
  expect(result.text).toContain('"id":170,');
});
