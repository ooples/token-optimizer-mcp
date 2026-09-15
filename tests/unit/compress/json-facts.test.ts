import { test, expect } from '@jest/globals';
import { booleanFacts } from '../../../src/compress/json-facts.js';
import { compressBlock } from '../../../src/compress/router.js';

function counts(rows: unknown[]) {
  const text = booleanFacts(rows);
  return JSON.parse(text.slice(text.indexOf('{')));
}
test('boolean facts distinguish false, missing, null and string values across every row', () => {
  expect(
    counts([
      { enabled: true },
      { enabled: false },
      { enabled: null },
      { enabled: 'false' },
      {},
      null,
      [],
    ])
  ).toEqual({ enabled: { true: 1, false: 1, missing: 3, other: 2 } });
});
test('complete-array elision carries exact counts, including a rare disabled record', () => {
  const rows = Array.from({ length: 240 }, (_, i) => ({
    id: `route-${i}`,
    enabled: i !== 122,
    limit: 100,
  }));
  const result = compressBlock(JSON.stringify(rows, null, 2), {
    spill: () => '/tmp/complete.json',
  });
  expect(result.text.length).toBeLessThan(JSON.stringify(rows).length);
  expect(result.text).toContain('exact boolean counts over all 240 rows');
  expect(result.text).toContain(
    '"enabled":{"true":239,"false":1,"missing":0,"other":0}'
  );
});
test('fact size is bounded and hostile property names remain data', () => {
  const row = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`field${i}`, true])
  );
  expect(Object.keys(counts([row]))).toHaveLength(8);
  const special = JSON.parse('{"__proto__":false,"constructor":true}');
  expect(counts([special])).toEqual(
    JSON.parse(
      '{"__proto__":{"true":0,"false":1,"missing":0,"other":0},"constructor":{"true":1,"false":0,"missing":0,"other":0}}'
    )
  );
  expect(booleanFacts([{ text: 'false' }, 42])).toBe('');
});
