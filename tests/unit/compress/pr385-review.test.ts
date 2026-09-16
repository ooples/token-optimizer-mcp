import { expect, test } from '@jest/globals';
import { compressNestedStrings } from '../../../src/compress/nested.js';
import { readNumbering } from '../../../src/compress/numbering.js';
import { compressBlock } from '../../../src/compress/router.js';
import { foldRepeatedSegments } from '../../../src/compress/segments.js';

test('nested compression preserves special own JSON keys', () => {
  const input = JSON.parse(
    '{"__proto__":{"value":17},"constructor":"own","body":"' +
      'x'.repeat(1200) +
      '"}'
  );
  const result = compressNestedStrings(input, () => ({
    text: 'short',
    elisions: [],
    lossless: true,
  }));
  const restored = JSON.parse(JSON.stringify(result.value));
  expect(Object.hasOwn(restored, '__proto__')).toBe(true);
  expect(restored.__proto__).toEqual({ value: 17 });
  expect(restored.constructor).toBe('own');
  expect(restored.body).toBe('short');
});

test('number restoration permits only exact markers with their multiplicity', () => {
  const n = readNumbering('1\tfirst\n2\tmiddle\n3\tlast')!;
  expect(n.restore('first\n[removed]\nlast', ['[removed]'])).toBe(
    '1\tfirst\n[removed]\n3\tlast'
  );
  expect(n.restore('first\nrewritten\nlast', ['[removed]'])).toBeNull();
  expect(
    n.restore('first\n[removed]\n[removed]\nlast', ['[removed]'])
  ).toBeNull();
  expect(n.restore('last\nfirst')).toBeNull();
});

test('numbered JSON rewrites fail closed to the original read', () => {
  const text = '1\t{\n2\t  "value": 1,\n3\t  "other": 2\n4\t}';
  expect(compressBlock(text).text).toBe(text);
});

test('folded sections require recovery and expose the original document', () => {
  const section = '# Heading\n' + 'detail '.repeat(120);
  const text = Array(12).fill(section).join('\n');
  expect(foldRepeatedSegments(text).text).toBe(text);
  expect(foldRepeatedSegments(text, { spill: () => '' }).text).toBe(text);
  let original = '';
  const result = foldRepeatedSegments(text, {
    spill: (value) => {
      original = value;
      return '/recovery/sections.txt';
    },
  });
  expect(original).toBe(text);
  expect(result.text.length).toBeLessThan(text.length);
  expect(result.elisions[0].recoverAt).toBe('/recovery/sections.txt');
  expect(result.lossless).toBe(false);
});
