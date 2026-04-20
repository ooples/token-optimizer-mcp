import { describe, it, expect } from '@jest/globals';
import { calculateDelta, applyDelta } from '../../src/utils/diff.js';

describe('diff utils', () => {
  it('returns empty delta when inputs are identical', () => {
    expect(calculateDelta('hello', 'hello')).toBe('');
  });

  it('round-trips a simple change', () => {
    const prev = 'line1\nline2\nline3\n';
    const next = 'line1\nline2 changed\nline3\n';
    const delta = calculateDelta(prev, next);
    expect(delta).not.toBe('');
    expect(applyDelta(prev, delta)).toBe(next);
  });

  it('applyDelta on an empty delta is a no-op', () => {
    expect(applyDelta('anything', '')).toBe('anything');
  });

  it('produces a meaningfully smaller delta than the full content for small edits', () => {
    const prev = 'a\n'.repeat(500);
    const next = prev + 'appended line\n';
    const delta = calculateDelta(prev, next);
    expect(delta.length).toBeLessThan(next.length);
  });

  it('throws when the patch targets a different baseline than supplied', () => {
    const patch = calculateDelta('original\ntext\n', 'original\nchanged\n');
    // Applying the patch against completely different content fails.
    expect(() => applyDelta('totally different input\n', patch)).toThrow();
  });
});
