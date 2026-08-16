import Database from 'better-sqlite3';
import { LRUCache } from 'lru-cache';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { IEmbeddingGenerator } from '../interfaces/IEmbeddingGenerator.js';
import { IVectorStore } from '../interfaces/IVectorStore.js';

/**
 * Whether an error from opening/initializing SQLite indicates the database file
 * is corrupt or not a valid database (e.g. a partially-written file, or a
 * non-DB file left at the path). Such a file can be safely deleted and
 * recreated, so callers use this to decide whether to self-heal on retry.
 */
function isCorruptDatabaseError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === 'SQLITE_NOTADB' ||
    code === 'SQLITE_CORRUPT' ||
    /not a database|file is encrypted|is not a database|malformed/i.test(
      message
    )
  );
}

/** Env flags are strings; treat only the usual affirmatives as on. */
function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * The cache table and its indexes. Shared by the on-disk path and the
 * in-memory fallback so a degraded cache is schema-identical to a healthy one.
 */
const CACHE_SCHEMA = `
          CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            compressed_size INTEGER NOT NULL,
            original_size INTEGER NOT NULL,
            hit_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_last_accessed ON cache(last_accessed_at);
          CREATE INDEX IF NOT EXISTS idx_hit_count ON cache(hit_count);
        `;

export interface CacheEntry {
  key: string;
  value: string;
  compressedSize: number;
  originalSize: number;
  hitCount: number;
  createdAt: number;
  lastAccessedAt: number;
}

export interface CacheStats {
  totalEntries: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  totalCompressedSize: number;
  totalOriginalSize: number;
  compressionRatio: number;
  semanticHits?: number; // Number of cache hits via semantic matching
  semanticHitRate?: number; // Semantic hits as percentage of total hits
}

export interface SemanticCachingConfig {
  similarityThreshold?: number; // Minimum cosine similarity for a match (0-1, default: 0.85)
  topK?: number; // Number of similar entries to search (default: 5)
  enabled?: boolean; // Enable semantic caching (default: true if generators provided)
}

export class CacheEngine {
  private db!: Database.Database;
  private memoryCache: LRUCache<
    string,
    { content: string; compressedSize: number }
  >;
  private dbPath!: string;
  /**
   * Set when the on-disk database could not be opened and an in-memory
   * database was used instead. Read by the doctor and by `cache_audit` so a
   * degraded server says so rather than silently losing every cache write.
   */
  private degradedReason: string | null = null;
  private stats = {
    hits: 0,
    misses: 0,
    semanticHits: 0, // Track semantic cache hits separately
  };

  // Semantic caching components (optional)
  private embeddingGenerator?: IEmbeddingGenerator;
  private vectorStore?: IVectorStore;
  private semanticConfig: SemanticCachingConfig;

