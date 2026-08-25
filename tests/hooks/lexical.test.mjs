import { describe, it, expect } from '@jest/globals';
import { tokenize, rank } from '../../hooks-core/lexical.mjs';

const FINDINGS = [
  { key: 'a', claim: 'the retry backoff is capped at thirty seconds' },
  { key: 'b', claim: 'retry retry retry' },
  { key: 'c', claim: 'the parser rejects a trailing comma' },
];

describe('lexical', () => {
  it('splits on non-word characters and lowercases', () => {
    expect(tokenize('Retry-Backoff, capped!')).toEqual(['retry', 'backoff', 'capped']);
  });

  it('ranks a specific match above a repetitive one', () => {
    // This is the whole reason BM25 replaces substring matching: 'b' contains
    // the term more often, 'a' is the better answer. Saturation must win.
    const ranked = rank('retry backoff', FINDINGS);
    expect(ranked[0].finding.key).toBe('a');
  });

  it('omits findings with no matching term rather than scoring them zero', () => {
    const keys = rank('retry backoff', FINDINGS).map((r) => r.finding.key);
    expect(keys).not.toContain('c');
  });

  it('respects limit', () => {
    expect(rank('retry', FINDINGS, { limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(rank('   ', FINDINGS)).toEqual([]);
  });
});
