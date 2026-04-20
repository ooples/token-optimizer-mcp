/**
 * Generic LRU cache with optional per-entry TTL — addresses issue #125.
 *
 * Unlike CacheEngine (token-aware, persistent SQLite cache), this is an
 * in-memory LRU intended for hot paths: file-search results, token counts,
 * MCP correction responses, etc. Eviction is O(1) via Map insertion order.
 */

export interface LruCacheStats {
    size: number;
    maxSize: number;
    hits: number;
    misses: number;
    evictions: number;
    expired: number;
    hitRate: number;
}

interface LruCacheEntry<V> {
    value: V;
    expiresAt: number;
}

export class LruCache<K, V> {
    private readonly cache = new Map<K, LruCacheEntry<V>>();
    private readonly maxSize: number;
    private readonly defaultTtlMs: number;
    private hits = 0;
    private misses = 0;
    private evictions = 0;
    private expired = 0;

    constructor(maxSize: number, defaultTtlMs: number = 0) {
        if (maxSize <= 0) {
            throw new Error(`LruCache maxSize must be > 0, got ${maxSize}`);
        }
        this.maxSize = maxSize;
        this.defaultTtlMs = defaultTtlMs;
    }

    public get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }

        if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.expired++;
            this.misses++;
            return undefined;
        }

        // Refresh recency: remove + re-insert moves to the tail.
        this.cache.delete(key);
        this.cache.set(key, entry);
        this.hits++;
        return entry.value;
    }

    public set(key: K, value: V, ttlMs?: number): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value as K | undefined;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
                this.evictions++;
            }
        }

        const effectiveTtl = ttlMs ?? this.defaultTtlMs;
        this.cache.set(key, {
            value,
            expiresAt: effectiveTtl > 0 ? Date.now() + effectiveTtl : 0,
        });
    }

    public has(key: K): boolean {
        const entry = this.cache.get(key);
        if (!entry) {
            return false;
        }
        if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.expired++;
            return false;
        }
        return true;
    }

    public delete(key: K): boolean {
        return this.cache.delete(key);
    }

    public clear(): void {
        this.cache.clear();
    }

    public get size(): number {
        return this.cache.size;
    }

    /** Remove all entries whose TTL has expired. Returns the count removed. */
    public prune(): number {
        if (this.defaultTtlMs === 0) {
            return 0;
        }
        const now = Date.now();
        let removed = 0;
        for (const [key, entry] of this.cache) {
            if (entry.expiresAt !== 0 && now > entry.expiresAt) {
                this.cache.delete(key);
                removed++;
            }
        }
        this.expired += removed;
        return removed;
    }

    public stats(): LruCacheStats {
        const total = this.hits + this.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            expired: this.expired,
            hitRate: total === 0 ? 0 : this.hits / total,
        };
    }
}