  constructor(
    dbPath?: string,
    maxMemoryItems: number = 1000,
    embeddingGenerator?: IEmbeddingGenerator,
    vectorStore?: IVectorStore,
    semanticConfig?: SemanticCachingConfig
  ) {
    // Use user-provided path, environment variable, or default to ~/.token-optimizer-cache
    const defaultCacheDir =
      process.env.TOKEN_OPTIMIZER_CACHE_DIR ||
      path.join(os.homedir(), '.token-optimizer-cache');

    // Resolve the cache directory and the database file path.
    //
    // `dbPath` is normally the database FILE path, but historically some callers
    // passed a cache DIRECTORY here (and upgraders may still have a directory at
    // that location on disk — e.g. ~/.hypercontext/cache/ containing cache.db).
    // If we're handed an existing directory, put the database inside it rather
    // than trying to open the directory as a SQLite file (which fails with
    // "unable to open database file").
    let cacheDir: string;
    let finalDbPath: string;
    if (dbPath) {
      let dbPathIsDirectory = false;
      try {
        dbPathIsDirectory =
          fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory();
      } catch {
        dbPathIsDirectory = false;
      }

      if (dbPathIsDirectory) {
        cacheDir = dbPath;
        finalDbPath = path.join(dbPath, 'cache.db');
      } else {
        cacheDir = path.dirname(dbPath);
        finalDbPath = dbPath;
      }
    } else {
      cacheDir = defaultCacheDir;
      finalDbPath = path.join(cacheDir, 'cache.db');
    }

    // Ensure cache directory exists.
    //
    // A parent that exists but is a FILE is the interesting case: existsSync is
    // true, so the mkdir is skipped, and SQLite then fails to open a path whose
    // parent is not a directory. That surfaced as three retries and
    // "CRITICAL: Failed to initialize persistent cache database", which says
    // nothing about the actual conflict. Naming it is the difference between a
    // one-line fix and an afternoon.
    if (fs.existsSync(cacheDir)) {
      if (!fs.statSync(cacheDir).isDirectory()) {
        throw new Error(
          `Cannot create the cache at ${finalDbPath}: ${cacheDir} is a file, not a directory. ` +
            `Something else is using that path -- remove or rename it, or pass a different cache location.`
        );
      }
    } else {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Retry logic with up to 3 attempts
    let lastError = null;
    const maxAttempts = 3;
    let dbInitialized = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // First attempt: use requested path as-is.
        // Any later attempt: if the previous failure was a corrupt/invalid DB
        // file (e.g. SQLITE_NOTADB from a partial write or a stray non-DB file),
        // delete the DB and its WAL/SHM sidecars so this attempt recreates a
        // fresh database. This runs on EVERY retry (not just attempt 2) so a
        // single failed delete doesn't strand the remaining attempts.
        // PHASE 1 FIX: Removed tmpdir fallback - was causing 0% cache hit rate.
        const dbPathToUse = finalDbPath;

        if (attempt > 1 && isCorruptDatabaseError(lastError)) {
          for (const p of [
            finalDbPath,
            `${finalDbPath}-wal`,
            `${finalDbPath}-shm`,
          ]) {
            try {
              if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch {
              // Best-effort: if a sidecar can't be removed, the open below may
              // still fail and we fall through to the next attempt / final error.
            }
          }
        }

        this.db = new Database(dbPathToUse);
        this.db.pragma('journal_mode = WAL');

        // Create cache table if it doesn't exist
        this.db.exec(CACHE_SCHEMA);

        // Success! Store the path we used
        this.dbPath = dbPathToUse;
        dbInitialized = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Try to close the database if it was partially opened
        try {
          if (this.db) {
            this.db.close();
          }
        } catch {
          // Ignore close errors
        }

        if (attempt < maxAttempts) {
          // Log warning and try next attempt
          console.warn(
            `Cache database initialization attempt ${attempt}/${maxAttempts} failed:`,
            error
          );
          console.warn(`Retrying... (attempt ${attempt + 1}/${maxAttempts})`);
        }
      }
    }

    // EVERY ATTEMPT FAILED. What happens next decides whether the user has a
    // degraded MCP server or no MCP server at all.
    //
    // This used to throw, and the throw ran during module evaluation of
    // src/server/index.ts (`const cache = new CacheEngine()` at top level). An
    // unopenable cache file therefore killed the process before
    // `server.connect()` -- no stdout, no tools, exit code 1, and the only
    // explanation on stderr, which the MCP client typically discards. Issue
    // #307 is exactly that shape: "MCP server exits before registering tools",
    // no output, exit 1.
    //
    // A cache is an optimization. Losing it must cost persistence, not the
    // whole server. So the last resort is an in-memory database: every tool
    // still works, nothing survives the process, and the reason is stated
    // loudly on stderr (never stdout -- that is the JSON-RPC channel) and
    // carried on the instance so the doctor and cache_audit can report it.
    //
    // The removed tmpdir fallback this replaces was silent and preferred, which
    // is why it produced a 0% hit rate nobody could see. This one is last-resort
    // and self-reporting. TOKEN_OPTIMIZER_CACHE_STRICT=1 restores the throw for
    // callers that would rather fail than run without persistence.
    if (!dbInitialized) {
      const diagnosis =
        `Failed to initialize the persistent cache database at ${finalDbPath} ` +
        `after ${maxAttempts} attempts. Last error: ${lastError?.message || 'Unknown error'}. ` +
        `Check disk space, file permissions, and that the directory is writable.`;

      if (isTruthyEnv(process.env.TOKEN_OPTIMIZER_CACHE_STRICT)) {
        throw new Error(
          `CRITICAL: ${diagnosis} ` +
            `TOKEN_OPTIMIZER_CACHE_STRICT is set, so no in-memory fallback was used.`
        );
      }

      try {
        this.db = new Database(':memory:');
        this.db.exec(CACHE_SCHEMA);
        this.dbPath = ':memory:';
        this.degradedReason = diagnosis;
        console.error(
          `[token-optimizer] cache is running IN MEMORY ONLY: ${diagnosis} ` +
            `Tools still work; nothing is cached across runs. ` +
            `Set TOKEN_OPTIMIZER_CACHE_STRICT=1 to fail instead of degrading.`
        );
      } catch (memoryError) {
        // better-sqlite3 itself is unusable (e.g. the native binding failed to
        // load for this Node ABI). Nothing can rescue that here.
        throw new Error(
          `CRITICAL: ${diagnosis} The in-memory fallback also failed: ` +
            `${memoryError instanceof Error ? memoryError.message : String(memoryError)}. ` +
            `Reinstall @ooples/token-optimizer-mcp so better-sqlite3 rebuilds for this Node version.`
        );
      }
    }

    // Initialize in-memory LRU cache for frequently accessed items
    this.memoryCache = new LRUCache<
      string,
      { content: string; compressedSize: number }
    >({
      max: maxMemoryItems,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    });

    // Initialize semantic caching components (optional)
    this.embeddingGenerator = embeddingGenerator;
    this.vectorStore = vectorStore;
    this.semanticConfig = {
      similarityThreshold: semanticConfig?.similarityThreshold ?? 0.85,
      topK: semanticConfig?.topK ?? 5,
      enabled:
        semanticConfig?.enabled ??
        (embeddingGenerator !== undefined && vectorStore !== undefined),
    };
  }

