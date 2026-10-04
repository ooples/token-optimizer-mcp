/**
 * The text core the language-facing intelligence tools compute with.
 *
 * Companion to analytics-core.ts, and it exists for the same reason: the six
 * tools being implemented published 48 operations and computed nothing, so
 * every string they now return has to come from the caller's own text by a
 * named method. Summarisation here is EXTRACTIVE -- it selects sentences the
 * caller wrote and never generates prose -- because this package has no
 * language model and inventing a sentence would be the same defect in a new
 * costume.
 *
 * Line-level change detection is not reimplemented here: generateDiff and
 * calculateSimilarity in ../shared/diff-utils.js already do it, and the
 * tools call those.
 */

/**
 * Words carrying no topical signal, so they are dropped before any term is
 * counted. Deliberately short and English-only: a long list silently removes
 * domain terms, and the tools that use this are given technical text where
 * `error`, `cache` and `timeout` are the signal. Anything not here is kept.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'more',
  'most',
  'no',
  'not',
  'of',
  'on',
  'one',
  'or',
  'other',
  'our',
  'out',
  'over',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'up',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** Is this token a stop word? Exposed so a caller can see the rule. */
export const isStopWord = (token: string): boolean =>
  STOP_WORDS.has(token.toLowerCase());

/** How many stop words the list holds, so a test can pin the rule's size. */
export const STOP_WORD_COUNT = STOP_WORDS.size;

/**
 * Word tokens, lowercased, stop words and single characters dropped.
 * Underscores and hyphens are kept inside a token, because the text these
 * tools are given is full of `cache_hit` and `smart-read` and splitting
 * those destroys the term.
 */
export const tokenize = (text: string): string[] => {
  if (typeof text !== 'string') throw new Error('tokenize needs a string');
  const matched = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  return matched.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
};

/**
 * Sentences, by terminator followed by whitespace, with newline-separated
 * lines treated as boundaries too -- log lines and bullet lists carry no
 * full stops, and treating a whole log as one sentence makes every
 * summarisation result the input.
 */
export const splitSentences = (text: string): string[] => {
  if (typeof text !== 'string')
    throw new Error('splitSentences needs a string');
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
};

/** Term counts for one document. */
export const termFrequencies = (
  tokens: readonly string[]
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
};

/**
 * Inverse document frequency, smoothed as ln(1 + N/df) so that a term
 * appearing in every document gets a small positive weight rather than
 * exactly zero -- with a single document, the unsmoothed form zeroes every
 * term and keyword extraction returns nothing.
 */
export const inverseDocumentFrequency = (
  documents: ReadonlyArray<readonly string[]>
): Map<string, number> => {
  const total = documents.length;
  if (total === 0) return new Map();
  const appearances = new Map<string, number>();
  for (const document of documents)
    for (const token of new Set(document))
      appearances.set(token, (appearances.get(token) ?? 0) + 1);
  const weights = new Map<string, number>();
  for (const [token, count] of appearances)
    weights.set(token, Math.log(1 + total / count));
  return weights;
};

/** One scored term. */
export interface ScoredTerm {
  term: string;
  score: number;
  /** Raw count in the document the score was computed for. */
  count: number;
}

/**
 * The highest tf-idf terms of one document against a corpus. When the corpus
 * is just that document, the smoothed idf above makes this a frequency
 * ranking, which is the honest answer: one document carries no information
 * about what is distinctive.
 */
export const keyTerms = (
  document: readonly string[],
  corpus: ReadonlyArray<readonly string[]>,
  limit: number
): ScoredTerm[] => {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(
      `keyTerms needs a limit of at least 1; received ${String(limit)}`
    );
  const counts = termFrequencies(document);
  const idf = inverseDocumentFrequency(corpus.length > 0 ? corpus : [document]);
  const scored: ScoredTerm[] = [];
  for (const [term, count] of counts)
    scored.push({
      term,
      count,
      score: (count / document.length) * (idf.get(term) ?? 0),
    });
  return scored
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, limit);
};

/** Jaccard index: shared terms over total distinct terms. */
export const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
};

/** TextRank's damping factor, as published in Mihalcea & Tarau (2004). */
export const TEXTRANK_DAMPING = 0.85;

/** Iteration ceiling and convergence threshold for the power iteration. */
export const TEXTRANK_MAX_ITERATIONS = 100;
export const TEXTRANK_TOLERANCE = 1e-6;

/**
 * TextRank over a weighted undirected similarity graph, by power iteration.
 * Returns one score per node, summing to the node count, in input order.
 *
 * A node with no similar neighbour keeps the uniform score rather than
 * decaying to zero, so an unrelated sentence can still be selected when
 * nothing else is available -- which is what should happen to a one-sentence
 * input.
 */
