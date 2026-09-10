/**
 * Bringing your own relevance model, including an ONNX one.
 *
 * WHY THERE IS AN EXTENSION POINT RATHER THAN A BUNDLED MODEL. The default
 * ranker is BM25, and that is a competitive position rather than a shortcut:
 * it needs no Python, no model weights and no RAM floor, it runs in a
 * restricted sandbox, and it is deterministic -- which is what lets the cached
 * prefix stay byte-stable and a benchmark number mean anything. HeadRoom's
 * ModernBERT buys semantic recall and pays for it with all four of those.
 *
 * But BM25 is lexical, and lexical has a real ceiling: a question about "the
 * database ran out of handles" does not match a log line saying "connection
 * pool exhausted", however well it is tokenised. Somebody with a model and a
 * reason to run it should be able to, and the shape of that is the same shape
 * the engine registry already uses -- register an implementation, get the
 * default when you do not.
 *
 * RANKING IS SYNCHRONOUS, AND THAT IS NOT THE BARRIER IT LOOKED LIKE. The
 * engines are pure synchronous functions of (text, context) -- what keeps them
 * free of the per-request state HeadRoom's #3486 is about -- and
 * `onnxruntime-node`'s `session.run()` is async, so there is no `await` at the
 * point a ranker is called.
 *
 * An earlier version of this comment concluded from that that a model could not
 * be bundled, on the reasoning that the units to embed only exist after an
 * engine has parsed a block. THAT WAS WRONG, and the correction is worth
 * keeping visible: parsing is cheap and pure, so a request-level pre-pass can
 * collect candidate units, embed them all in one batch, and hand the sync
 * engines a cache to read. See `embedding.ts`, which does exactly that, and
 * `onnx.ts`, which is the forty lines of glue the barrier was hiding.
 *
 * So there are two ways in. `registerRanker` installs any synchronous Ranker,
 * and a warmed `EmbeddingCache` on the context takes precedence over it --
 * the cache is the more specific answer, because someone embedded THIS
 * request. With neither, everything is BM25.
 */

import { ranker as lexicalRanker, type Ranker } from './relevance.js';
import { semanticRanker, type EmbeddingCache } from './embedding.js';

/**
 * Builds a ranker for one question.
 *
 * The same signature as `relevance.ranker`, because that IS the default
 * implementation and a replacement has to be substitutable for it.
 */
export type RankerFactory = (query: string | undefined) => Ranker;

let factory: RankerFactory = lexicalRanker;

/**
 * Installs a ranker, replacing the lexical default.
 *
 * Module-level and deliberately not a class, for the reason the engine
 * registry gives: this is configuration, not per-request state, so two
 * concurrent requests cannot observe each other's.
 */
export function registerRanker(next: RankerFactory): void {
  if (typeof next !== 'function') {
    throw new Error('a ranker factory has to be a function');
  }
  factory = next;
}

/** Restores the built-in lexical ranker. Mainly for tests. */
export function resetRanker(): void {
  factory = lexicalRanker;
}

/** True when something other than the default is installed. */
export function rankerIsCustom(): boolean {
  return factory !== lexicalRanker;
}

/**
 * The ranker in force, behind the same boundary the engines get.
 *
 * A REGISTERED RANKER THAT THROWS FALLS BACK RATHER THAN FAILING THE REQUEST.
 * A model is a great deal more likely to throw than a word count is -- a
 * missing file, an out-of-memory, a shape mismatch on an input it did not
 * expect -- and the whole design fails open. Losing semantic ranking costs
 * some retention quality; losing the request costs the turn.
 */
export function activeRanker(
  query: string | undefined,
  embeddings?: EmbeddingCache
): Ranker {
  // A warmed cache outranks the registered factory, because it is the more
  // specific answer: the caller went to the trouble of embedding THIS request. With no
  // cache, or a query nobody embedded, this falls straight through to whatever is
  // registered, and that to BM25.
  //
  // THE QUERY VECTOR IS CHECKED HERE, not left to semanticRanker. It answers a missing
  // query vector by returning the LEXICAL ranker, which this branch then handed back as
  // though it were the semantic one -- so a warm cache and an unembedded query silently
  // discarded the caller's registered ranker for BM25, the opposite of what the comment
  // above promises. The gap is reachable: warmEmbeddings skips text under twelve
  // characters and caps the batch, so a short query leaves the cache warm and itself
  // unembedded.
  if (embeddings && embeddings.size > 0 && query && embeddings.get(query)) {
    try {
      return guarded(semanticRanker(query, embeddings), query);
    } catch {
      // Fall through to the registered ranker.
    }
  }

  let candidate: Ranker;
  try {
    candidate = factory(query);
  } catch {
    return lexicalRanker(query);
  }
  if (
    !candidate ||
    typeof candidate.top !== 'function' ||
    typeof candidate.score !== 'function' ||
    typeof candidate.active !== 'boolean'
  ) {
    return lexicalRanker(query);
  }
  return guarded(candidate, query);
}

/**
 * Wraps a ranker so a throw from `top` degrades instead of propagating.
 *
 * The check in `activeRanker` covers construction; this covers use, which is
 * where an inference actually runs. Both matter, and only the second one
 * happens per block.
 */
function guarded(inner: Ranker, query: string | undefined): Ranker {
  return {
    active: inner.active,
    top(units, n) {
      try {
        const result = inner.top(units, n);
        // A ranker that returns indices outside the input would corrupt the
        // selection silently, which is worse than not ranking at all.
        if (!(result instanceof Set)) return lexicalRanker(query).top(units, n);
        for (const index of result) {
          if (!Number.isInteger(index) || index < 0 || index >= units.length) {
            return lexicalRanker(query).top(units, n);
          }
        }
        return result;
      } catch {
        return lexicalRanker(query).top(units, n);
      }
    },
    score(unit, corpus) {
      try {
        const value = inner.score(unit, corpus);
        return Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    },
  };
}
