import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_TUNING,
  PRESETS,
  presetFromEnv,
  resolveTuning,
} from '../../../src/compress/options.js';
import { compressBlock } from '../../../src/compress/router.js';
import { compressJson } from '../../../src/compress/json.js';
import { compressProse } from '../../../src/compress/prose.js';
import { compressCode } from '../../../src/compress/code.js';

/**
 * Expert presets, and the two claims that make them worth having.
 *
 * A configuration system is decoration unless the dials actually move
 * something, and a preset is a magic number with a name unless it is honest
 * about what it trades. So each preset is checked for a MEASURABLE difference
 * in the right direction, and `lossless` is checked for the property it is
 * named after rather than merely for compressing less.
 */

const rows = (n: number): string =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: `doc_${i}`,
      score: 0.5,
      title: 'A reasonably long result title so the payload has some bulk',
      metadata: { author: 'Someone', category: 'technical' },
    }))
  );

const source = Array.from(
  { length: 8 },
  (_, i) => `export function handler${i}(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  const parts = upper.split(',');
  return parts.join('|');
}`
).join('\n\n');

const passage = [
  'The service loads its configuration from disk at boot.',
  'It is worth noting that this is generally considered good practice.',
  'The connection pool is sized from the worker count.',
  'As we mentioned, callers should handle the error.',
  'In other words, the system might possibly retry more often than needed.',
  'Needless to say, this is documented elsewhere.',
  'Of course, that is only one approach among several.',
  'Please note that the defaults are usually fine for most users.',
].join(' ');

const spill = (): string => '/spill/x';

describe('resolveTuning', () => {
  it('returns the measured defaults when nothing is asked for', () => {
    expect(resolveTuning()).toEqual(DEFAULT_TUNING);
    expect(resolveTuning({}, 'balanced')).toEqual(DEFAULT_TUNING);
  });

  it('layers the caller over the preset, and the preset over the defaults', () => {
    // "aggressive, but keep six head rows" has to be expressible, or an expert
    // who knows their content better than our heuristics cannot say so.
    const tuning = resolveTuning({ keepRows: 6 }, 'aggressive');
    expect(tuning.keepRows).toBe(6);
    expect(tuning.minRowsToElide).toBe(PRESETS.aggressive.minRowsToElide);
    expect(tuning.maxLiveShare).toBe(DEFAULT_TUNING.maxLiveShare);
  });

  it('falls back to balanced on a name nobody defined', () => {
    // A typo in a configuration string must not take down a proxy whose whole
    // design is to fail open, and the shipped behaviour is where it lands.
    expect(resolveTuning({}, 'agressive')).toEqual(DEFAULT_TUNING);
    expect(resolveTuning({}, undefined)).toEqual(DEFAULT_TUNING);
  });

  it('reads one variable from the environment', () => {
    expect(presetFromEnv({ TOKEN_OPTIMIZER_COMPRESSION: 'lossless' })).toBe(
      'lossless'
    );
    expect(presetFromEnv({ TOKEN_OPTIMIZER_COMPRESSION: '  Aggressive ' })).toBe(
      'aggressive'
    );
    expect(presetFromEnv({})).toBe('balanced');
    expect(presetFromEnv({ TOKEN_OPTIMIZER_COMPRESSION: 'nonsense' })).toBe(
      'balanced'
    );
  });
});

describe('the dials actually move something', () => {
  it('aggressive keeps fewer rows than balanced', () => {
    const payload = rows(60);
    const balanced = compressJson(payload, {
      spill,
      tuning: resolveTuning({}, 'balanced'),
    });
    const aggressive = compressJson(payload, {
      spill,
      tuning: resolveTuning({}, 'aggressive'),
    });
    expect(aggressive.text.length).toBeLessThan(balanced.text.length);
  });

  it('conservative keeps more rows than balanced', () => {
    const payload = rows(60);
    const balanced = compressJson(payload, {
      spill,
      tuning: resolveTuning({}, 'balanced'),
    });
    const conservative = compressJson(payload, {
      spill,
      tuning: resolveTuning({}, 'conservative'),
    });
    expect(conservative.text.length).toBeGreaterThan(balanced.text.length);
  });

  it('conservative keeps more prose than aggressive', () => {
    const keep = (preset: string): number =>
      compressProse(passage, { spill, tuning: resolveTuning({}, preset) }).text
        .length;
    expect(keep('conservative')).toBeGreaterThan(keep('aggressive'));
  });
});

describe('lossless is lossless, not merely smaller', () => {
  const tuning = resolveTuning({}, 'lossless');

  it('elides no function bodies', () => {
    // A replaced body is gone from the text; only its path brings it back.
    const out = compressCode(source, { sourcePath: 'src/h.ts', tuning });
    expect(out.elisions).toHaveLength(0);
    expect(out.text).toBe(source);
  });

  it('removes no rows from an array', () => {
    const payload = rows(60);
    const out = compressJson(payload, { spill, tuning });
    // Every id still present: nothing was dropped.
    for (let i = 0; i < 60; i += 1) expect(out.text).toContain(`doc_${i}`);
  });

  it('leaves prose whole', () => {
    const out = compressProse(passage, { spill, tuning });
    expect(out.text).toBe(passage);
  });

  it('still compresses, using only what it can fully describe', () => {
    // The point is not that it does nothing. Whitespace and null keys are
    // removed and the output re-serialises to the same document.
    const pretty = JSON.stringify(
      { a: 1, b: null, rows: [1, 2, 3] },
      null,
      2
    );
    const out = compressJson(pretty, { spill, tuning });
    expect(out.text.length).toBeLessThan(pretty.length);
    expect(out.lossless).toBe(true);
  });

  it('reports every elision it makes as lossless', () => {
    // THE PROPERTY THE PRESET IS NAMED AFTER. Compressing less is not the
    // claim; the claim is that the output fully determines what was removed.
    const payload = rows(60);
    for (const text of [payload, source, passage]) {
      const out = compressBlock(text, {
        spill,
        sourcePath: 'src/h.ts',
        tuning,
      });
      for (const elision of out.elisions) expect(elision.lossless).toBe(true);
    }
  });
});
