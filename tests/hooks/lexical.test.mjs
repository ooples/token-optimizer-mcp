import { describe, it, expect } from '@jest/globals';
import { tokenize, rank } from '../../hooks-core/lexical.mjs';

// Ordered so the correct BM25 winner ("a") is NOT first in input order --
// it is listed last. This defeats two confounds a k1 sweep cannot catch,
// because neither varies with k1:
//   (1) a naive occurrence-count scorer: "retry" appears in "b" three times
//       and in "a" once, so counting matches (with no idf, no saturation)
//       ranks "b" first;
//   (2) a substring/includes() filter that matches without ranking and
//       returns hits in original array order: since "b" precedes "a" here,
//       a no-sort passthrough also surfaces "b" first.
// Only real BM25 -- which rewards "a" for matching a SECOND distinct term
// ("backoff") and saturates "b"s triple repeat of one term -- returns "a"
// first. See the per-test discrimination notes below and the fix report.
const FINDINGS = [
  { key: 'c', claim: 'the parser rejects a trailing comma' },
  { key: 'b', claim: 'retry retry retry' },
  { key: 'a', claim: 'the retry backoff is capped at thirty seconds' },
];

// A second fixture where correct ranking requires reordering ALL THREE
// matches relative to their input order, not just swapping two. Input
// order is [short, padded, target]; the correct answer ("target", which
// matches every query term once) is listed LAST, and the worst-by-real-BM25
// match that still exists ("padded", a single term repeated eight times) is
// listed BEFORE it.
const REORDER_FINDINGS = [
  { key: 'short', claim: 'timeout' },
  { key: 'padded', claim: 'timeout timeout timeout timeout timeout timeout timeout timeout' },
  { key: 'target', claim: 'the connection timeout and retry policy are both configurable' },
];

