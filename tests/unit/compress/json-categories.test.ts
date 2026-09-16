import { test, expect } from '@jest/globals';
import { rareStringGroups } from '../../../src/compress/json-facts.js';
import { compressBlock } from '../../../src/compress/router.js';

test('complete rare groups retain all candidates needed for comparisons', () => {
  const rows = Array.from({ length: 240 }, (_, i) => ({
    id: `item-${i}`,
    phase: [37, 122, 219].includes(i) ? 'queued' : 'finished',
    priority: i === 122 ? 9 : 2,
  }));
  const result = compressBlock(JSON.stringify(rows), {
    spill: () => '/tmp/categories.json',
  });
  for (const i of [37, 122, 219]) expect(result.text).toContain(`item-${i}`);
  expect(result.text).toContain('complete string-value groups kept above');
  expect(result.text).toContain('"field":"phase","value":"queued","count":3');
  expect(result.text.length).toBeLessThan(JSON.stringify(rows).length / 2);
});

test('unique IDs and oversized populations are not mislabeled as complete', () => {
  const rows = Array.from({ length: 240 }, (_, i) => ({
    id: `id-${i}`,
    category: i < 9 ? 'minority' : 'majority',
  }));
  expect(rareStringGroups(rows)).toEqual({ keep: new Set(), facts: '' });
  const partial = Array.from({ length: 240 }, (_, i) => ({
    value: i < 3 ? 'x' : i < 10 ? String(i) : 'ordinary',
  }));
  expect(rareStringGroups(partial).facts).toBe('');
});

test('hostile keys and escaped values remain typed data with exact counts', () => {
  const value = '"\\\n__proto__';
  const rows: unknown[] = Array.from({ length: 100 }, (_, i) =>
    Object.fromEntries([['__proto__', i === 77 ? value : 'ordinary']])
  );
  rows.push({}, null, [], { __proto__: null }, { __proto__: false });
  const result = rareStringGroups(rows);
  expect([...result.keep]).toEqual([77]);
  expect(JSON.parse(result.facts.slice(result.facts.indexOf('[')))).toEqual([
    { field: '__proto__', value, count: 1 },
  ]);
});

test('shared retention budget never admits a partial group or unbounded fields', () => {
  const rows = Array.from({ length: 100 }, (_, i) => Object.fromEntries(
    Array.from({ length: 20 }, (_, field) => [
      `field-${field}`,
      i >= field * 3 && i < field * 3 + 3 ? 'rare' : 'common',
    ])
  ));
  const result = rareStringGroups(rows);
  expect(result.keep.size).toBeLessThanOrEqual(10);
  const facts = JSON.parse(result.facts.slice(result.facts.indexOf('[')));
  expect(facts.length).toBeLessThanOrEqual(8);
  for (const fact of facts) {
    const indices = rows.flatMap((r, i) => r[fact.field] === fact.value ? [i] : []);
    expect(indices).toHaveLength(fact.count);
    for (const i of indices) expect(result.keep.has(i)).toBe(true);
  }
});
