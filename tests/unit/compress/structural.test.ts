import { describe, it, expect } from '@jest/globals';
import {
  containsStructural,
  entropy,
  isSecretLike,
  overlapsStructural,
  structuralRanges,
} from '../../../src/compress/structural.js';
import { compressLog } from '../../../src/compress/log.js';
import { compressProse } from '../../../src/compress/prose.js';

/**
 * Identifiers survive every transform.
 *
 * Written after measuring the alternative. The log templater replaced every
 * digit run with a placeholder to build its grouping shape, and digit runs
 * occur inside identifiers, so a real line became:
 *
 *   request #f#a#c#-#b#d-#e#-#a#-ffedcba# authorised with sk-ant-api#-QmFz...
 *
 * Neither the original nor a placeholder -- still identifier-shaped enough for
 * a model to quote back or search for. A dropped value is visibly missing; a
 * shredded one is invisibly wrong.
 */

const UUID = '3f2a9c14-8b7d-4e56-9a01-ffedcba98765';
const KEY = 'sk-ant-api03-QmFzZTY0TG9va2luZ1NlY3JldFZhbHVlSGVyZQ';
const SHA = 'e83c5163316f89bfbde7d9ab23ca2e25604af290';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('entropy', () => {
  it('scores a uniform string at zero and a diverse one high', () => {
    expect(entropy('aaaaaaaa')).toBe(0);
    expect(entropy('abcdefgh')).toBeCloseTo(3, 5);
  });

  it('is zero for an empty string rather than NaN', () => {
    expect(entropy('')).toBe(0);
  });
});

describe('isSecretLike', () => {
  it('requires length as well as density', () => {
    // The floor does the work entropy cannot: a short diverse word is a word.
    expect(isSecretLike('a1b2c3d4')).toBe(false);
    expect(isSecretLike('QmFzZTY0TG9va2luZ1NlY3JldFZhbHVl')).toBe(true);
  });

  it('accepts a long hex run at the lower hex threshold', () => {
    expect(isSecretLike(SHA)).toBe(true);
  });

  it('rejects a long run of one repeated character', () => {
    // Length alone must not be enough, or every padded field becomes a secret.
    expect(isSecretLike('x'.repeat(40))).toBe(false);
  });

  it.each([
    'QmFzZTY0TG9va2luZ1NlY3JldFZhbHVl',
    'QmFzZTY0TG9va2luZ1NlY3JldFZhbHVlSGVyZQ',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'dGhpcyBpcyBhIHRlc3Qgc2VjcmV0IHZhbHVl',
    'e83c5163316f89bfbde7d9ab23ca2e25604af290',
  ])('catches the secret %s', (secret) => {
    expect(isSecretLike(secret)).toBe(true);
  });

  it.each([
    'internationalization',
    'counterrevolutionaries',
    'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
    'compressSearchResults',
    'Content-Security-Policy',
    'aaaa1111aaaa1111aaaa',
  ])('does not mistake %s for a secret', (ordinary) => {
    // These are the cases that prove entropy alone is insufficient. Measured,
    // the two classes overlap -- application/json;charset=utf-8 scores 4.190
    // against a real base64 secret at 4.173 -- so composition decides:
    // digits AND letters AND (mixed case OR base64 padding).
    expect(isSecretLike(ordinary)).toBe(false);
  });
});

describe('structuralRanges', () => {
  it('protects a UUID, which entropy alone would miss', () => {
    // Sixteen hex characters in a fixed layout scores LOW, so a purely
    // entropy-based test would shred exactly the id a debugging session needs.
    expect(isSecretLike(UUID.replace(/-/g, '').slice(0, 8))).toBe(false);
    expect(containsStructural(`request ${UUID} failed`)).toBe(true);
  });

  it('protects vendor-prefixed keys, git hashes and JWTs', () => {
    for (const secret of [KEY, SHA, JWT, 'ghp_abcdefghijklmnopqrstuvwxyz0123']) {
      expect(containsStructural(`value ${secret} here`)).toBe(true);
    }
  });

  it('finds nothing in ordinary prose', () => {
    expect(containsStructural('The retry budget is 5 attempts before giving up.')).toBe(false);
  });

  it('returns merged, sorted, non-overlapping ranges', () => {
    const text = `a ${UUID} b ${KEY} c`;
    const ranges = structuralRanges(text);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1] - 1);
    }
  });

  it('does not carry lastIndex between calls', () => {
    // The patterns are module-level and carry /g, so a stale lastIndex would
    // make the second call over different text start mid-string.
    const text = `id ${UUID} end`;
    expect(structuralRanges(text)).toEqual(structuralRanges(text));
  });
});

describe('overlapsStructural', () => {
  it('detects touching, not merely containment', () => {
    const ranges: Array<[number, number]> = [[10, 20]];
    expect(overlapsStructural(ranges, 5, 11)).toBe(true);
    expect(overlapsStructural(ranges, 19, 25)).toBe(true);
    expect(overlapsStructural(ranges, 0, 10)).toBe(false);
    expect(overlapsStructural(ranges, 20, 30)).toBe(false);
  });
});

describe('the engines honour it', () => {
  it('templates the timestamp and leaves the identifiers whole', () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `2026-09-09T18:0${i}:00Z INFO request ${UUID} authorised with ${KEY} attempt ${i}`
    );
    const out = compressLog(lines.join('\n'));

    expect(out.text).toContain(UUID);
    expect(out.text).toContain(KEY);
    // Still compressed: protection is not an excuse to stop working.
    expect(out.text.length).toBeLessThan(lines.join('\n').length);
    // And the varying part was still templated.
    expect(out.text).toContain('#');
  });

  it('never emits a partially substituted identifier', () => {
    // The specific corruption: `#f#a#c#-#b#d-...`. Pinned positively first, so
    // this cannot pass against a function that threw or returned nothing --
    // which is the whole point of the repo's no-vacuous-assertions rule.
    //
    // The lines carry a long invariant prefix on purpose. Templating only
    // ships when it actually pays, and with short lines the values -- which
    // now include the whole identifier -- cost more than the lines they
    // replace, so the engine correctly declines and the substitution path is
    // never exercised. A test that assumed otherwise would be asserting
    // nothing.
    const prefix = 'INFO scheduler dispatched the queued request to the worker pool';
    const lines = Array.from(
      { length: 8 },
      (_, i) => `2026-09-09T18:0${i}:00Z ${prefix} id ${UUID} n=${i}`
    );
    const out = compressLog(lines.join('\n'));

    expect(out.text).toContain(UUID);
    expect(out.text).toContain('occurrences');
    expect(out.text).not.toMatch(/#[0-9a-f]#[0-9a-f]/);
  });

  it('keeps a prose sentence that carries an identifier', () => {
    const sentences = [
      'The retry budget is applied before the operation is abandoned.',
      'It is worth noting that this is generally considered good practice.',
      `The failing request carried correlation id ${UUID} throughout.`,
      'As we mentioned, callers should handle the error.',
      'In other words, the system might possibly retry more often than needed.',
      'Needless to say, this is documented elsewhere.',
      'Of course, that is only one approach among several.',
      'Please note that the defaults are usually fine for most users.',
    ].join(' ');

    // Prose has no lossless half, so with nowhere to spill it declines
    // outright; the sink is what makes this a compression test at all.
    const out = compressProse(sentences, { spill: () => '/spill/prose.txt' });
    expect(out.text).toContain(UUID);
    // It really did compress -- the sentence survived on merit, not because
    // nothing was dropped.
    expect(out.text).toContain('lower-signal sentence');
  });
});
