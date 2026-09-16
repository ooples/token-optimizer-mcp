import { test, expect } from '@jest/globals';
import { compressNestedStrings } from '../../../src/compress/nested.js';

test('unchanged trees share storage; changed branches copy without mutating siblings', () => {
  const input = {
    rows: [{ id: 1 }, { body: 'x'.repeat(1500) }],
    untouched: { nested: null },
  };
  expect(
    compressNestedStrings(input, (text) => ({ text, elisions: [] })).value
  ).toBe(input);
  const result = compressNestedStrings(input, () => ({
    text: 'short',
    elisions: [],
    lossless: true,
  }));
  const next = result.value as typeof input;
  expect(next).not.toBe(input);
  expect(next.untouched).toBe(input.untouched);
  expect(next.rows[0]).toBe(input.rows[0]);
  expect(next.rows[1].body).toBe('short');
  expect(input.rows[1].body).toHaveLength(1500);
});
