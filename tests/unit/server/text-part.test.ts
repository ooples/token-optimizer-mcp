/**
 * A split reply must cost less and say the same thing.
 *
 * Two claims, and they are only worth anything together. Cheaper alone is
 * satisfied by throwing the content away; identical alone is satisfied by
 * changing nothing. So every refusal case below sits beside a case that does
 * lift -- without that control arm a liftTextPart that had stopped working
 * would pass the whole refusal half of this file.
 */

import {
  liftTextPart,
  restoreTextPart,
  TEXT_PART_KEY,
} from '../../../src/server/text-part.js';

/** One text part, the way the dispatch builds a reply. */
function oneJsonPart(payload: unknown): Array<{ type: string; text: string }> {
  return [{ type: 'text', text: JSON.stringify(payload) }];
}

/**
 * Escape-dense source: quotes, apostrophes, newlines and a backslash.
 *
 * The escape tax is paid per special character, so a fixture of plain words
 * would understate it to near nothing -- measured, 519 tokens of plain ASCII
 * lines paid two tokens, where three thousand characters of this repository's
 * own TypeScript paid 255.
 */
const SOURCE = Array.from(
  { length: 40 },
  (_, i) =>
    `export const name${i} = { "key": 'value ${i}', re: /a\\d+/, s: "q\\\\\"q" };`
).join('\n');

describe('lifting a payload field into its own text part', () => {
  test('a read-shaped reply is cheaper split than escaped', () => {
    const payload = { path: '/tmp/x.ts', size: SOURCE.length, content: SOURCE };
    const before = oneJsonPart(payload);
    const { content, lifted } = liftTextPart(before);

    expect(lifted).toBe(true);
    expect(content).toHaveLength(2);
    // MEASURED ON BOTH COMPLETE RENDERINGS. The envelope keeps its braces and
    // gains a key, so the saving is the difference between the two replies as
    // they go on the wire, not the difference between the field's two forms.
    const after = content.map((part) => part.text).join('\n');
    expect(after.length).toBeLessThan(before[0].text.length);
  });

  test('the caller gets back exactly the payload it would have had', () => {
    const payload = {
      path: '/tmp/x.ts',
      size: SOURCE.length,
      content: SOURCE,
      metadata: { fromCache: false, lines: 40 },
    };
    const { content } = liftTextPart(oneJsonPart(payload));

    // Deep equality is the contract: key order is not information, and
    // recording a position in the envelope would cost what this exists to save.
    expect(restoreTextPart(content)).toEqual(payload);
    // And the text really is the text, not a rendering of it.
    expect(content[1].text).toBe(SOURCE);
  });

  test('the envelope names where the text went', () => {
    const { content } = liftTextPart(
      oneJsonPart({ path: '/tmp/x.ts', content: SOURCE })
    );
    const envelope = JSON.parse(content[0].text);

    expect(envelope[TEXT_PART_KEY]).toEqual({ path: 'content', index: 1 });
    expect(envelope.content).toBeUndefined();
    expect(envelope.path).toBe('/tmp/x.ts');
  });
});

describe('a nested field', () => {
  test('is lifted by its path and restored to it', () => {
    // smart_pretty's formatted code sits at data.format.code, not at the root,
    // so a root-only rule would leave the whole formatting family escaped.
    const payload = {
      success: true,
      data: { format: { code: SOURCE, changed: true } },
    };
    const { content, lifted } = liftTextPart(oneJsonPart(payload));

    expect(lifted).toBe(true);
    expect(JSON.parse(content[0].text)[TEXT_PART_KEY]).toEqual({
      path: 'data.format.code',
      index: 1,
    });
    expect(restoreTextPart(content)).toEqual(payload);
  });

  test('is left alone when a key on its path holds a dot', () => {
    // A dotted key cannot be told apart from a path through two keys, so the
    // envelope would describe a payload that does not exist.
    const payload = { 'a.b': { code: SOURCE } };
    expect(liftTextPart(oneJsonPart(payload)).lifted).toBe(false);
  });
});

describe('what is not lifted', () => {
  test('a prose reply, which has no escape to recover', () => {
    const parts = [{ type: 'text', text: `--- summary ---\n${SOURCE}` }];
    expect(liftTextPart(parts).lifted).toBe(false);
    expect(liftTextPart(parts).content).toBe(parts);
  });

  test('a reply that is already several parts', () => {
    const parts = [
      { type: 'text', text: JSON.stringify({ content: SOURCE }) },
      { type: 'text', text: 'trailer' },
    ];
    expect(liftTextPart(parts).lifted).toBe(false);
  });

  test('a saving too small to be worth a part boundary', () => {
    const payload = { path: '/tmp/x.ts', content: 'export const a = 1;' };
    expect(liftTextPart(oneJsonPart(payload)).lifted).toBe(false);
  });

  test('a payload that already uses the envelope key', () => {
    // Overwriting it would lose whatever the tool meant by it.
    const payload = { content: SOURCE, [TEXT_PART_KEY]: 'the tool owns this' };
    expect(liftTextPart(oneJsonPart(payload)).lifted).toBe(false);
  });

  test('an array element, however long, because removing one shifts the rest', () => {
    const payload = { summary: 'ok', lines: [SOURCE, SOURCE] };
    const { content, lifted } = liftTextPart(oneJsonPart(payload));

    // `summary` is the only candidate and it is far too short to pay, so the
    // reply is left whole rather than the long array entries being taken.
    expect(lifted).toBe(false);
    expect(content).toHaveLength(1);
  });

  test('a top-level array, which has no field to name', () => {
    expect(liftTextPart(oneJsonPart([SOURCE, SOURCE])).lifted).toBe(false);
  });
});

describe('restoring a reply that was never split', () => {
  test('parses straight through, so a caller never asks which kind it has', () => {
    const payload = { path: '/tmp/x.ts', content: 'short' };
    expect(restoreTextPart(oneJsonPart(payload))).toEqual(payload);
  });

  test('a prose reply restores to nothing rather than to a guess', () => {
    expect(restoreTextPart([{ type: 'text', text: 'not json' }])).toBeNull();
  });

  test('no parts at all restores to nothing', () => {
    expect(restoreTextPart(undefined)).toBeNull();
    expect(restoreTextPart([])).toBeNull();
  });
});
