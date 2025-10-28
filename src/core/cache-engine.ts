import Database from 'better-sqlite3';
import { LRUCache } from 'lru-cache';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { IEmbeddingGenerator } from '../interfaces/IEmbeddingGenerator.js';
import { IVectorStore } from '../interfaces/IVectorStore.js';

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
    const cacheDir = dbPath ? path.dirname(dbPath) : defaultCacheDir;

    // Ensure cache directory exists
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const finalDbPath = dbPath || path.join(cacheDir, 'cache.db');

    // Retry logic with up to 3 attempts
    let lastError = null;
    const maxAttempts = 3;
    let dbInitialized = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // First attempt: use requested path
        // Second attempt: try cleaning up corrupted files and retry
        // Third attempt: use backup location in temp directory
        const dbPathToUse =
          attempt === 3
            ? path.join(
                os.tmpdir(),
                `token-optimizer-cache-backup-${Date.now()}.db`
              )
            : finalDbPath;

        // If this is attempt 2, try to clean up corrupted files
        if (attempt === 2 && fs.existsSync(finalDbPath)) {
          try {
            fs.unlinkSync(finalDbPath);
            // Also remove WAL files
            const walPath = `${finalDbPath}-wal`;
            const shmPath = `${finalDbPath}-shm`;
            if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
            if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
          } catch (cleanupError) {
            // If we can't clean up, we'll try temp directory on next attempt
          }
        }

        this.db = new Database(dbPathToUse);
        this.db.pragma('journal_mode = WAL');

        // Create cache table if it doesn't exist
        this.db.exec(`
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
        `);

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
        } catch (closeError) {
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

    // If all attempts failed, throw a comprehensive error
    if (!dbInitialized) {
      throw new Error(
        `Failed to initialize cache database after ${maxAttempts} attempts. ` +
          `Last error: ${lastError?.message || 'Unknown error'}. ` +
          `Attempted paths: ${finalDbPath}, backup location. ` +
          `Please check disk space and file permissions.`
      );
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
      enabled: semanticConfig?.enabled ?? (embeddingGenerator !== undefined && vectorStore !== undefined),
    };
  }

  /**
   * Get a value from cache (synchronous, exact match only)
   * For backward compatibility, this method only performs exact key matching
   * Use getWithSemantic() for semantic similarity search
   */
  get(key: string): string | null {
    return this.getExact(key);
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
    if (this.semanticConfig.enabled && this.embeddingGenerator && this.vectorStore) {
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
    const queryEmbedding = await this.embeddingGenerator.generateEmbedding(query);

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
      console.log(`Semantic cache hit: query="${query}" matched key="${bestMatch.id}" (similarity: ${bestMatch.similarity.toFixed(3)})`);
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
    if (this.semanticConfig.enabled && this.embeddingGenerator && this.vectorStore) {
      try {
        const embedding = await this.embeddingGenerator.generateEmbedding(key);
        await this.vectorStore.add(key, embedding);
      } catch (error) {
        // Log error but don't fail the cache set operation
        console.warn('Failed to generate/store embedding for cache key:', error);
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
    const semanticHitRate = totalHits > 0 ? this.stats.semanticHits / totalHits : 0;

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
