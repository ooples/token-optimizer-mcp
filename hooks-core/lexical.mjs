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

/** Non-word split, lowercased. Short tokens are kept: `fs`, `id`, `os` matter here. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
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
      // Standard BM25 IDF, floored at zero so a term present in every document
      // contributes nothing rather than a negative score.
      const idf = Math.max(0, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
      const norm = tf + k1 * (1 - b + (b * tokens.length) / (avgLen || 1));
      score += idf * ((tf * (k1 + 1)) / (norm || 1));
    }

    // Zero means no term matched. Omitted rather than returned, so a caller
    // under a token budget never spends it on an irrelevant finding.
    if (score > 0) scored.push({ finding, score });
  }

  return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
