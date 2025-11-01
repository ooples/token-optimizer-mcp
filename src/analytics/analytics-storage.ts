/**
 * Persistent storage for analytics data using SQLite
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type {
  AnalyticsEntry,
  AnalyticsStorage,
} from './analytics-types.js';

/**
 * SQLite-backed analytics storage
 */
export class SqliteAnalyticsStorage implements AnalyticsStorage {
  private db: Database.Database;
  private batchQueue: AnalyticsEntry[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 100;
  private readonly BATCH_DELAY_MS = 5000; // 5 seconds

  constructor(dbPath?: string) {
    // Default to user's home directory
    const defaultPath = path.join(
      os.homedir(),
      '.token-optimizer-mcp',
      'analytics.db'
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
      CREATE TABLE IF NOT EXISTS analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hook_phase TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        mcp_server TEXT NOT NULL,
        original_tokens INTEGER NOT NULL,
        optimized_tokens INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        session_id TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_hook_phase ON analytics(hook_phase);
      CREATE INDEX IF NOT EXISTS idx_tool_name ON analytics(tool_name);
      CREATE INDEX IF NOT EXISTS idx_mcp_server ON analytics(mcp_server);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON analytics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_session_id ON analytics(session_id);
    `);
  }

  /**
   * Save a single analytics entry (batched for performance)
   */
  async save(entry: AnalyticsEntry): Promise<void> {
    this.batchQueue.push(entry);

    // Flush immediately if batch size reached
    if (this.batchQueue.length >= this.BATCH_SIZE) {
      await this.flushBatch();
    } else {
      // Otherwise, schedule a delayed flush
      this.scheduleBatchFlush();
    }
  }

  /**
   * Save multiple analytics entries in a single transaction
   */
  async saveBatch(entries: AnalyticsEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO analytics (
        hook_phase, tool_name, mcp_server,
        original_tokens, optimized_tokens, tokens_saved,
        timestamp, session_id, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((entries: AnalyticsEntry[]) => {
      for (const entry of entries) {
        stmt.run(
          entry.hookPhase,
          entry.toolName,
          entry.mcpServer,
          entry.originalTokens,
          entry.optimizedTokens,
          entry.tokensSaved,
          entry.timestamp,
          entry.sessionId || null,
          entry.metadata ? JSON.stringify(entry.metadata) : null
        );
      }
    });

    insertMany(entries);
  }

  /**
   * Schedule a delayed batch flush
   */
  private scheduleBatchFlush(): void {
    if (this.batchTimer) {
      return; // Timer already scheduled
    }

    this.batchTimer = setTimeout(() => {
      void this.flushBatch().catch((err) => {
        console.error('Failed to flush analytics batch:', err);
      });
    }, this.BATCH_DELAY_MS);
  }

  /**
   * Flush the current batch to database
   */
  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batchQueue.length === 0) {
      return;
    }

    const entries = [...this.batchQueue];
    this.batchQueue = [];

    await this.saveBatch(entries);
  }

  /**
   * Query analytics entries with optional filters
   */
  async query(filters?: Partial<AnalyticsEntry>): Promise<AnalyticsEntry[]> {
    // Ensure any pending writes are flushed
    await this.flushBatch();

    let sql = 'SELECT * FROM analytics WHERE 1=1';
    const params: any[] = [];

    if (filters) {
      if (filters.hookPhase) {
        sql += ' AND hook_phase = ?';
        params.push(filters.hookPhase);
      }
      if (filters.toolName) {
        sql += ' AND tool_name = ?';
        params.push(filters.toolName);
      }
      if (filters.mcpServer) {
        sql += ' AND mcp_server = ?';
        params.push(filters.mcpServer);
      }
      if (filters.sessionId) {
        sql += ' AND session_id = ?';
        params.push(filters.sessionId);
      }
    }

    sql += ' ORDER BY timestamp DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return this.rowsToEntries(rows);
  }

  /**
   * Get all entries within a date range
   */
  async queryByDateRange(
    startDate: string,
    endDate: string
  ): Promise<AnalyticsEntry[]> {
    // Ensure any pending writes are flushed
    await this.flushBatch();

    const sql = `
      SELECT * FROM analytics
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC
    `;

    const rows = this.db.prepare(sql).all(startDate, endDate) as any[];
    return this.rowsToEntries(rows);
  }

  /**
   * Clear all analytics data
   */
  async clear(): Promise<void> {
    // Flush any pending writes first
    await this.flushBatch();

    this.db.prepare('DELETE FROM analytics').run();
  }

  /**
   * Get total count of stored entries
   */
  async count(): Promise<number> {
    // Ensure any pending writes are flushed
    await this.flushBatch();

    const result = this.db.prepare('SELECT COUNT(*) as count FROM analytics').get() as { count: number };
    return result.count;
  }

  /**
   * Convert database rows to AnalyticsEntry objects
   */
  private rowsToEntries(rows: any[]): AnalyticsEntry[] {
    return rows.map((row) => ({
      hookPhase: row.hook_phase,
      toolName: row.tool_name,
      mcpServer: row.mcp_server,
      originalTokens: row.original_tokens,
      optimizedTokens: row.optimized_tokens,
      tokensSaved: row.tokens_saved,
      timestamp: row.timestamp,
      sessionId: row.session_id || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /**
   * Close the database connection
   */
  close(): void {
    // Flush any pending writes
    if (this.batchQueue.length > 0) {
      this.saveBatch(this.batchQueue);
      this.batchQueue = [];
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    this.db.close();
  }
}
