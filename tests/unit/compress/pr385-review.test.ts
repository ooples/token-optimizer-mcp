import { expect, test } from '@jest/globals';
import { compressNestedStrings } from '../../../src/compress/nested.js';
import { readNumbering } from '../../../src/compress/numbering.js';
import { compressBlock } from '../../../src/compress/router.js';
import { foldRepeatedSegments } from '../../../src/compress/segments.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';

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

test('a folded section is recoverable, inline or at a named spill', () => {
  // WHICH CUT IT WAS DECIDES WHICH. PR 385 asked that a fold never drop content
  // with no way back, and that still holds; what has changed is that one of the
  // two cuts carries the way back in the output itself.
  //
  // Splitting before a heading consumes exactly the one newline it matched, so
  // the distinct sections plus the order they stood in rebuild the source byte
  // for byte. That branch writes the order inline, names no recovery path, and
  // is checked here by round-tripping it rather than by taking the claim on
  // trust -- which also makes it the only branch that can fire on the published
  // arm, which is handed no sink at all.
  const section = '# Heading\n' + 'detail '.repeat(120);
  const headed = Array(12).fill(section).join('\n');
  const inline = foldRepeatedSegments(headed);
  expect(inline.text.length).toBeLessThan(headed.length);
  expect(inline.lossless).toBe(true);
  expect(inline.elisions[0].lossless).toBe(true);
  expect(inline.elisions[0].recoverAt).toBeNull();
  expect(rehydrate(inline.text)).toBe(headed);

  // Splitting on blank lines consumes `\n\s*\n` -- a run of whitespace of a
  // length nobody wrote down -- so that branch cannot rebuild the separators and
  // still owes the reader somewhere to fetch the original. It declines outright
  // when there is nowhere to put it.
  const para = Array(12).fill('detail '.repeat(120)).join('\n\n');
  expect(foldRepeatedSegments(para).text).toBe(para);
  expect(foldRepeatedSegments(para, { spill: () => '' }).text).toBe(para);
  let original = '';
  const result = foldRepeatedSegments(para, {
    spill: (value) => {
      original = value;
      return '/recovery/sections.txt';
    },
  });
  expect(original).toBe(para);
  expect(result.text.length).toBeLessThan(para.length);
  expect(result.elisions[0].recoverAt).toBe('/recovery/sections.txt');
  expect(result.lossless).toBe(false);
});
