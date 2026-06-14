import { createHash } from 'crypto';
import { LruCache, LruCacheStats } from './lru-cache.js';

/**
 * Wrap an async function with an LRU cache so repeated calls with the
 * same arguments are served from memory — addresses issue #125's
 * "store results of expensive operations" for smart_read, smart_grep,
 * smart_glob, and edit-correction paths.
 *
 * Each wrapped function owns its own cache, but every cache is
 * registered with the shared `memoRegistry` so the server can prune
 * and log stats for all of them at once.
 */

export interface LruMemoizeOptions<Args extends readonly unknown[]> {
  /** Identifier used in logs. */
  name: string;
  /** Max cached entries. */
  maxSize: number;
  /** Default per-entry TTL in ms. 0 disables expiration. */
  ttlMs?: number;
  /** Custom key function; defaults to sha256(JSON.stringify(args)). */
  keyFn?: (args: Args) => string;
}

export interface RegisteredCache {
  name: string;
  cache: LruCache<string, unknown>;
  /**
   * Invalidation hook: clears stored entries AND fences off in-flight
   * calls so a result computed before invalidation can never be written
   * back into the cache afterwards.
   */
  invalidate: () => void;
}

class MemoRegistry {
  private readonly caches = new Map<string, RegisteredCache>();

  public register(entry: RegisteredCache): void {
    this.caches.set(entry.name, entry);
  }

  /** Prune every registered cache and return total entries removed. */
  public pruneAll(): number {
    let total = 0;
    for (const { cache } of this.caches.values()) {
      total += cache.prune();
    }
    return total;
  }

  public stats(): Record<string, LruCacheStats> {
    const out: Record<string, LruCacheStats> = {};
    for (const [name, { cache }] of this.caches) {
      out[name] = cache.stats();
    }
    return out;
  }

  public clearAll(): void {
    for (const { invalidate } of this.caches.values()) {
      invalidate();
    }
  }
}

export const memoRegistry = new MemoRegistry();

export function lruMemoize<Args extends readonly unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options: LruMemoizeOptions<Args>
): (...args: Args) => Promise<R> {
  // Wrap values in a tiny envelope so a legitimately-cached `undefined`
  // can be distinguished from a cache miss.
  type Envelope = { value: R };
  const cache = new LruCache<string, Envelope>(
    options.maxSize,
    options.ttlMs ?? 0
  );

  // Deduplicate concurrent calls for the same key so a stampede of
  // requests while the first promise is still pending doesn't run the
  // expensive function N times.
  const inFlight = new Map<string, Promise<R>>();

  // Invalidation epoch: bumped on every invalidate() so calls that were
  // already running when the cache was cleared cannot write their (now
  // stale) result back afterwards.
  let epoch = 0;

  memoRegistry.register({
    name: options.name,
    cache: cache as unknown as LruCache<string, unknown>,
    invalidate: () => {
      cache.clear();
      // Forget pending promises too: a caller arriving after invalidation
      // must not be handed a result computed against pre-invalidation state.
      inFlight.clear();
      epoch++;
    },
  });

  const keyFn =
    options.keyFn ??
    ((args: Args): string => {
      const serialized = JSON.stringify(args, (_, v) => {
        // Tag bigints with a dedicated discriminator so
        // `[1n]` and `["1"]` don't collapse to the same key.
        if (typeof v === 'bigint') {
          return { __memo_bigint__: v.toString() };
        }
        return v;
      });
      return createHash('sha256').update(serialized).digest('hex');
    });

  return async (...args: Args): Promise<R> => {
    const key = keyFn(args);
    const hit = cache.get(key);
    if (hit !== undefined) {
      return hit.value;
    }
    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }
    const startEpoch = epoch;
    // Declared before the async closure so the closure's `finally` can
    // compare against it; assignment happens before the first await yields.
    let promise: Promise<R> | undefined;
    promise = (async () => {
      try {
        const value = await fn(...args);
        // Skip the write-back if invalidate() ran while we were pending —
        // the result was computed against pre-invalidation state.
        if (epoch === startEpoch) {
          cache.set(key, { value });
        }
        return value;
      } finally {
        // invalidate() may have cleared inFlight and a newer call may have
        // registered its own promise under this key; only remove our own.
        if (inFlight.get(key) === promise) {
          inFlight.delete(key);
        }
      }
    })();
    inFlight.set(key, promise);
    return promise;
  };
}
