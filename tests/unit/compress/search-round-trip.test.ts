import { compressSearchResults } from '../../../src/compress/search.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';

/**
 * The gate for the engine's ORDINARY output.
 *
 * `search-declarations.test.ts` covers the exact-declaration table, which
 * `declarationRows` refuses below 64 uniform lines. Everything else the engine
 * emits -- a path stated once over a hunk of arbitrary content -- reached no
 * decoder at all, while `compressSearchResults` returned `lossless: true` with
 * `recoverAt: null` for it: a claim that the output alone rebuilds the input,
 * asserted by nothing.
 */

/** One hunk: contiguous line numbers under one path, with chosen matches. */
function hunk(
  path: string,
  start: number,
  texts: readonly string[],
  matched: (line: number) => boolean
): string[] {
  return texts.map(
    (text, i) => `${path}:${start + i}${matched(start + i) ? ':' : '-'}${text}`
  );
}

/**
 * Every shape `matchNote` can write, in one block.
 *
 * The note is the only record of which lines matched -- the per-line separator
 * is gone -- so a fixture that exercises one shape proves nothing about the
 * other four. `(context)`, a lone number, a span and a scattered list each
 * decode by a different rule, and the empty note, which means "all of them",
 * is the one a careless decoder gets right by accident.
 */
function fixture(newline: string): string {
  const body = [
    ...hunk(
      'src/proxy/supervisor.ts',
      10,
      ['a(', '  b()', 'c', 'd', 'e', 'f'],
      (n) => [10, 12, 15].includes(n)
    ),
    '--',
    ...hunk(
      'src/proxy/supervisor.ts',
      20,
      ['g', 'h', 'i', 'j'],
      (n) => n >= 21 && n <= 23
    ),
    '--',
    ...hunk('hooks-core/derive.mjs', 30, ['k', 'l', 'm'], (n) => n === 31),
    '',
    ...hunk('hooks-core/derive.mjs', 40, ['n', 'o', 'p'], () => false),
    ...hunk('a/b.txt', 50, ['q', 'r', 's', ''], () => true),
    // Below MIN_HUNK_LINES: restored with its own prefix rather than a header.
    ...hunk('a/b.txt', 99, ['lone'], () => false),
    'Binary file x/y.bin matches',
  ];
  return body.join(newline);
}

describe('plain search hunks reconstruct from the output alone', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('rebuilds every %s byte, line number and separator', (_label, newline) => {
    const input = fixture(newline);
    const result = compressSearchResults(input);

    expect(result.lossless).toBe(true);
    // The declaration table needs 64 uniform lines; this exercises the other
    // branch, so a failure here cannot be blamed on the covered one.
    expect(result.text).not.toContain('[exact declaration rows:');
    expect(result.text.length).toBeLessThan(input.length);
    expect(rehydrate(result.text)).toBe(input);
  });

  it('writes each match note shape, so the round trip exercised all of them', () => {
    const text = compressSearchResults(fixture('\n')).text;
    expect(text).toContain('src/proxy/supervisor.ts:10-15 (matched 10,12,15)');
    expect(text).toContain('src/proxy/supervisor.ts:20-23 (matched 21-23)');
    expect(text).toContain('hooks-core/derive.mjs:30-32 (matched 31)');
    expect(text).toContain('hooks-core/derive.mjs:40-42 (context)');
    expect(text).toContain('a/b.txt:50-53\n');
    expect(text).toContain('a/b.txt:99-lone');
  });
});

describe('the search decoder refuses what it cannot rebuild', () => {
  it('refuses a hunk claiming more lines than follow it', () => {
    // A HEADER IS A PROMISE ABOUT ARITY. Returning the three lines that do
    // follow would report a reconstruction six lines short of the original.
    expect(() => rehydrate('src/a.ts:1-9\nx\ny\nz')).toThrow(
      /claims 9 lines but 3 follow/
    );
  });

  it('refuses a declaration note whose wording it does not invert', () => {
    expect(() =>
      rehydrate('src/a.ts:1-2 [exact declaration rows: name=rhs]\nA\tb\nC\td')
    ).toThrow(/unconsumed marker/);
  });

  it('leaves the same phrase alone when it is ordinary content', () => {
    // The refusal above is about a HEADER the expander declined, not about a
    // form of words. Firing on any line carrying the phrase would make this
    // helper reject documents the engine never touched.
    const text = '{"note":"[exact declaration rows: name=rhs]"}';
    expect(rehydrate(text)).toBe(text);
  });

  it('refuses a descending range instead of walking it for ever', () => {
    // `3-1` gives a count of -1, which the short-body check cannot catch
    // because no body is ever shorter than -1 lines, and the cursor then
    // steps BACK onto this header. The helper has to fail closed.
    expect(() => rehydrate('src/a.ts:3-1\nx\ny')).toThrow(/descending range/);
  });
});
