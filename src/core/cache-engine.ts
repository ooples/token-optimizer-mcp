import Database from 'better-sqlite3';
import { LRUCache } from 'lru-cache';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
}

export class CacheEngine {
  private db: Database.Database;
  private memoryCache: LRUCache<string, string>;
  private stats = {
    hits: 0,
    misses: 0,
  };

  constructor(
    dbPath?: string,
    maxMemoryItems: number = 1000
  ) {
    // Use user-provided path or default to ~/.token-optimizer-cache
    const cacheDir = dbPath
      ? path.dirname(dbPath)
      : path.join(os.homedir(), '.token-optimizer-cache');

    // Ensure cache directory exists
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const fullDbPath = dbPath || path.join(cacheDir, 'cache.db');

    // Initialize SQLite database
    this.db = new Database(fullDbPath);
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency

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

    // Initialize in-memory LRU cache for frequently accessed items
    this.memoryCache = new LRUCache<string, string>({
      max: maxMemoryItems,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    });
  }

  /**
   * Get a value from cache
   */
  get(key: string): string | null {
    // Check memory cache first
    const memValue = this.memoryCache.get(key);
    if (memValue !== undefined) {
      this.stats.hits++;
      this.updateHitCount(key);
      return memValue;
    }

    // Check SQLite cache
    const stmt = this.db.prepare(`
      SELECT value, hit_count FROM cache WHERE key = ?
    `);
    const row = stmt.get(key) as { value: string; hit_count: number } | undefined;

    if (row) {
      this.stats.hits++;
      // Update hit count and last accessed time
      this.updateHitCount(key);
      // Add to memory cache for faster access
      this.memoryCache.set(key, row.value);
      return row.value;
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set a value in cache
   */
  set(key: string, value: string, originalSize: number, compressedSize: number): void {
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
    this.memoryCache.set(key, value);
  }

  /**
   * Delete a value from cache
   */
  delete(key: string): boolean {
    this.memoryCache.delete(key);
    const stmt = this.db.prepare('DELETE FROM cache WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.memoryCache.clear();
    this.db.exec('DELETE FROM cache');
    this.stats.hits = 0;
    this.stats.misses = 0;
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

    return {
      totalEntries: row.total_entries,
      totalHits: row.total_hits || 0,
      totalMisses: this.stats.misses,
      hitRate,
      totalCompressedSize: row.total_compressed || 0,
      totalOriginalSize: row.total_original || 0,
      compressionRatio,
    };
  }

  /**
   * Evict least recently used entries to stay under size limit
   */
  evictLRU(maxSizeBytes: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM cache
      WHERE key IN (
        SELECT key FROM cache
        ORDER BY last_accessed_at ASC
        LIMIT (
          SELECT COUNT(*) FROM cache
        ) - (
          SELECT COUNT(*) FROM (
            SELECT key, SUM(compressed_size) OVER (ORDER BY last_accessed_at DESC) as running_total
            FROM cache
            WHERE running_total <= ?
          )
        )
      )
    `);

    const result = stmt.run(maxSizeBytes);
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
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
