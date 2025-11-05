/**
 * Persistent storage for optimization results data using SQLite
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createGzip, gunzipSync } from 'zlib';
import { promisify } from 'util';

const gzip = promisify(createGzip);

export interface OptimizationResult {
  originalTextHash: string;
  optimizedText: Buffer;
  compressionAlgorithm: string;
}

/**
 * SQLite-backed optimization results storage
 */
export class SqliteOptimizationStorage {
  private db: Database.Database;

  constructor(dbPath?: string) {
    // Default to user's home directory
    const defaultPath = path.join(
      os.homedir(),
      '.token-optimizer-mcp',
      'optimization.db'
    );
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(finalPath);
    this.initializeDatabase();
  }

  /**
   * Initialize database schema
   */
  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS optimization_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_text_hash TEXT NOT NULL UNIQUE,
        optimized_text BLOB NOT NULL,
        compression_algorithm TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_original_text_hash ON optimization_results(original_text_hash);
    `);
  }

  /**
   * Save a single optimization result
   */
  async save(entry: OptimizationResult): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO optimization_results (
        original_text_hash, optimized_text, compression_algorithm
      ) VALUES (?, ?, ?)
    `);

    const compressedOptimizedText = await gzip(entry.optimizedText);

    stmt.run(
      entry.originalTextHash,
      compressedOptimizedText,
      'gzip'
    );
  }

  /**
   * Get an optimization result by hash
   */
  async get(originalTextHash: string): Promise<OptimizationResult | null> {
    const stmt = this.db.prepare('SELECT * FROM optimization_results WHERE original_text_hash = ?');
    const row = stmt.get(originalTextHash) as any;

    if (!row) {
      return null;
    }

    const decompressedOptimizedText = gunzipSync(row.optimized_text);

    return {
      originalTextHash: row.original_text_hash,
      optimizedText: decompressedOptimizedText,
      compressionAlgorithm: row.compression_algorithm,
    };
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    this.db.close();
  }
}