  /**
   * Get a value from cache (synchronous, exact match only)
   * For backward compatibility, this method only performs exact key matching
   * Use getWithSemantic() for semantic similarity search
   */
  get(key: string): string | null {
    const result = this.getExact(key);
    if (result === null) {
      this.stats.misses++;
    }
    return result;
  }

  /**
   * Get a value from cache with semantic matching enabled
   * First tries exact key match, then semantic similarity if enabled
   */
  async getWithSemantic(key: string): Promise<string | null> {
    // Try exact key match first (fast path)
    const exactMatch = this.getExact(key);
    if (exactMatch !== null) {
      return exactMatch;
    }

    // If semantic caching is enabled, try similarity search
    if (
      this.semanticConfig.enabled &&
      this.embeddingGenerator &&
      this.vectorStore
    ) {
      try {
        const semanticMatch = await this.getSemanticMatch(key);
        if (semanticMatch !== null) {
          this.stats.semanticHits++;
          return semanticMatch;
        }
      } catch (error) {
        // Log error but don't fail - fall back to cache miss
        console.warn('Semantic cache lookup failed:', error);
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Get a value from cache using exact key match (synchronous)
   */
  private getExact(key: string): string | null {
    // Check memory cache first
    const memValue = this.memoryCache.get(key);
    if (memValue !== undefined) {
      this.stats.hits++;
      this.updateHitCount(key);
      return memValue.content;
    }

    // Check SQLite cache
    const stmt = this.db.prepare(`
      SELECT value, compressed_size FROM cache WHERE key = ?
    `);
    const row = stmt.get(key) as
      | { value: string; compressed_size: number }
      | undefined;

    if (row) {
      this.stats.hits++;
      // Update hit count and last accessed time
      this.updateHitCount(key);
      // Add to memory cache for faster access
      this.memoryCache.set(key, {
        content: row.value,
        compressedSize: row.compressed_size,
      });
      return row.value;
    }

    return null;
  }

  /**
   * Get a value from cache using semantic similarity matching
   * Searches for similar queries and returns the closest match above threshold
   */
  private async getSemanticMatch(query: string): Promise<string | null> {
    if (!this.embeddingGenerator || !this.vectorStore) {
      return null;
    }

    // Generate embedding for the query
    const queryEmbedding =
      await this.embeddingGenerator.generateEmbedding(query);

    // Search for similar vectors in the store
    const results = await this.vectorStore.search(
      queryEmbedding,
      this.semanticConfig.topK || 5,
      this.semanticConfig.similarityThreshold || 0.85
    );

    if (results.length === 0) {
      return null;
    }

    // Get the most similar result
    const bestMatch = results[0];

    // Retrieve the cached value using the matched key
    const cachedValue = this.getExact(bestMatch.id);
    if (cachedValue !== null) {
      // Log semantic hit for debugging
      console.log(
        `Semantic cache hit: query="${query}" matched key="${bestMatch.id}" (similarity: ${bestMatch.similarity.toFixed(3)})`
      );
    }

    return cachedValue;
  }

  /**
   * Get a value from cache with metadata (including compression info)
   */
  getWithMetadata(
    key: string
  ): { content: string; compressedSize: number } | null {
    // Check memory cache first
    const memValue = this.memoryCache.get(key);
    if (memValue !== undefined) {
      this.stats.hits++;
      this.updateHitCount(key);
      return memValue;
    }

    // Check SQLite cache
    const stmt = this.db.prepare(`
      SELECT value, compressed_size FROM cache WHERE key = ?
    `);
    const row = stmt.get(key) as
      | { value: string; compressed_size: number }
      | undefined;

    if (row) {
      this.stats.hits++;
      // Update hit count and last accessed time
      this.updateHitCount(key);
      // Add to memory cache for faster access
      this.memoryCache.set(key, {
        content: row.value,
        compressedSize: row.compressed_size,
      });
      return {
        content: row.value,
        compressedSize: row.compressed_size,
      };
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set a value in cache (synchronous, without semantic embedding)
   * For backward compatibility
   */
  set(
    key: string,
    value: string,
    originalSize: number,
    compressedSize: number
  ): void {
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO cache
      (key, value, compressed_size, original_size, hit_count, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?,
        COALESCE((SELECT hit_count FROM cache WHERE key = ?), 0),
        COALESCE((SELECT created_at FROM cache WHERE key = ?), ?),
        ?)
    `);

    stmt.run(key, value, compressedSize, originalSize, key, key, now, now);

    // Add to memory cache
    this.memoryCache.set(key, { content: value, compressedSize });
  }

  /**
   * Set a value in cache with semantic embedding
   * Also generates and stores embedding if semantic caching is enabled
   */
  async setWithSemantic(
    key: string,
    value: string,
    originalSize: number,
    compressedSize: number
  ): Promise<void> {
    // First do the regular set
    this.set(key, value, originalSize, compressedSize);

    // Generate and store embedding if semantic caching is enabled
    if (
      this.semanticConfig.enabled &&
      this.embeddingGenerator &&
      this.vectorStore
    ) {
      try {
        const embedding = await this.embeddingGenerator.generateEmbedding(key);
        await this.vectorStore.add(key, embedding);
      } catch (error) {
        // Log error but don't fail the cache set operation
        console.warn(
          'Failed to generate/store embedding for cache key:',
          error
        );
      }
    }
  }

  /**
   * Delete a value from cache (synchronous)
   */
  delete(key: string): boolean {
    this.memoryCache.delete(key);
    const stmt = this.db.prepare('DELETE FROM cache WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  /**
   * Delete a value from cache with semantic embedding removal
   * Also removes the embedding if semantic caching is enabled
   */
  async deleteWithSemantic(key: string): Promise<boolean> {
    const result = this.delete(key);

    // Remove embedding if semantic caching is enabled
    if (this.semanticConfig.enabled && this.vectorStore) {
      try {
        await this.vectorStore.delete(key);
      } catch (error) {
        console.warn('Failed to delete embedding from vector store:', error);
      }
    }

    return result;
  }

  /**
   * Clear all cache (synchronous)
   */
  clear(): void {
    this.memoryCache.clear();
    this.db.exec('DELETE FROM cache');
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.semanticHits = 0;
  }

  /**
   * Clear all cache including vector store
   * Also clears the vector store if semantic caching is enabled
   */
  async clearWithSemantic(): Promise<void> {
    this.clear();

    // Clear vector store if semantic caching is enabled
    if (this.semanticConfig.enabled && this.vectorStore) {
      try {
        await this.vectorStore.clear();
      } catch (error) {
        console.warn('Failed to clear vector store:', error);
      }
    }
  }

  /**
   * Why this cache is not persisting, or null when it is healthy.
   *
   * A degraded cache behaves exactly like a healthy one except that nothing
   * survives the process, so it is invisible from the outside. Anything that
   * reports on cache health has to ask.
   */
  getDegradedReason(): string | null {
    return this.degradedReason;
  }

  /** Where the database actually lives -- `:memory:` when degraded. */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_entries,
        SUM(hit_count) as total_hits,
        SUM(compressed_size) as total_compressed,
        SUM(original_size) as total_original
      FROM cache
    `);

    const row = stmt.get() as {
      total_entries: number;
      total_hits: number;
      total_compressed: number;
      total_original: number;
    };

    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;
    const compressionRatio =
      row.total_original > 0 ? row.total_compressed / row.total_original : 0;

    const totalHits = this.stats.hits + this.stats.semanticHits;
    const semanticHitRate =
      totalHits > 0 ? this.stats.semanticHits / totalHits : 0;

    return {
      totalEntries: row.total_entries,
      totalHits: row.total_hits || 0,
      totalMisses: this.stats.misses,
      hitRate,
      totalCompressedSize: row.total_compressed || 0,
      totalOriginalSize: row.total_original || 0,
      compressionRatio,
      semanticHits: this.stats.semanticHits,
      semanticHitRate,
    };
  }

  /**
   * Evict least recently used entries to stay under size limit
   */
  evictLRU(maxSizeBytes: number): number {
    // Get keys to keep (most recently used) using a running total
    const keysToKeep = this.db
      .prepare(
        `
      WITH ranked AS (
        SELECT
          key,
          compressed_size,
          SUM(compressed_size) OVER (ORDER BY last_accessed_at DESC, key ASC) as running_total
        FROM cache
      )
      SELECT key FROM ranked
      WHERE running_total <= ?
    `
      )
      .all(maxSizeBytes) as { key: string }[];

    if (keysToKeep.length === 0) {
      // If no keys fit in the limit, keep none and delete all
      const result = this.db.prepare('DELETE FROM cache').run();
      // Clear memory cache too
      this.memoryCache.clear();
      return result.changes;
    }

    // Delete entries not in the keep list
    const placeholders = keysToKeep.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      DELETE FROM cache WHERE key NOT IN (${placeholders})
    `);

    const result = stmt.run(...keysToKeep.map((k) => k.key));

    // Remove deleted entries from memory cache
    for (const key of Array.from(this.memoryCache.keys())) {
      if (!keysToKeep.some((k) => k.key === key)) {
        this.memoryCache.delete(key);
      }
    }

    return result.changes;
  }

  /**
   * Get all cache entries (for debugging/monitoring)
   */
  getAllEntries(): CacheEntry[] {
    const stmt = this.db.prepare(`
      SELECT
        key,
        value,
        compressed_size as compressedSize,
        original_size as originalSize,
        hit_count as hitCount,
        created_at as createdAt,
        last_accessed_at as lastAccessedAt
      FROM cache
      ORDER BY hit_count DESC, last_accessed_at DESC
    `);

    return stmt.all() as CacheEntry[];
  }

  /**
   * Update hit count and last accessed time
   */
  private updateHitCount(key: string): void {
    const stmt = this.db.prepare(`
      UPDATE cache
      SET hit_count = hit_count + 1, last_accessed_at = ?
      WHERE key = ?
    `);
    stmt.run(Date.now(), key);
  }

  /**
   * Get the database path currently in use
   */
  getDatabasePath(): string {
    return this.dbPath;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