export const textRank = (
  similarity: ReadonlyArray<readonly number[]>
): number[] => {
  const n = similarity.length;
  if (n === 0) return [];
  for (const row of similarity)
    if (row.length !== n)
      throw new Error(
        `textRank needs a square matrix; received a row of ${row.length} in a ${n}-node graph`
      );
  const outWeight = similarity.map((row, index) =>
    row.reduce(
      (total, value, other) => (other === index ? total : total + value),
      0
    )
  );
  let scores = new Array<number>(n).fill(1);
  for (let iteration = 0; iteration < TEXTRANK_MAX_ITERATIONS; iteration += 1) {
    const next = new Array<number>(n).fill(1 - TEXTRANK_DAMPING);
    for (let node = 0; node < n; node += 1) {
      for (let other = 0; other < n; other += 1) {
        if (other === node) continue;
        if (outWeight[other] === 0) continue;
        next[node] +=
          TEXTRANK_DAMPING *
          (similarity[other][node] / outWeight[other]) *
          scores[other];
      }
    }
    let drift = 0;
    for (let node = 0; node < n; node += 1)
      drift += Math.abs(next[node] - scores[node]);
    scores = next;
    if (drift < TEXTRANK_TOLERANCE) break;
  }
  return scores;
};

/** One sentence selected for a summary. */
export interface SelectedSentence {
  /** Index in the original sentence order. */
  index: number;
  sentence: string;
  score: number;
}

/**
 * Extractive summary: the highest-TextRank sentences, returned IN ORIGINAL
 * ORDER so the result reads as the caller's own text rather than as a ranked
 * list. Nothing is generated or paraphrased.
 */
export const summarize = (
  text: string,
  sentenceCount: number
): SelectedSentence[] => {
  if (!Number.isInteger(sentenceCount) || sentenceCount < 1)
    throw new Error(
      `summarize needs a sentence count of at least 1; received ${String(sentenceCount)}`
    );
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const tokenSets = sentences.map((sentence) => tokenize(sentence));
  const similarity = tokenSets.map((left, index) =>
    tokenSets.map((right, other) =>
      index === other ? 0 : jaccard(left, right)
    )
  );
  const scores = textRank(similarity);
  return sentences
    .map((sentence, index) => ({ index, sentence, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, sentenceCount)
    .sort((a, b) => a.index - b.index);
};

/** A category and the terms that evidence it. */
export interface Category {
  name: string;
  /** Lowercased terms; a match is on a whole token, never a substring. */
  terms: readonly string[];
}

/** How strongly a document matched one category. */
export interface CategoryScore {
  name: string;
  /** Matching tokens divided by the document's token count. */
  score: number;
  /** The category terms actually found, with their counts. */
  matched: Array<{ term: string; count: number }>;
}

/**
 * Score a document against caller-supplied categories by whole-token match.
 * Substring matching is deliberately not used: it makes `error` match
 * `terrorise` and produces a category assignment nobody can account for.
 *
 * Categories are the CALLER's, because a fixed internal taxonomy would be a
 * guess about their domain -- the same guess the stub tools were making when
 * they answered every classification with success.
 */
export const categorize = (
  text: string,
  categories: readonly Category[]
): CategoryScore[] => {
  if (!Array.isArray(categories) || categories.length === 0)
    throw new Error(
      'categorize needs at least one category; there is no built-in taxonomy to fall back on'
    );
  const counts = termFrequencies(tokenize(text));
  let total = 0;
  for (const count of counts.values()) total += count;
  return categories
    .map((category) => {
      const matched: Array<{ term: string; count: number }> = [];
      let hits = 0;
      for (const term of category.terms) {
        const count = counts.get(term.toLowerCase()) ?? 0;
        if (count > 0) {
          matched.push({ term: term.toLowerCase(), count });
          hits += count;
        }
      }
      return {
        name: category.name,
        score: total === 0 ? 0 : hits / total,
        matched: matched.sort(
          (a, b) => b.count - a.count || a.term.localeCompare(b.term)
        ),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
};

/**
 * Terms whose share of the text rose or fell between two periods, by
 * difference in relative frequency. Relative and not absolute, because two
 * periods are rarely the same size and an absolute count would report the
 * longer one as the whole story.
 */
export interface TermShift {
  term: string;
  beforeShare: number;
  afterShare: number;
  /** afterShare - beforeShare; positive means it grew. */
  delta: number;
}

export const compareTermShares = (
  before: string,
  after: string,
  limit: number
): TermShift[] => {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(
      `compareTermShares needs a limit of at least 1; received ${String(limit)}`
    );
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  const beforeCounts = termFrequencies(beforeTokens);
  const afterCounts = termFrequencies(afterTokens);
  const shifts: TermShift[] = [];
  for (const term of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
    const beforeShare =
      beforeTokens.length === 0
        ? 0
        : (beforeCounts.get(term) ?? 0) / beforeTokens.length;
    const afterShare =
      afterTokens.length === 0
        ? 0
        : (afterCounts.get(term) ?? 0) / afterTokens.length;
    shifts.push({
      term,
      beforeShare,
      afterShare,
      delta: afterShare - beforeShare,
    });
  }
  return shifts
    .sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) || a.term.localeCompare(b.term)
    )
    .slice(0, limit);
};
