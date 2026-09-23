import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';
import { jsonLexemes } from '../../support/json-lexemes.js';
import { rehydrate } from '../../support/rehydrate.js';

/**
 * THE JSON ENGINE HAS THE LARGEST MEASURED REDUCTION AND, UNTIL NOW, NO GATE.
 *
 * Every other json suite asserts the claim by reading the flag the engine set
 * itself -- `expect(out.lossless).toBe(true)` -- which cannot fail when the
 * encoding breaks. #414 established the shape for the log engine: rebuild the
 * input from the output and nothing else, and prove the gate can fail by
 * damaging the product. This is that, for json.
 *
 * THE ORACLE IS LEXICAL, NOT `JSON.parse` DEEP-EQUAL, and that difference is
 * the gate. A parse-based comparison agrees with exactly the rewrites
 * `lossless: true` forbids -- it reads `12345678901234567890` and
 * `12345678901234567000` as the same number, `0.0500` as `0.05`, `1e3` as
 * `1000`. `jsonLexemes` refuses those equivalences because it compares source
 * text, and `the parse-based oracle cannot see these rewrites` below
 * demonstrates the difference rather than asserting it.
 *
 * WHITESPACE IS THE ONE EXCEPTION. The engine minifies, so byte equality is
 * the wrong bar; a lexeme stream is the right one, because whitespace is the
 * only thing the engine may drop without recording where it went.
 *
 * TWO PATHS, TWO FIXTURES, EACH PROVEN SEPARATELY. `compressJsonArray` claims
 * only top-level arrays, and everything else falls to `minifyPreservingTokens`
 * -- so a suite built entirely from one shape leaves the other ungated. Both
 * halves were checked by mutating the product:
 *
 *   json-fragments.ts:211  slice(start, ..) -> slice(start + 1, ..)
 *                          red on 'numbers a parser would renormalise' only
 *   json.ts:249            string passthrough collapses runs of spaces
 *                          red on 'a heterogeneous config' only
 *
 * The first three fixtures drafted here were all uniform records inside an
 * envelope object, which reaches NEITHER encoder intact, and both mutations
 * stayed green against them.
 */

const BS = String.fromCharCode(92);

/** Escapes, a unicode escape and embedded quotes, none of which may be rewritten. */
function serviceInventory(): string {
  const rows = Array.from({ length: 45 }, (_, i) =>
    [
      '    {',
      `      "id": ${1000 + i},`,
      `      "path": "C:${BS}${BS}logs${BS}${BS}svc-${i}.txt",`,
      `      "uni": "${BS}u0041-${i}",`,
      `      "quote": "a ${BS}"quoted${BS}" value ${i}",`,
      `      "ok": ${i % 2 === 0},`,
      '      "extra": null',
      '    }',
    ].join('\n')
  ).join(',\n');
  return `{\n  "version": "1.0",\n  "records": [\n${rows}\n  ]\n}`;
}

/** Uniform rows, the shape the engine reduces hardest. */
function repeatingRows(): string {
  return JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({
      id: `r-${i}`,
      v: i % 7,
      note: `obs ${i}`,
    })),
    null,
    2
  );
}

/**
 * Numbers a parser would silently renormalise: past 2^53, with significant
 * trailing zeros, in exponent form, and negative zero.
 *
 * A TOP-LEVEL ARRAY, DELIBERATELY. `compressJsonArray` declines anything that
 * is not one, so wrapping these rows in an envelope object leaves the document
 * untouched (measured: 5833 -> 5833) and this fixture would gate nothing. As
 * an array it reaches the record-template encoder, which is the only path that
 * emits fragments and the only one `rehydrate` has to decode.
 */
function riskyNumbers(): string {
  const rows = Array.from({ length: 45 }, (_, i) =>
    [
      '  {',
      `    "id": ${12345678901234567890n + BigInt(i)},`,
      `    "rate": 0.05${String(i).padStart(2, '0')},`,
      `    "exp": 1e${i % 9},`,
      '    "zero": -0,',
      `    "name": "svc-${i}"`,
      '  }',
    ].join('\n')
  ).join(',\n');
  return `[\n${rows}\n]`;
}

/**
 * NOT UNIFORM, AND THAT IS THE POINT. The three fixtures above are all rows of
 * one shape, which the record encoder claims; this one has no repeating shape,
 * so it reaches the whitespace minifier instead. Both paths carry escapes, and
 * only a fixture on each path can gate both -- an escape-handling mutation in
 * `minifyPreservingTokens` left the record fixtures entirely green.
 */
function heterogeneousConfig(): string {
  return [
    '{',
    '  "service": "checkout",',
    `  "binary": "C:${BS}${BS}Program Files${BS}${BS}checkout${BS}${BS}svc.exe",`,
    `  "banner": "welcome to ${BS}"checkout${BS}", v1.0",`,
    `  "unicode": "${BS}u0041${BS}u00e9${BS}u2713",`,
    `  "newline": "line one${BS}nline two${BS}ttabbed",`,
    '  "replicas": 3,',
    '  "errorBudget": 0.0500,',
    '  "retry": {',
    '    "attempts": 5,',
    '    "backoffMultiplier": 2.0,',
    '    "jitter": true,',
    '    "giveUpAfter": null',
    '  },',
    '  "limits": { "cpu": "500m", "memory": "512Mi" },',
    '  "routes": [',
    '    { "path": "/checkout", "weight": 90, "canary": false },',
    '    { "path": "/checkout/v2", "weight": 10, "canary": true, "owner": "payments" },',
    '    { "path": "/health", "weight": 0 }',
    '  ],',
    '  "flags": ["fast-path", "new-pricing", "async-refunds"],',
    '  "notes": [',
    `    "escaped quote: ${BS}"ok${BS}"",`,
    `    "escaped slash: a${BS}${BS}b${BS}${BS}c",`,
    '    "plain text with  double  spaces"',
    '  ]',
    '}',
  ].join('\n');
}

