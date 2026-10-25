/**
 * What the agent is actually asking about, and which lines answer it.
 *
 * THE HOLE THIS FILLS. Every engine here decides what to keep from the shape of
 * the content alone: head rows, anomalous rows, sentences that score well
 * positionally, function signatures over bodies. None of that knows what the
 * agent is DOING. Compressing a 900-line log the same way whether the question
 * is "why did the deploy fail" or "which worker handled request 4471" throws
 * away the answer half the time and keeps it by luck the other half.
 *
 * WHY BM25 AND NOT AN EMBEDDING MODEL, which is the whole competitive point.
 * Alternative A's relevance engine is ModernBERT: it needs a Python runtime, model
 * weights, and enough RAM to hold them, and their own docs record the result --
 * "incompatible with restricted sandboxes", a base-image RAM overhead, and
 * cross-agent memory that needs Docker. This is arithmetic over token counts.
 * It runs in the same process as the proxy, on any machine Node runs on, in
 * microseconds, and it is deterministic: the same block and the same question
 * always yield the same kept lines, so a benchmark number means something and a
 * regression is reproducible.
 *
 * THE SAME PRIMITIVE THE REST OF THE PACKAGE ALREADY USES. `hooks-core/
 * lexical.mjs` ranks wiki findings by BM25 with this tokenizer's semantics --
 * whole tokens plus their camelCase and letter-digit parts, so a query for
 * "skip lib check" finds `skipLibCheck`. It is reimplemented rather than
 * imported for two reasons, both structural: the engines are SYNCHRONOUS pure
 * functions and hooks-core is resolved by a path at call time behind an async
 * loader; and the scoring unit is different -- that module ranks whole findings
 * against a corpus, this ranks LINES INSIDE ONE BLOCK against each other.
 *
 * A FIXED BUDGET, NOT A BIGGER ONE. Relevance decides WHICH units survive, not
 * how many. Letting it keep extra would show up as better task outcomes and a
 * worse reduction number, which is the trade every competitor makes silently.
 * The one exception is bounded and stated where it happens.
 */

/** Terms shorter than this are dropped from a query: they match everything. */
const MIN_TERM = 2;

/**
 * Query terms that appear in nearly every unit carry no information, and IDF
 * alone does not discount them enough at this scale -- a block is tens of
 * lines, not a corpus of millions.
 */
const UBIQUITOUS_SHARE = 0.9;

const K1 = 1.2;
const B = 0.75;

/**
 * Splits an identifier's alphanumeric run into its parts, so a query written
 * with spaces matches a name written without them. Mirrors
 * `hooks-core/lexical.mjs#splitIdentifierParts`.
 */
function identifierParts(word: string): string[] {
  return word
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

/** Whole tokens, lowercased, plus the parts of any compound identifier. */
export function tokenize(text: string): string[] {
  const words = String(text ?? '').match(/[A-Za-z0-9]+/g) ?? [];
  const tokens: string[] = [];
  for (const word of words) {
    tokens.push(word.toLowerCase());
    const parts = identifierParts(word);
    if (parts.length > 1)
      for (const part of parts) tokens.push(part.toLowerCase());
  }
  return tokens;
}

export interface Ranker {
  /** False when there is no usable question, in which case scoring is free. */
  readonly active: boolean;
  /**
   * The indices of the highest-scoring units, at most `n` of them. Units that
   * score zero are never included: keeping an irrelevant line because the
   * budget allowed it is how a relevance filter turns into noise.
   */
  top(units: readonly string[], n: number): Set<number>;
  /** One unit's score against the question, for callers blending it in. */
  score(unit: string, corpus: readonly string[]): number;
}

const INACTIVE: Ranker = {
  active: false,
  top: () => new Set<number>(),
  score: () => 0,
};

/**
 * Builds a ranker for one question.
 *
 * `query` is whatever the caller can honestly say the agent is asking -- the
 * instruction text of the most recent turn, typically. An empty or
 * all-stopword question yields an inactive ranker rather than a ranker that
 * matches everything, because "no information" and "everything is relevant"
 * must not be the same answer.
 */
export function ranker(query: string | undefined): Ranker {
  const terms = [...new Set(tokenize(query ?? ''))].filter(
    (t) => t.length > MIN_TERM
  );
  if (!terms.length) return INACTIVE;

  /** BM25 over the units of one block, with the block as the whole corpus. */
  function scoreAll(units: readonly string[]): number[] {
    const tokenized = units.map((u) => tokenize(u));
    const lengths = tokenized.map((t) => t.length);
    const avgLength =
      lengths.reduce((n, l) => n + l, 0) / Math.max(1, lengths.length);

    const counts = tokenized.map((tokens) => {
      const map = new Map<string, number>();
      for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
      return map;
    });

    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      let n = 0;
      for (const map of counts) if (map.has(term)) n += 1;
      documentFrequency.set(term, n);
    }

    const total = units.length;
    return units.map((_unit, i) => {
      const map = counts[i];
      const length = lengths[i];
      let sum = 0;
      for (const term of terms) {
        const df = documentFrequency.get(term) ?? 0;
        // A term in almost every unit cannot discriminate between them.
        if (!df || df / total >= UBIQUITOUS_SHARE) continue;
        const tf = map.get(term) ?? 0;
        if (!tf) continue;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = K1 * (1 - B + (B * length) / Math.max(1, avgLength));
        sum += (idf * (tf * (K1 + 1))) / (tf + norm);
      }
      return sum;
    });
  }

  return {
    active: true,
    top(units, n) {
      if (n <= 0 || !units.length) return new Set<number>();
      const scores = scoreAll(units);
      const ordered = scores
        .map((value, index) => ({ value, index }))
        // Ties break on position, so the answer is stable and reproducible.
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value || a.index - b.index)
        .slice(0, n)
        .map((s) => s.index);
      return new Set(ordered);
    },
    score(unit, corpus) {
      const units = corpus.includes(unit) ? corpus : [...corpus, unit];
      const scores = scoreAll(units);
      return scores[units.indexOf(unit)] ?? 0;
    },
  };
}

/**
 * The question, taken from the request itself.
 *
 * WHAT COUNTS AS THE QUESTION, and why it is not simply "the last message". The
 * last message in an agentic conversation is usually a tool RESULT -- tens of
 * kilobytes of the very content being compressed. Tokenising that as the query
 * would make every block maximally relevant to itself, which is worse than
 * having no query at all: it would look like it was working.
 *
 * So only SHORT text blocks count. An instruction is short; a payload is not.
 * The threshold is generous enough to catch a paragraph of direction and far
 * below anything a tool returns.
 */
const MAX_QUERY_BLOCK = 2000;

/** How many recent short blocks are read back as the question. */
const QUERY_BLOCKS = 4;

export function queryFrom(
  blocks: readonly { readonly text: string; readonly role?: string }[]
): string {
  const short: string[] = [];
  for (
    let i = blocks.length - 1;
    i >= 0 && short.length < QUERY_BLOCKS;
    i -= 1
  ) {
    const text = blocks[i]?.text ?? '';
    if (text.length > 0 && text.length <= MAX_QUERY_BLOCK) short.push(text);
  }
  return short.reverse().join('\n');
}
