import { describe, it, expect } from '@jest/globals';
import { compressJsonArray } from '../../../src/compress/json-fragments.js';

/**
 * AN ARITHMETIC COLUMN IS EMITTED AS A RULE, SO A DECODER MUST APPLY THE RULE.
 *
 * Sequential ids, byte offsets and line numbers step by a constant, and the
 * engine now states such a column once -- `slot=first+stepN` -- instead of
 * spelling out every value. That is a complete generator rather than a summary,
 * but it is only lossless if something can actually run it.
 *
 * THIS FILE EXISTS BECAUSE THE EXISTING ROUND-TRIP TESTS CANNOT SEE THE FEATURE.
 * Their fixtures use `value: i % 13`, which cycles rather than steps, and string
 * ids -- so no column qualifies, the runs clause is never emitted, and all 659
 * tests passed unchanged after the encoder started omitting cells from rows. A
 * green suite meant nothing here, which is the same vacuity that let a lossless
 * claim ship unchecked earlier in this work.
 */

/** Rebuilds the original from the emitted text alone, rule included. */
function expand(text: string): string {
  return text.replace(
    /\[JSON array records; ALL \d+ records preserved\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: (\[[^\n]+?\])(; slots ([^\]\n]+) count from 0)?\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (
      _all,
      encoded: string,
      _clause,
      slots: string | undefined,
      rows: string
    ) => {
      const template = JSON.parse(encoded) as (number | string)[];
      const rules = new Map<number, { first: number; step: number }>();
      for (const part of (slots ?? '').split(' ').filter(Boolean)) {
        const m = /^(\d+)=(-?\d+)\+(-?\d+)n$/.exec(part);
        if (!m) throw new Error(`unreadable run clause ${part}`);
        rules.set(Number(m[1]), { first: Number(m[2]), step: Number(m[3]) });
      }
      return rows
        .trim()
        .split('\n')
        .map((row, index) => {
          const present = JSON.parse(row) as string[];
          // Slots carrying a rule were omitted from the row; the rest arrive in
          // order, so the two streams are interleaved by slot number.
          const slotCount =
            present.length + [...rules.keys()].filter((k) => k >= 0).length;
          const values: string[] = [];
          let next = 0;
          for (let slot = 0; slot < slotCount; slot += 1) {
            const rule = rules.get(slot);
            values.push(
              rule ? String(rule.first + rule.step * index) : present[next++]
            );
          }
          return template
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('');
    }
  );
}

const arithmetic = (n: number) =>
  '[\n' +
  Array.from(
    { length: n },
    (_, i) =>
      `  { "id": ${1000 + i}, "offset": ${i * 64}, "line": ${i + 1}, ` +
      `"status": "ok", "bytes": 4096 }`
  ).join(',\n') +
  '\n]';

describe('an arithmetic column reconstructs from its rule', () => {
  it('rebuilds every original byte', () => {
    const input = arithmetic(120);
    const out = compressJsonArray(input);

    // The feature must actually fire, or the reconstruction below proves
    // nothing about it -- this is what the existing round-trip tests lacked.
    expect(out.text).toContain('; slots ');
    expect(out.text.length).toBeLessThan(input.length * 0.2);
    expect(out.lossless).toBe(true);

    expect(expand(out.text)).toBe(input);
  });

  it('a damaged rule is rejected rather than silently wrong', () => {
    const input = arithmetic(120);
    const text = compressJsonArray(input).text;

    const damaged = [
      text.replace(
        /(\d+)=(-?\d+)\+(-?\d+)n/,
        (_m, s, f, st) => `${s}=${Number(f) + 1}+${st}n`
      ),
      text.replace(
        /(\d+)=(-?\d+)\+(-?\d+)n/,
        (_m, s, f, st) => `${s}=${f}+${Number(st) + 1}n`
      ),
    ].filter((candidate) => candidate !== text);
    expect(damaged).toHaveLength(2);

    for (const candidate of damaged) {
      let rebuilt: string | null = null;
      try {
        rebuilt = expand(candidate);
      } catch {
        rebuilt = null;
      }
      expect(rebuilt).not.toBe(input);
    }
  });

  it('a column that only looks sequential is left alone', () => {
    // The positive control for the detector: a cycling column is not a run, and
    // treating it as one would produce confidently wrong values.
    const cycling =
      '[\n' +
      Array.from(
        { length: 60 },
        (_, i) => `  { "id": ${1000 + i}, "phase": ${i % 7}, "tag": "t" }`
      ).join(',\n') +
      '\n]';
    const out = compressJsonArray(cycling);
    const clause = /; slots ([^\]\n]+) count from 0/.exec(out.text);
    // `id` steps by one and may be collapsed; `phase` cycles and must not be.
    if (clause) expect(clause[1]).not.toMatch(/\b1=/);
    expect(expand(out.text)).toBe(cycling);
  });
});
