/**
 * The safety case for compacting a run against its predecessor.
 *
 * The baseline these assertions compare against is NOT the command's full
 * output -- the model never sees that, because the bound already drops the
 * middle. It is what we ship today: a head, a tail, and nothing between.
 */

import { describe, it, expect } from '@jest/globals';
import { compact } from '../../hooks-core/compact.mjs';

const MAX = 400;

/**
 * A jest-shaped run: a wall of passes, some failures, then the summary.
 *
 * Deliberately several times the budget. A fixture smaller than `maxBytes` is
 * returned whole by every path, so it cannot tell the arms apart -- the first
 * version of these tests made exactly that mistake and two of them failed for
 * that reason rather than for anything about the code.
 */
const runOutput = ({ failing }) =>
  [
    ...Array.from({ length: 40 }, (_, i) => `PASS tests/suite-${i}.test.ts`),
    ...failing.map((name) => `  ● ${name} › does the thing\n    expected true, got false`),
    '',
    `Tests: ${failing.length} failed, 12 passed, ${12 + failing.length} total`,
    'Ran all test suites.',
  ].join('\n');

describe('compacting a run against its previous run', () => {
  it('is exactly the head-and-tail bound when there is no previous run', () => {
    const text = runOutput({ failing: ['alpha'] });

    expect(compact(text, { previous: '', maxBytes: MAX })).toBe(
      compact(text, { maxBytes: MAX })
    );
  });

  it('never returns more than the budget', () => {
    const text = 'x'.repeat(50_000);

    const out = compact(text, { previous: 'y'.repeat(50_000), maxBytes: MAX });

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX);
  });

  it('omits what the command repeated, and says how much', () => {
    const first = runOutput({ failing: ['alpha'] });
    const second = runOutput({ failing: ['beta'] });

    const out = compact(second, { previous: first, maxBytes: MAX });

    expect(out).toContain('repeated lines omitted');
    // The line that is new to this run survives.
    expect(out).toContain('beta');
    // A PASS line printed identically by both runs does not.
    expect(out).not.toContain('PASS tests/suite-0.test.ts');
  });

  describe('the ending is never touched, which is the whole safety argument', () => {
    it('keeps the summary when a test fails IDENTICALLY twice', () => {
      // THE CATASTROPHIC CASE for a naive dedup. The failure lines are
      // byte-identical across both runs, so a line filter would elide them and
      // the model would read the silence as "fixed". The summary lives in the
      // ending, which is off limits, so the run still says what it did.
      const identical = runOutput({ failing: ['alpha'] });

      const out = compact(identical, { previous: identical, maxBytes: MAX });

      expect(out).toContain('Tests: 1 failed');
      expect(out).toContain('Ran all test suites.');
    });

    it('reproduces the source ending byte for byte', () => {
      const text = runOutput({ failing: ['alpha', 'beta'] });

      const out = compact(text, { previous: text, maxBytes: MAX });

      // BYTES, not characters. The fixture contains multibyte glyphs, so
      // `slice(-200)` and "the last 200 bytes" are different strings -- the
      // first version of this assertion compared the two and failed for that
      // reason rather than for anything the code did.
      const source = Buffer.from(text, 'utf8');
      const ending = source
        .subarray(source.length - Math.floor(MAX / 2))
        .toString('utf8');

      expect(out.endsWith(ending)).toBe(true);
    });
  });

  it('shows more of what changed than the plain bound does', () => {
    // The point of the exercise: with the same budget, the head region carries
    // lines this run did not repeat instead of whatever came first.
    //
    // The new line has to sit in the MIDDLE for this to mean anything. Put it
    // near the end and the plain bound's tail shows it anyway, and the test
    // passes or fails for reasons that have nothing to do with compaction --
    // which is how the first version of this was wrong.
    const before = Array.from({ length: 60 }, (_, i) => `PASS tests/early-${i}.test.ts`);
    const after = Array.from({ length: 60 }, (_, i) => `PASS tests/late-${i}.test.ts`);

    const first = [...before, ...after, 'Tests: 0 failed'].join('\n');
    const second = [
      ...before,
      '  ● NEW FAILURE › regression',
      ...after,
      'Tests: 1 failed',
    ].join('\n');

    const bounded = compact(second, { maxBytes: MAX });
    const compacted = compact(second, { previous: first, maxBytes: MAX });

    expect(bounded).not.toContain('NEW FAILURE');
    expect(compacted).toContain('NEW FAILURE');
  });

  it('does not treat blank lines as seen, which would glue blocks together', () => {
    const first = 'a\n\nb';
    const second = 'c\n\nd';

    const out = compact(second, { previous: first, maxBytes: MAX });

    expect(out).toContain('c');
    expect(out).toContain('d');
  });
});