const FIXTURES = [
  { name: 'a service inventory, escapes and all', build: serviceInventory },
  {
    name: 'a heterogeneous config, minified not templated',
    build: heterogeneousConfig,
  },
  { name: 'sixty uniform rows', build: repeatingRows },
  { name: 'numbers a parser would renormalise', build: riskyNumbers },
];

describe('a JSON block that claims lossless keeps every lexeme it was given', () => {
  it.each(FIXTURES)('$name', ({ build }) => {
    const input = build();
    // The fixture must itself be JSON, or the oracle below is measuring the
    // fixture's syntax errors rather than the engine's encoding.
    expect(() => JSON.parse(input)).not.toThrow();

    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    expect(result.lossless).toBe(true);
    expect(jsonLexemes(rehydrate(result.text))).toEqual(jsonLexemes(input));
  });

  // WITHOUT THIS THE SUITE COULD PASS ON AN ENGINE THAT RETURNS ITS INPUT.
  // Lexeme equality is trivially true for a no-op, so at least the shapes the
  // engine is supposed to reduce have to be seen reducing.
  it('and the engine really did reduce the shapes it is meant to reduce', () => {
    for (const build of [serviceInventory, repeatingRows]) {
      const input = build();
      const result = compressBlock(input, { tuning: DEFAULT_TUNING });
      expect(result.text.length).toBeLessThan(input.length * 0.8);
    }
  });

  it('the parse-based oracle cannot see these rewrites, which is why it is not used', () => {
    const input = riskyNumbers();
    // What a renormalising engine would emit: still parses, still deep-equal,
    // and no longer the document it was given.
    const renormalised = JSON.stringify(JSON.parse(input));

    // Reparsing is a FIXED POINT: whatever the first parse rewrote, the second
    // one has nothing left to rewrite, so the two canonical forms agree and a
    // parse-based comparison reports success on a document that lost bytes.
    expect(JSON.stringify(JSON.parse(renormalised))).toBe(
      JSON.stringify(JSON.parse(input))
    );
    // The lexical oracle names them: oversized integers, trailing zeros,
    // exponents, negative zero.
    expect(jsonLexemes(renormalised)).not.toEqual(jsonLexemes(input));
    expect(jsonLexemes(input)).toContain('12345678901234567890');
    expect(jsonLexemes(renormalised)).not.toContain('12345678901234567890');
  });
});

describe('the gate can fail, demonstrated on the product rather than asserted', () => {
  it('a dropped record fails the comparison', () => {
    const input = repeatingRows();
    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    const damaged = result.text.replace(
      '{"id":"r-59","v":3,"note":"obs 59"}',
      ''
    );
    expect(damaged).not.toBe(result.text);
    expect(() =>
      expect(jsonLexemes(rehydrate(damaged))).toEqual(jsonLexemes(input))
    ).toThrow();
  });

  it('a renormalised number fails the comparison', () => {
    const input = serviceInventory();
    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    const damaged = result.text.replace('"id":1000', '"id":1000.0');
    expect(damaged).not.toBe(result.text);
    expect(() =>
      expect(jsonLexemes(rehydrate(damaged))).toEqual(jsonLexemes(input))
    ).toThrow();
  });

  it('a mangled escape fails the comparison', () => {
    const input = serviceInventory();
    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    // The escape and the letter it denotes are the same string to a parser,
    // and different bytes to anyone reading the output.
    const damaged = result.text.replace(`${BS}u0041-0`, 'A-0');
    expect(damaged).not.toBe(result.text);
    expect(() =>
      expect(jsonLexemes(rehydrate(damaged))).toEqual(jsonLexemes(input))
    ).toThrow();
  });
});

describe('rehydrate refuses what it cannot rebuild', () => {
  it('refuses an unregistered marker family', () => {
    expect(() =>
      rehydrate('a line\n[... 4 gizmos folded]\nanother line')
    ).toThrow(/unrecognised marker/);
  });

  it('refuses a lossy marker, whose content is not in the output at all', () => {
    expect(() =>
      rehydrate('head\n[... 900 lines -> /spill/log.txt]\ntail')
    ).toThrow(/unrecognised marker/);
  });

  it('refuses a json marker no grammar consumed', () => {
    expect(() =>
      rehydrate(
        '{"a":1}\n[JSON array records; ALL 3 records preserved. truncated]'
      )
    ).toThrow(/unconsumed marker/);
  });

  it('refuses a tap marker no grammar consumed', () => {
    // A SECOND FAMILY, REGISTERED, STILL HAS TO FAIL CLOSED ON ITS UNKNOWN
    // VARIANTS. `[TAP timing records: ...]` is not the shape expandTapRecords
    // inverts, and a decoder that returns it as a line of text reports a
    // reconstruction it never performed.
    expect(() =>
      rehydrate(
        'ok 1 - a\n[TAP timing records: mean 4ms]\n[/TAP timing records]'
      )
    ).toThrow(/unconsumed marker/);
  });
  it('passes ordinary text through untouched', () => {
    const text = '{"a":1,"b":[2,3]}\nnot a marker [at all]\n';
    expect(rehydrate(text)).toBe(text);
  });
});
