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
        for (const { cache } of this.caches.values()) {
            cache.clear();
        }
    }
}

export const memoRegistry = new MemoRegistry();

export function lruMemoize<Args extends readonly unknown[], R>(
    fn: (...args: Args) => Promise<R>,
    options: LruMemoizeOptions<Args>
): (...args: Args) => Promise<R> {
    const cache = new LruCache<string, R>(options.maxSize, options.ttlMs ?? 0);
    memoRegistry.register({
        name: options.name,
        cache: cache as unknown as LruCache<string, unknown>,
    });

    const keyFn =
        options.keyFn ??
        ((args: Args): string => {
            const serialized = JSON.stringify(args, (_, v) =>
                typeof v === 'bigint' ? v.toString() : v
            );
            return createHash('sha256').update(serialized).digest('hex');
        });

    return async (...args: Args): Promise<R> => {
        const key = keyFn(args);
        const hit = cache.get(key);
        if (hit !== undefined) {
            return hit;
        }
        const value = await fn(...args);
        cache.set(key, value);
        return value;
    };
}
