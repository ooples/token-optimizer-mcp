/**
 * Semantic ranking behind a synchronous engine contract.
 *
 * THIS FILE EXISTS BECAUSE I GOT THE ARCHITECTURE WRONG ONCE, and the wrong
 * answer is worth stating so it is not re-derived. `ranking.ts` shipped with a
 * claim that a model could not be bundled: the engines are synchronous pure
 * functions, `onnxruntime-node`'s `session.run()` is async, and the units to
 * embed -- rows, lines, sentences, declarations -- only exist after an engine
 * has parsed a block, so they cannot be encoded before it runs.
 *
 * The last clause is false, and it was the one holding the conclusion up.
 * Parsing is cheap and pure. Nothing stops a pre-pass from asking each engine
 * what units it WOULD rank, embedding all of them in one batch, and handing
 * the sync engines a cache to read. The async work moves to the request level,
 * which is exactly where `loadFindings` already does its I/O.
 *
 * SO THE SHAPE IS TWO PHASES:
 *
 *   1. async, once per request -- `warmEmbeddings` walks the blocks, collects
 *      candidate units from the registered engines, and embeds everything it
 *      has not seen before in a single batched call;
 *   2. sync, per block, unchanged -- the engines run exactly as they always
 *      have, and the ranker reads vectors out of the cache.
 *
 * A UNIT THAT MISSED THE PRE-PASS FALLS BACK TO BM25 rather than being scored
 * zero. Content can appear that phase one did not see -- an engine's unit
 * extraction is a best effort, not a contract -- and a unit silently scoring
 * zero would be dropped as irrelevant when the truth is that nobody asked the
 * model about it. Lexical is the floor, never nothing.
 *
 * NONE OF THIS IS ON BY DEFAULT. BM25 remains the shipped ranker: no Python,
 * no weights, no RAM floor, deterministic, and cache-stable. This is the door
 * for someone who wants more and can pay for it.
 */

import { ranker as lexicalRanker, tokenize, type Ranker } from './relevance.js';