describe('lexical', () => {
  describe('tokenize', () => {
    it('splits on non-word characters and lowercases', () => {
      expect(tokenize('Retry-Backoff, capped!')).toEqual(['retry', 'backoff', 'capped']);
    });

    it('keeps the whole token and adds camelCase parts for a concatenated flag', () => {
      // --skipLibCheck has no delimiter between "skip", "Lib" and "Check" --
      // that concatenation is the silent recall gap this covers. The "--" is
      // stripped as a non-word boundary same as before; the remaining run is
      // kept whole (so a query for the concatenated form still matches) AND
      // split into parts (so a query for the separated form matches too).
      expect(tokenize('--skipLibCheck')).toEqual(['skiplibcheck', 'skip', 'lib', 'check']);
    });

    it('keeps the whole token and adds letter/digit parts for an error code', () => {
      expect(tokenize('TS2345')).toEqual(['ts2345', 'ts', '2345']);
    });

    it('splits a camelCase identifier into parts without dropping the whole token', () => {
      expect(tokenize('handleRequestTimeout')).toEqual([
        'handlerequesttimeout',
        'handle',
        'request',
        'timeout',
      ]);
    });

    it('does not duplicate a token that has no internal camelCase or digit boundary', () => {
      // A single already-delimited word (no case or letter/digit transition
      // inside it) must appear exactly once, not once as the "whole token"
      // and again as its only "part".
      expect(tokenize('retry')).toEqual(['retry']);
    });
  });

  describe('rank', () => {
    it('ranks a specific match above a repetitive one -- and would not under either confound this replaces', () => {
      // This is the whole reason BM25 replaces substring matching: "b"
      // contains the term more often, "a" is the better answer. Saturation
      // must win. Discrimination, given FINDINGS above lists "a" last:
      //   (a) naive count-sort (raw term occurrences, sorted desc): "b" has
      //       count 3 ("retry" x3), "a" has count 2 ("retry" + "backoff") --
      //       returns ["b", "a"]. This test's expectation of ["a", "b"]
      //       FAILS under it.
      //   (b) no-sort passthrough (matches kept, original array order):
      //       "b" precedes "a" in FINDINGS -- returns ["b", "a"]. FAILS.
      // Real BM25 returns ["a", "b"]: PASSES.
      const ranked = rank('retry backoff', FINDINGS);
      expect(ranked.map((r) => r.finding.key)).toEqual(['a', 'b']);
    });

    it('omits findings with no matching term rather than scoring them zero', () => {
      // Discrimination: (a) naive count-sort and (b) no-sort passthrough
      // both also omit a total non-match, so this assertion alone does not
      // discriminate against either confound -- it is a correctness check,
      // not a ranking one. The preceding and following tests carry that.
      const keys = rank('retry backoff', FINDINGS).map((r) => r.finding.key);
      expect(keys).not.toContain('c');
    });

    it('reorders all three matches relative to their input order when ranking requires it', () => {
      // Input order is [short, padded, target]. Discrimination:
      //   (a) naive count-sort: "padded" has the highest raw term count
      //       ("timeout" x8), so it sorts first -- returns
      //       ["padded", "target", "short"]. FAILS (expected "target" first).
      //   (b) no-sort passthrough: all three match at least one term, so
      //       nothing is filtered out and input order passes through
      //       unchanged -- returns ["short", "padded", "target"], the exact
      //       reverse of correct. FAILS.
      // Real BM25 rewards "target" for matching all three distinct terms
      // once each and saturates "padded"s eightfold repeat of a single
      // term: returns ["target", "padded", "short"]. PASSES.
      const ranked = rank('timeout retry policy', REORDER_FINDINGS);
      expect(ranked.map((r) => r.finding.key)).toEqual(['target', 'padded', 'short']);
    });

    it('keeps the correctly-ranked top results under a limit, not just the first K by input order', () => {
      // Same fixture and discrimination as above, truncated to limit: 2.
      //   (a) naive count-sort top 2: ["padded", "target"]. FAILS.
      //   (b) no-sort passthrough top 2: ["short", "padded"]. FAILS.
      // Real BM25 top 2: ["target", "padded"]. PASSES.
      const ranked = rank('timeout retry policy', REORDER_FINDINGS, { limit: 2 });
      expect(ranked.map((r) => r.finding.key)).toEqual(['target', 'padded']);
    });

    it('respects limit', () => {
      expect(rank('retry', FINDINGS, { limit: 1 })).toHaveLength(1);
    });

    it('returns nothing for an empty query rather than everything', () => {
      expect(rank('   ', FINDINGS)).toEqual([]);
    });

    it('finds a concatenated flag by its whole run-together form and by its split camelCase words', () => {
      const findings = [
        { key: 'ci', claim: 'CI fails because tsc reports skipLibCheck is required for the build to pass' },
        { key: 'unrelated', claim: 'the retry backoff is capped at thirty seconds' },
      ];
      expect(rank('skiplibcheck', findings).map((r) => r.finding.key)).toEqual(['ci']);
      expect(rank('skip lib check', findings).map((r) => r.finding.key)).toEqual(['ci']);
    });

    it('finds an error code by its whole run-together form and by its split letter/digit parts', () => {
      const findings = [
        { key: 'err', claim: 'the build fails with TS2345 because the argument type is wrong' },
        { key: 'unrelated', claim: 'the retry backoff is capped at thirty seconds' },
      ];
      expect(rank('ts2345', findings).map((r) => r.finding.key)).toEqual(['err']);
      expect(rank('ts 2345', findings).map((r) => r.finding.key)).toEqual(['err']);
    });

    it('finds a camelCase identifier by its whole run-together form and by its split words', () => {
      const findings = [
        { key: 'handler', claim: 'handleRequestTimeout retries after the socket closes early' },
        { key: 'unrelated', claim: 'the retry backoff is capped at thirty seconds' },
      ];
      expect(rank('handlerequesttimeout', findings).map((r) => r.finding.key)).toEqual(['handler']);
      expect(rank('handle request timeout', findings).map((r) => r.finding.key)).toEqual(['handler']);
    });

    describe('prefix matching (fragment recall)', () => {
      // The exact demonstrated regression: `.includes('custom')` used to
      // match a claim containing "customer"; pure token-exact BM25 does
      // not, because "custom" and "customer" are different tokens and share
      // no camelCase/letter-digit sub-token either. This is the case fixed.
      it('finds a claim containing a longer word starting with the query term', () => {
        const findings = [
          { key: 'target', claim: 'customer data leak in the export pipeline' },
          { key: 'unrelated', claim: 'the retry backoff is capped at thirty seconds' },
        ];
        expect(rank('custom', findings).map((r) => r.finding.key)).toEqual(['target']);
      });

      it('never lets a prefix-only match outscore an exact match of the same term, no matter how many prefix hits exist', () => {
        // "exact" has one real occurrence of "custom". "prefix-only" has
        // five occurrences of "customer" and none of "custom" itself -- if
        // prefix credit scaled with count instead of being a flat, sub-one
        // credit, five prefix hits could outweigh one real hit. It must not:
        // "exact" ranks first.
        const findings = [
          { key: 'prefix-only', claim: 'customer customer customer customer customer' },
          { key: 'exact', claim: 'custom configuration is required' },
        ];
        const ranked = rank('custom', findings);
        expect(ranked.map((r) => r.finding.key)).toEqual(['exact', 'prefix-only']);
      });

      it('does not prefix-match a query term shorter than three characters', () => {
        // "cu" is a real prefix of "customer" too, but a two-character
        // fragment is a substring of most vocabularies -- eligible terms
        // start at three characters.
        const findings = [{ key: 'target', claim: 'customer data leak' }];
        expect(rank('cu', findings)).toEqual([]);
      });

      it('composes with sub-token emission: a fragment of the whole run-together identifier still prefix-matches', () => {
        // "skipl" is not one of the emitted sub-tokens ("skiplibcheck",
        // "skip", "lib", "check") for skipLibCheck, but it IS a prefix of
        // the whole run-together token "skiplibcheck" that tokenize()
        // always keeps alongside the split parts.
        const findings = [
          { key: 'ci', claim: 'CI fails because tsc reports skipLibCheck is required for the build to pass' },
          { key: 'unrelated', claim: 'the retry backoff is capped at thirty seconds' },
        ];
        expect(rank('skipl', findings).map((r) => r.finding.key)).toEqual(['ci']);
      });
    });
  });
});
