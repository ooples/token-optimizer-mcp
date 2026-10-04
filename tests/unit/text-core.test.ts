import { describe, it, expect } from '@jest/globals';

import {
  STOP_WORD_COUNT,
  TEXTRANK_DAMPING,
  categorize,
  compareTermShares,
  inverseDocumentFrequency,
  isStopWord,
  jaccard,
  keyTerms,
  splitSentences,
  summarize,
  termFrequencies,
  textRank,
  tokenize,
} from '../../src/tools/intelligence/text-core.js';

/**
 * Known-answer tests for the text core.
 *
 * The property that matters most here is that summarisation is EXTRACTIVE.
 * The tools using this file have no language model, so a summary that
 * contained a sentence the caller did not write would be generated text
 * presented as theirs -- the same class of defect as the fabricated
 * confidence these tools used to return. Several cases below assert that
 * every returned sentence is a substring of the input.
 */
describe('text core: tokenising', () => {
  it('lowercases, drops stop words and keeps technical terms whole', () => {
    expect(tokenize('The cache_hit rate for smart-read was 97%')).toEqual([
      'cache_hit',
      'rate',
      'smart-read',
      '97',
    ]);
  });

  it('drops single characters, which carry no term signal', () => {
    expect(tokenize('a b cd e fg')).toEqual(['cd', 'fg']);
  });

  it('keeps a word a longer stop list would have eaten', () => {
    // `error`, `cache` and `timeout` are the signal in the text these tools
    // are given. A stop list that removed them would make every result empty.
    for (const term of ['error', 'cache', 'timeout', 'failure'])
      expect(isStopWord(term)).toBe(false);
  });

  it('has a short, pinned stop list rather than an open-ended one', () => {
    expect(STOP_WORD_COUNT).toBe(77);
    expect(isStopWord('The')).toBe(true);
  });

  it('refuses a non-string instead of coercing it', () => {
    expect(() => tokenize(42 as unknown as string)).toThrow('needs a string');
  });
});

