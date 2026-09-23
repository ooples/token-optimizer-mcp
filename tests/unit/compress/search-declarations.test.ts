import {
  compressSearchResults,
  looksLikeSearchResults,
} from '../../../src/compress/search.js';

// Independent reconstruction uses only the emitted text, never the original
// input. The shared decoder rather than the local one this file used to carry:
// that one returned any header without `[exact declaration rows:` unchanged,
// so the plain path-prefix hunk -- everything the engine emits below 64
// uniform lines -- was never reconstructed by it at all.
import { rehydrate } from '../../support/rehydrate.js';

function fixture(
  path = 'src/settings.ts',
  newline = '\n',
  trailing = false
): string {
  return (
    Array.from({ length: 100 }, (_, index) => {
      const rhs =
        index === 71
          ? '"opaque-{name}-sk-example-0123456789;\\t"'
          : String(index * 13 + 7);
      return `${path}:${index + 101}${index % 5 === 0 ? '-' : ':'}export const SETTING_${index} = ${rhs};`;
    }).join(newline) + (trailing ? newline : '')
  );
}

describe('exact declaration rows in search output', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])(
    'reconstructs every %s byte, location, value and context marker',
    (_label, newline) => {
      for (const trailing of [false, true]) {
        const input = fixture('src/settings.ts', newline, trailing);
        const result = compressSearchResults(input);
        expect(result.text).toContain('[exact declaration rows:');
        expect(result.text).toContain(
          'SETTING_71\t"opaque-{name}-sk-example-0123456789;\\t"'
        );
        expect(result.lossless).toBe(true);
        expect(rehydrate(result.text)).toBe(input);
      }
    }
  );

  it('preserves Windows drive and UNC paths and keeps distinct files separate', () => {
    const input =
      fixture('C:\\repo\\settings.ts') +
      '\n' +
      fixture('\\\\server\\share\\config.ts');
    expect(looksLikeSearchResults(input)).toBe(true);
    expect(rehydrate(compressSearchResults(input).text)).toBe(input);
  });

  it('retains all declarations when values contain a real tab or syntax differs', () => {
    for (const replacement of [
      'export const VALUE = "a\tb";',
      '// an important contract',
      'let VALUE = 8;',
    ]) {
      const input = fixture().replace(
        'export const SETTING_22 = 293;',
        replacement
      );
      const output = compressSearchResults(input).text;
      expect(output).not.toContain('[exact declaration rows:');
      expect(output).toContain(replacement);
      expect(output).toContain('SETTING_71');
    }
  });

  it('keeps short hunks readable without an amortization loss', () => {
    const input = fixture().split('\n').slice(0, 8).join('\n');
    const output = compressSearchResults(input).text;
    expect(output).not.toContain('[exact declaration rows:');
    expect(output).toContain('export const SETTING_0 = 7;');
  });

  it('preserves mixed endings and noncanonical or unsafe line numbers verbatim', () => {
    // Construct exactly one CRLF boundary followed by LF boundaries. This is
    // deliberately mixed input, not an incomplete newline-normalization step.
    const [first, ...rest] = fixture().split('\n');
    const mixed = `${first}\r\n${rest.join('\n')}`;
    expect(compressSearchResults(mixed).text).toBe(mixed);
    for (const number of ['0001', '9007199254740993']) {
      const input = Array.from(
        { length: 70 },
        (_, index) => `src/a.ts:${number}:const key${index}=0;`
      ).join('\n');
      expect(compressSearchResults(input).text).toBe(input);
    }
  });

  it('handles large result sets without spreading rows into a call argument list', () => {
    const input = Array.from(
      { length: 130000 },
      (_, index) =>
        `src/large.ts:${index + 1}:export const VALUE_${index} = ${index};`
    ).join('\n');
    const result = compressSearchResults(input);
    expect(result.text).toContain('[exact declaration rows:');
    expect(result.text.split('\n')).toHaveLength(130001);
    expect(result.text.endsWith('VALUE_129999\t129999')).toBe(true);
  });

  it('does not mistake timestamps for source paths', () => {
    expect(
      looksLikeSearchResults(
        Array(70).fill('18:10:00Z INFO healthy').join('\n')
      )
    ).toBe(false);
  });
});
