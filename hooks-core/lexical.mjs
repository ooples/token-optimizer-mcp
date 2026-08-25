/**
 * BM25 over findings. Pure, dependency-free, deterministic.
 *
 * WHY THIS REPLACES `includes()`. The dashboard filtered findings by substring,
 * which cannot RANK -- and every consumer of retrieval here is under a hard
 * token budget, so the budget kept whatever happened to match rather than what
 * matched best. Ranking is the whole value at a budget.
 *
 * WHY BM25 AND NOT EMBEDDINGS. Deliberate, per docs/WIKI_GRAPH.md: deterministic,
 * instant, explainable, and it cannot drift or need a rebuild. The known cost is
 * recall on findings with no lexical overlap; Plan 2's recall probe measures that
 * rather than assuming it away.
 */

/**
 * Splits an identifier's alphanumeric run into its camelCase / letter-digit
 * parts, e.g. `skipLibCheck` -> ['skip', 'Lib', 'Check'], `TS2345` ->
 * ['TS', '2345']. Returns a single-element array when there is no internal
 * boundary (e.g. `retry` -> ['retry']) so callers can skip emitting a
 * redundant duplicate of the whole token.
 */
function splitIdentifierParts(word) {
  return word
    .replace(/([a-z])([A-Z])/g, '$1\0$2')
    .replace(/([A-Za-z])([0-9])/g, '$1\0$2')
    .replace(/([0-9])([A-Za-z])/g, '$1\0$2')
    .split('\0')
    .filter(Boolean);
}

/**
 * Non-word split, lowercased. Short tokens are kept: `fs`, `id`, `os` matter
 * here.
 *
 * Emits sub-tokens for compound identifiers, in addition to the whole token.
 * Delimited identifiers (`smart_read`, `wiki.mjs`, the flag in
 * `--skipLibCheck`) already round-trip fine: the delimiter splits them, and
 * because query and claim pass through this same function, a query typed
 * with the same delimiters matches. The silent gap was CONCATENATED
 * identifiers with no delimiter at all -- `skipLibCheck` collapsed to the
 * single token `skiplibcheck`, so a query for "skip lib check" (or "TS 2345"
 * against `TS2345`) never intersected it. No error, just an absent result --
 * and findings are about code, where run-together identifiers are the
 * common case. So every alphanumeric run keeps its whole-token form (a query
 * for the concatenated form still matches) and ALSO contributes its
 * camelCase / letter-digit parts (a query for the separated form now
 * matches too). A lone incidental character -- e.g. the `c` split out of a
 * Windows path `C:\Users\...` -- needs no special-casing: it is a real
 * token like any other, and BM25's IDF already discounts a term that shows
 * up in nearly every finding.
 */
export function tokenize(text) {
  const words = String(text || '').match(/[A-Za-z0-9]+/g) || [];
  const tokens = [];
  for (const word of words) {
    tokens.push(word.toLowerCase());
    const parts = splitIdentifierParts(word);
    if (parts.length > 1) {
      for (const part of parts) tokens.push(part.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Classic BM25. `k1` controls term-frequency saturation, `b` length normalisation.
 * Defaults are the standard ones and are exposed so the recall probe can sweep them.
 */
export function rank(query, findings, { limit = 20, k1 = 1.2, b = 0.75 } = {}) {
  const terms = tokenize(query);
  if (!terms.length || !Array.isArray(findings) || !findings.length) return [];

  // A finding's searchable text is its claim AND its key: the key is how the
  // session index refers to it, so a model quoting a key must find it.
  const docs = findings.map((finding) => ({
    finding,
    tokens: tokenize(`${finding.key || ''} ${finding.claim || ''}`),
  }));

  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;
  const N = docs.length;

  const docFreq = new Map();
  for (const { tokens } of docs) {
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const scored = [];
  for (const { finding, tokens } of docs) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = docFreq.get(term) || 0;
      // Smoothed BM25 idf: log(1 + (N - df + 0.5) / (df + 0.5)). Unlike the
      // classic unsmoothed idf (log((N - df + 0.5) / (df + 0.5))), which goes
      // negative once a term appears in most documents, this smoothed form
      // is strictly positive for every df in [1, N]: even at df === N the
      // ratio inside the log is (N + 1) / (N + 0.5), which is always
      // strictly greater than 1, so log(1 + that) is always > 0. No floor
      // is needed here, and none is applied -- there is no negative case
      // for this formula to guard against.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = tf + k1 * (1 - b + (b * tokens.length) / (avgLen || 1));
      score += idf * ((tf * (k1 + 1)) / (norm || 1));
    }

    // Zero means no term matched. Omitted rather than returned, so a caller
    // under a token budget never spends it on an irrelevant finding.
    if (score > 0) scored.push({ finding, score });
  }

  return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