describe('text core: sentences', () => {
  it('splits on terminators followed by space', () => {
    expect(splitSentences('One. Two! Three? Four')).toEqual([
      'One.',
      'Two!',
      'Three?',
      'Four',
    ]);
  });

  it('treats newlines as boundaries, so log lines are separate sentences', () => {
    expect(splitSentences('cache miss\ncache hit\ntimeout')).toEqual([
      'cache miss',
      'cache hit',
      'timeout',
    ]);
  });

  it('returns nothing for empty or blank text', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

describe('text core: term weighting', () => {
  it('counts terms', () => {
    expect([...termFrequencies(['a', 'b', 'a']).entries()]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('weights a term in every document above zero, not at zero', () => {
    // ln(1 + 3/3) = ln 2. The unsmoothed ln(N/df) would be exactly 0 here,
    // and with a single document it zeroes EVERY term, so keyword extraction
    // would return a list of zeros rather than a ranking.
    const idf = inverseDocumentFrequency([['x'], ['x'], ['x']]);
    expect(idf.get('x')).toBeCloseTo(Math.log(2), 15);
  });

  it('weights a rare term above a common one', () => {
    const idf = inverseDocumentFrequency([
      ['common', 'rare'],
      ['common'],
      ['common'],
    ]);
    expect(idf.get('rare')).toBeGreaterThan(idf.get('common') ?? 0);
    expect(idf.get('rare')).toBeCloseTo(Math.log(1 + 3 / 1), 15);
  });

  it('weighs frequency against rarity, and says which won', () => {
    const corpus = [
      tokenize('cache cache cache timeout'),
      tokenize('cache cache'),
      tokenize('cache'),
    ];
    const ranked = keyTerms(corpus[0], corpus, 2);
    // tf-idf is the PRODUCT, so three occurrences at ln(2) beat one at
    // ln(4): 0.75*0.693 = 0.520 against 0.25*1.386 = 0.347. Pinning both
    // figures is the point -- a ranking that put the rarer term first would
    // mean idf alone was being reported under the name tf-idf.
    expect(ranked[0].term).toBe('cache');
    expect(ranked[0].score).toBeCloseTo(0.75 * Math.log(2), 12);
    expect(ranked[1].term).toBe('timeout');
    expect(ranked[1].score).toBeCloseTo(0.25 * Math.log(4), 12);
  });

  it('lets rarity decide once frequency is equal', () => {
    const corpus = [
      tokenize('cache timeout'),
      tokenize('cache'),
      tokenize('cache'),
    ];
    const ranked = keyTerms(corpus[0], corpus, 2);
    expect(ranked[0].term).toBe('timeout');
    expect(ranked[0].count).toBe(1);
    expect(ranked[0].score).toBeCloseTo(0.5 * Math.log(4), 12);
    expect(ranked[1].term).toBe('cache');
  });

  it('falls back to a frequency ranking for a single document, honestly', () => {
    const only = tokenize('retry retry retry timeout');
    const ranked = keyTerms(only, [], 2);
    expect(ranked[0].term).toBe('retry');
    expect(ranked[0].count).toBe(3);
  });

  it('refuses a limit below one', () => {
    expect(() => keyTerms(['a'], [], 0)).toThrow('limit of at least 1');
  });
});

describe('text core: similarity', () => {
  it('computes the Jaccard index', () => {
    // {a,b,c} vs {b,c,d}: 2 shared, 4 distinct.
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5, 15);
    expect(jaccard(['a'], ['a'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });

  it('calls two empty token sets identical rather than NaN', () => {
    expect(jaccard([], [])).toBe(1);
  });
});

describe('text core: textrank', () => {
  it('uses the published damping factor', () => {
    expect(TEXTRANK_DAMPING).toBe(0.85);
  });

  it('scores a symmetric pair equally', () => {
    const scores = textRank([
      [0, 1],
      [1, 0],
    ]);
    expect(scores[0]).toBeCloseTo(scores[1], 12);
  });

  it('ranks the node every other node points at highest', () => {
    // A star: node 0 is similar to 1, 2 and 3, which are similar to nothing
    // else. Node 0 must come out on top.
    const scores = textRank([
      [0, 1, 1, 1],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
    expect(scores[0]).toBeGreaterThan(scores[3]);
  });

  it('leaves an isolated graph uniform instead of decaying it to zero', () => {
    const scores = textRank([
      [0, 0],
      [0, 0],
    ]);
    expect(scores[0]).toBeCloseTo(scores[1], 12);
    expect(scores[0]).toBeGreaterThan(0);
  });

  it('handles the single-node and empty cases', () => {
    expect(textRank([[0]])).toHaveLength(1);
    expect(textRank([])).toEqual([]);
  });

  it('refuses a non-square matrix instead of reading past a row', () => {
    expect(() => textRank([[0, 1], [1]])).toThrow('square matrix');
  });
});

describe('text core: summarising', () => {
  const ARTICLE = [
    'The cache engine stores compressed blocks on disk.',
    'Compressed blocks are keyed by a content hash.',
    'A content hash makes the cache engine idempotent.',
    'Unrelated: the weather today is cold.',
  ].join(' ');

  it('returns only sentences the caller wrote', () => {
    const selected = summarize(ARTICLE, 2);
    expect(selected).toHaveLength(2);
    for (const entry of selected) expect(ARTICLE).toContain(entry.sentence);
  });

  it('returns them in original order, not in rank order', () => {
    const selected = summarize(ARTICLE, 3);
    const indices = selected.map((entry) => entry.index);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it('prefers the sentences that share terms with the rest', () => {
    const all = summarize(ARTICLE, 4);
    expect(all).toHaveLength(4);
    const unrelated = all.find((entry) => entry.sentence.includes('weather'));
    const related = all.filter((entry) => !entry.sentence.includes('weather'));
    expect(related).toHaveLength(3);
    /*
     * The unrelated sentence shares no term with any other, so it receives
     * nothing through the graph and its score is exactly the damping floor,
     * 1 - 0.85. That is an exact figure the algorithm fixes, not a threshold
     * picked to make the test pass, and every sentence that does share terms
     * must score above it.
     */
    expect(unrelated?.score).toBeCloseTo(1 - TEXTRANK_DAMPING, 12);
    for (const entry of related)
      expect(entry.score).toBeGreaterThan(1 - TEXTRANK_DAMPING);
    // So asking for two cannot select it.
    expect(
      summarize(ARTICLE, 2).map((entry) => entry.sentence.includes('weather'))
    ).toEqual([false, false]);
  });

  it('never returns more sentences than the text has', () => {
    expect(summarize('Only one sentence here.', 5)).toHaveLength(1);
  });

  it('returns nothing for empty text rather than an invented summary', () => {
    expect(summarize('', 3)).toEqual([]);
  });

  it('refuses a sentence count below one', () => {
    expect(() => summarize(ARTICLE, 0)).toThrow('sentence count of at least 1');
  });
});

describe('text core: categorising', () => {
  const CATEGORIES = [
    { name: 'cache', terms: ['cache', 'hit', 'miss'] },
    { name: 'network', terms: ['timeout', 'socket'] },
  ];

  it('scores by whole-token match and ranks the categories', () => {
    const scored = categorize('cache miss then cache hit', CATEGORIES);
    expect(scored[0].name).toBe('cache');
    expect(scored[0].matched.map((entry) => entry.term)).toEqual([
      'cache',
      'hit',
      'miss',
    ]);
    expect(scored[0].score).toBe(1);
    expect(scored[1].name).toBe('network');
    expect(scored[1].score).toBe(0);
  });

  it('does not match a term inside a longer word', () => {
    // `error` must not be found in `terrorise`, which is what substring
    // matching would do and what makes a classification unaccountable.
    const scored = categorize('terrorise', [
      { name: 'fault', terms: ['error'] },
    ]);
    expect(scored[0].score).toBe(0);
    expect(scored[0].matched).toEqual([]);
  });

  it('scores empty text as zero rather than dividing by zero', () => {
    expect(categorize('', CATEGORIES)[0].score).toBe(0);
  });

  it('refuses to classify without categories instead of guessing a taxonomy', () => {
    expect(() => categorize('anything', [])).toThrow('at least one category');
  });
});

describe('text core: comparing periods', () => {
  it('compares shares, not counts, so period length does not decide', () => {
    const shifts = compareTermShares(
      'timeout timeout retry',
      'retry retry retry retry retry retry',
      5
    );
    const timeout = shifts.find((entry) => entry.term === 'timeout');
    const retry = shifts.find((entry) => entry.term === 'retry');
    expect(timeout?.beforeShare).toBeCloseTo(2 / 3, 12);
    expect(timeout?.afterShare).toBe(0);
    expect(timeout?.delta).toBeCloseTo(-2 / 3, 12);
    expect(retry?.delta).toBeCloseTo(1 - 1 / 3, 12);
  });

  it('ranks by the size of the move, in either direction', () => {
    const shifts = compareTermShares('gone gone gone', 'arrived', 2);
    expect(Math.abs(shifts[0].delta)).toBeGreaterThanOrEqual(
      Math.abs(shifts[1].delta)
    );
  });

  it('handles an empty period on either side', () => {
    expect(compareTermShares('', 'arrived', 1)[0]).toMatchObject({
      term: 'arrived',
      beforeShare: 0,
      afterShare: 1,
    });
    expect(compareTermShares('gone', '', 1)[0]).toMatchObject({
      term: 'gone',
      afterShare: 0,
    });
  });

  it('refuses a limit below one', () => {
    expect(() => compareTermShares('a', 'b', 0)).toThrow('limit of at least 1');
  });
});
