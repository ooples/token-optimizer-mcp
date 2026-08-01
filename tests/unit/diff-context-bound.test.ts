import { describe, it, expect } from '@jest/globals';
import { generateUnifiedDiff } from '../../src/tools/shared/diff-utils.js';

/**
 * Bounded context is the whole difference between a diff and a copy.
 *
 * `lines.slice(-context)` looks like "the last N" and is not: at context 0,
 * `-0 === 0`, so it becomes `slice(0)` -- the ENTIRE unchanged run. Asking for
 * no context therefore emitted every unchanged line, immediately after a marker
 * announcing they had been elided. Larger than the unabridged diff, and untrue
 * about its own contents.
 *
 * The 200-line run below is what makes it visible: the bug scales with the
 * unchanged span, so a small fixture would have hidden it.
 */

const UNCHANGED = Array.from({ length: 200 }, (_, i) => `line ${i}`);
const BEFORE = [...UNCHANGED, 'OLD'].join('\n');
const AFTER = [...UNCHANGED, 'NEW'].join('\n');

const diff = (context: number): string[] =>
  generateUnifiedDiff(BEFORE, AFTER, 'a.txt', 'b.txt', context).split('\n');

describe('unified diff context bounding', () => {
  it('emits no context lines at all when asked for none', () => {
    const lines = diff(0);
    // Header (2), hunk header, elision marker, and the two changed lines.
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => l.startsWith(' '))).toHaveLength(0);
  });

  it('does not grow as context shrinks', () => {
    // The regression's signature: context 0 was BIGGER than context 3.
    expect(diff(0).length).toBeLessThanOrEqual(diff(1).length);
    expect(diff(1).length).toBeLessThanOrEqual(diff(3).length);
  });

  it('keeps exactly the requested number of lines on each side', () => {
    for (const context of [1, 2, 3, 5]) {
      const kept = diff(context).filter((l) => l.startsWith(' '));
      expect(kept).toHaveLength(context * 2);
    }
  });

  it('states honestly how many lines it dropped', () => {
    // The marker is a claim about the output. It has to match the output.
    for (const context of [0, 1, 3, 5]) {
      const lines = diff(context);
      const marker = lines.find((l) => /unchanged lines @@$/.test(l))!;
      expect(marker).toBeDefined();
      const claimed = Number(marker.match(/@@ (\d+) unchanged/)![1]);
      const kept = lines.filter((l) => l.startsWith(' ')).length;
      expect(claimed + kept).toBe(UNCHANGED.length);
    }
  });

  it('always names the change itself', () => {
    for (const context of [0, 1, 3]) {
      const text = diff(context).join('\n');
      expect(text).toContain('-OLD');
      expect(text).toContain('+NEW');
    }
  });

  it('leaves a short unchanged run alone rather than eliding it', () => {
    const short = ['a', 'b', 'c'];
    const lines = generateUnifiedDiff(
      [...short, 'OLD'].join('\n'),
      [...short, 'NEW'].join('\n'),
      'a.txt',
      'b.txt',
      3
    ).split('\n');
    // Nothing to gain by eliding 3 lines to keep 6 of context.
    expect(lines.some((l) => l.includes('unchanged lines @@'))).toBe(false);
    expect(lines.filter((l) => l.startsWith(' '))).toHaveLength(short.length);
  });
});
