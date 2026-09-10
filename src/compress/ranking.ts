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
 * THE CONSTRAINT ANYONE PLUGGING IN A MODEL MUST KNOW, and it is the reason
 * this is an interface rather than a bundled integration: RANKING IS
 * SYNCHRONOUS. The engines are pure synchronous functions of (text, context) --
 * that is what makes them free of per-request state, which is the defect
 * HeadRoom's #3486 is about -- and `onnxruntime-node`'s `session.run()` is
 * async. There is no `await` available at the point a ranker is called.
 *
 * A model therefore has to be driven from behind a synchronous facade: warm a
 * cache of embeddings out of band and look them up here, or run the session on
 * a worker and block on a shared buffer. Neither is exotic, but neither is
 * free, and discovering it after installing 100 MB of native binaries would be
 * an unpleasant surprise. It is written here instead.
 *
 * NOT VERIFIED AGAINST A REAL MODEL. `onnxruntime-node` is not installed in
 * this repository and no weights are shipped. What is proved below is that the
 * seam works and that the default is unchanged when nothing is registered; that
 * a particular embedding model improves retention is an untested claim and is
 * not made anywhere.
 */

import { ranker as lexicalRanker, type Ranker } from './relevance.js';

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
export function activeRanker(query: string | undefined): Ranker {
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
