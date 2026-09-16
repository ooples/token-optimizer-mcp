import { test, expect } from '@jest/globals';
import { numericExtrema } from '../../../src/compress/json-numeric.js';
import { compressJson } from '../../../src/compress/json.js';
import { nullFacts } from '../../../src/compress/json-facts.js';

test('null facts distinguish null from missing and typed values', () => {
  expect(
    nullFacts([{ v: null }, {}, { v: false }, { v: 'null' }, null])
  ).toContain('"v":{"null":1,"missing":2,"other":2}');
});

test('numeric extrema retain negative minima and interior maxima without coercing null or strings', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `item-${i}`,
    value: 10,
  }));
  rows[41].value = -200;
  rows[77].value = 901;
  const report = numericExtrema([
    ...rows,
    { value: null },
    {},
    { value: '9999' },
  ]);
  expect([...report.keep]).toEqual([41, 77]);
  expect(report.facts).toContain('"numericRows":100');
  const compressed = compressJson(JSON.stringify(rows), {
    spill: () => '/recovery.json',
  });
  expect(compressed.text).toContain('item-41');
  expect(compressed.text).toContain('item-77');
  expect(compressed.text).toContain('"max":901');
});

test('constant fields add no output; ties are explicitly not claimed complete', () => {
  expect(numericExtrema([{ v: 2 }, { v: 2 }]).facts).toBe('');
  const report = numericExtrema([{ v: 1 }, { v: 5 }, { v: 5 }]);
  expect([...report.keep]).toEqual([0, 1]);
  expect(report.facts).toContain('ties may be omitted');
});

test('recovery preserves nulls in rows outside the retained sample', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `x-${i}`,
    value: null,
  }));
  let recovered = '';
  compressJson(JSON.stringify(rows), {
    spill: (text) => {
      recovered = text;
      return '/recovery.json';
    },
  });
  expect(JSON.parse(recovered)).toEqual(rows);
});