/** Turns text into vectors. Async, because every real model is. */
export interface SemanticEncoder {
  /** Vector width. Used to validate what comes back rather than to trust it. */
  readonly dimensions: number;
  /**
   * Embeds a batch.
   *
   * BATCHED, NOT PER-UNIT, because per-call overhead dominates for small
   * inputs -- a log line is a dozen tokens and a session may hold thousands of
   * them. Must return one vector per input, in order.
   */
  encode(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

/** Vectors already computed, keyed by the exact text they came from. */
export interface EmbeddingCache {
  get(text: string): Float32Array | undefined;
  has(text: string): boolean;
  readonly size: number;
}

interface MutableCache extends EmbeddingCache {
  set(text: string, vector: Float32Array): void;
}

/**
 * How many units one request may embed.
 *
 * A bound rather than a guess: a large session can hold tens of thousands of
 * candidate units, and embedding all of them would cost more time than the
 * compression saves. The cap is applied AFTER ordering by size, so the units
 * that survive are the ones whose retention decision matters most.
 */
export const MAX_UNITS_PER_REQUEST = 2048;

/** Units shorter than this carry too little signal to be worth a vector. */
const MIN_UNIT_CHARS = 12;

/** An LRU-free cache: a request's working set is bounded by the cap above. */
export function embeddingCache(): EmbeddingCache & MutableCache {
  const vectors = new Map<string, Float32Array>();
  return {
    get: (text) => vectors.get(text),
    has: (text) => vectors.has(text),
    set: (text, vector) => void vectors.set(text, vector),
    get size() {
      return vectors.size;
    },
  };
}

/** Cosine similarity. Both vectors are assumed the same length. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Below this a unit is not considered relevant at all.
 *
 * Cosine over a real encoder is rarely near zero even for unrelated text, so
 * without a floor every unit would score "somewhat relevant" and the ranking
 * would keep whatever the budget allowed -- the failure `relevance.ts` already
 * guards against on the lexical side by refusing zero-scoring units.
 */
const MIN_SIMILARITY = 0.15;

/**
 * A ranker backed by precomputed vectors, with BM25 underneath.
 *
 * Synchronous, which is the whole point: it is called from inside the engines
 * and does nothing but arithmetic over vectors phase one already computed.
 */
export function semanticRanker(
  query: string | undefined,
  cache: EmbeddingCache
): Ranker {
  const lexical = lexicalRanker(query);
  const queryVector = query ? cache.get(query) : undefined;
  if (!queryVector) return lexical;

  return {
    active: true,
    top(units, n) {
      if (n <= 0 || !units.length) return new Set<number>();

      const scored: { index: number; score: number }[] = [];
      const unembedded: number[] = [];

      units.forEach((unit, index) => {
        const vector = cache.get(unit);
        if (!vector) {
          unembedded.push(index);
          return;
        }
        const score = cosine(queryVector, vector);
        if (score >= MIN_SIMILARITY) scored.push({ index, score });
      });

      // Ties break on position so the result is stable, which is what keeps a
      // cached prefix byte-identical between turns.
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      const chosen = new Set(scored.slice(0, n).map((s) => s.index));

      // Anything phase one did not see is judged lexically rather than
      // discarded. Missing a vector is our omission, not evidence about the
      // unit.
      if (chosen.size < n && unembedded.length) {
        const fallbackUnits = unembedded.map((index) => units[index]);
        for (const local of lexical.top(fallbackUnits, n - chosen.size)) {
          chosen.add(unembedded[local]);
        }
      }
      return chosen;
    },
    score(unit, corpus) {
      const vector = cache.get(unit);
      if (!vector) return lexical.score(unit, corpus);
      const score = cosine(queryVector, vector);
      return score >= MIN_SIMILARITY ? score : 0;
    },
  };
}

/**
 * Phase one: embed everything the engines might rank, in one batch.
 *
 * `texts` is whatever the caller can collect cheaply -- see `unitsOf` in
 * `router.ts`, which asks each registered engine. Order is by length
 * descending before the cap, so when there is more content than budget the
 * units that survive are the substantial ones rather than whichever happened
 * to come first.
 *
 * FAILS SOFT, ALWAYS. An encoder that throws, hangs past its budget, or
 * returns the wrong shape leaves the cache as it was, and every engine falls
 * back to BM25. A model is far likelier to fail than a word count, and the
 * proxy's rule is that nothing it does may cost the request.
 */
export async function warmEmbeddings(
  encoder: SemanticEncoder,
  texts: readonly string[],
  cache: EmbeddingCache & MutableCache,
  maxUnits: number = MAX_UNITS_PER_REQUEST
): Promise<number> {
  const wanted = [...new Set(texts)]
    .filter((text) => text.length >= MIN_UNIT_CHARS && !cache.has(text))
    .sort((a, b) => b.length - a.length)
    .slice(0, Math.max(0, maxUnits));

  if (!wanted.length) return 0;

  let vectors: readonly Float32Array[];
  try {
    vectors = await encoder.encode(wanted);
  } catch {
    return 0;
  }

  // A short or mis-shaped batch is a broken encoder, and taking the prefix
  // would silently pair vectors with the wrong text -- worse than no ranking,
  // because it looks like it worked.
  if (!Array.isArray(vectors) || vectors.length !== wanted.length) return 0;

  let stored = 0;
  for (let i = 0; i < wanted.length; i += 1) {
    const vector = vectors[i];
    if (
      !(vector instanceof Float32Array) ||
      vector.length !== encoder.dimensions
    )
      continue;
    cache.set(wanted[i], vector);
    stored += 1;
  }
  return stored;
}

/**
 * The units a request could rank, gathered without running any engine.
 *
 * Deliberately generic: splitting on lines and sentence boundaries covers what
 * `log`, `search`, `prose` and `json`-row ranking actually score, and costs a
 * regex rather than a parse. An engine whose units are stranger than this
 * simply gets lexical ranking for them, which is the documented floor.
 */
export function candidateUnits(text: string): string[] {
  if (!text) return [];
  const units: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_UNIT_CHARS) units.push(trimmed);
  }
  // Prose arrives as few long lines, so sentence splitting is what finds its
  // units at all.
  if (units.length < 4 && text.length > 200) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim();
      if (trimmed.length >= MIN_UNIT_CHARS) units.push(trimmed);
    }
  }
  return units;
}

/** True when a query has enough content to be worth embedding at all. */
export function queryIsUsable(query: string | undefined): boolean {
  return tokenize(query ?? '').length > 1;
}
