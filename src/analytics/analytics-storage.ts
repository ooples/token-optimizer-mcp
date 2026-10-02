/**
 * Persistent storage for analytics data using SQLite
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { AnalyticsEntry, AnalyticsStorage } from './analytics-types.js';
import {
  foldEntries,
  localDayOf,
  type AnalyticsRollup,
} from './analytics-rollup.js';
import { retentionDays } from '../savings/retention.js';
import { localDayKey, startOfLocalDay } from '../savings/windows.js';
import {
  registerDatabaseOwner,
  unregisterDatabaseOwner,
} from '../core/database-registry.js';

/**
 * SQLite-backed analytics storage
 */
export class SqliteAnalyticsStorage implements AnalyticsStorage {
  private db: Database.Database;
  private batchQueue: AnalyticsEntry[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 100;
  private readonly BATCH_DELAY_MS = 5000; // 5 seconds
  private sinceLastPrune = 0;
  private prunedOnce = false;
  private pruning = false;
  private readonly PRUNE_EVERY_SAVES = 64;

  constructor(dbPath?: string) {
    // Default to user's home directory
    const defaultPath = path.join(
      os.homedir(),
      '.token-optimizer-mcp',
      'analytics.db'
    );
    const finalPath =
      dbPath || process.env.TOKEN_OPTIMIZER_ANALYTICS_DB || defaultPath;

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
  /**
   * Column names an existing table has, or none if it does not exist.
   */
  private columnsOf(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((row) => row.name));
  }

  /**
   * Moves an old-shaped rollup table aside so the creator below can build the
   * current one, and returns the columns it held.
   *
   * RENAME RATHER THAN A SECOND DDL. The measurement contract a row was
   * recorded under became part of the fold key, and SQLite cannot add a column
   * to an existing primary key -- the table has to be rebuilt. Renaming it out
   * of the way first means the rebuild uses the one `CREATE TABLE` statement
   * this file already has, instead of a copy of that shape kept in step by
   * hand, which is how a migrated store ends up subtly unlike a fresh one.
   */
  private setAsideOldRollup(): Set<string> | null {
    const existing = this.columnsOf('analytics_rollup');
    if (existing.size === 0) return null;
    if (existing.has('measurement_schema_version')) return null;
    this.db.exec(
      `DROP TABLE IF EXISTS analytics_rollup_old;
       ALTER TABLE analytics_rollup RENAME TO analytics_rollup_old;`
    );
    return existing;
  }

  /**
   * Copies the set-aside rows into the rebuilt table and drops the old one.
   *
   * The rows carry no stamp, so they land under version 0 -- which is the
   * label, not a default. A folded day cannot be re-derived, so a row written
   * before the stamp existed can only ever say "an older contract produced
   * this", and that is what a reader needs it to say.
   */
  private restoreOldRollup(columns: Set<string> | null): void {
    if (columns === null) return;
    const carried = [...this.columnsOf('analytics_rollup')].filter((name) =>
      columns.has(name)
    );
    const names = carried.join(', ');
    this.db.exec(
      `INSERT INTO analytics_rollup (${names})
         SELECT ${names} FROM analytics_rollup_old;
       DROP TABLE analytics_rollup_old;
       CREATE INDEX IF NOT EXISTS idx_rollup_day ON analytics_rollup(day);`
    );
  }

  private initializeDatabase(): void {
    // BEFORE THE CREATOR RUNS, because `IF NOT EXISTS` is silent about a table
    // that exists in an older shape.
    const oldRollup = this.setAsideOldRollup();
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

      -- ONE ROW PER LOCAL DAY PER GROUP, holding what that group's rows
      -- contributed to every figure the readers compute. The rows themselves
      -- are deleted in the same transaction that writes this, so a figure is
      -- never counted twice and never dropped.
      CREATE TABLE IF NOT EXISTS analytics_rollup (
        day TEXT NOT NULL,
        hook_phase TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        mcp_server TEXT NOT NULL,
        client TEXT NOT NULL,
        client_version TEXT NOT NULL,
        model TEXT NOT NULL,
        model_version TEXT NOT NULL,
        provider TEXT NOT NULL,
        route TEXT NOT NULL,
        classification TEXT NOT NULL,
        measurement_schema_version INTEGER NOT NULL DEFAULT 0,
        operations INTEGER NOT NULL,
        eligible_operations INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        tokens_before INTEGER NOT NULL,
        original_tokens INTEGER NOT NULL,
        optimized_tokens INTEGER NOT NULL,
        reported_savings INTEGER NOT NULL,
        observed_returns INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        priced_operations INTEGER NOT NULL,
        unpriced_operations INTEGER NOT NULL,
        verified_operations INTEGER NOT NULL,
        expansion_operations INTEGER NOT NULL,
        unverified_operations INTEGER NOT NULL,
        verified_original_tokens INTEGER NOT NULL,
        verified_reported_savings INTEGER NOT NULL,
        expansion_optimized_tokens INTEGER NOT NULL,
        observed_optimized_tokens INTEGER NOT NULL,
        measured_optimized_tokens INTEGER NOT NULL,
        context_usd REAL NOT NULL,
        priced_context_operations INTEGER NOT NULL,
        unverified_reported_savings INTEGER NOT NULL,
        input_displacement_tokens INTEGER NOT NULL DEFAULT 0,
        displacement_operations INTEGER NOT NULL DEFAULT 0,
        first_timestamp TEXT NOT NULL,
        last_timestamp TEXT NOT NULL,
        PRIMARY KEY (
          day, hook_phase, tool_name, mcp_server, client, client_version,
          model, model_version, provider, route, classification,
          measurement_schema_version
        )
      );

      CREATE INDEX IF NOT EXISTS idx_rollup_day ON analytics_rollup(day);
    `);
    this.restoreOldRollup(oldRollup);

    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(analytics)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );
    for (const [name, definition] of [
      ['client', 'TEXT'],
      ['client_version', 'TEXT'],
      ['model', 'TEXT'],
      ['model_version', 'TEXT'],
      ['measurement_id', 'TEXT'],
      // A pre-existing row has no provenance proving that its two token fields
      // are comparable. Defaulting this column to true silently certified every
      // historical estimate during migration. New writers opt in explicitly.
      ['savings_measured', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE analytics ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_client ON analytics(client);
      CREATE INDEX IF NOT EXISTS idx_model ON analytics(model);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_id
        ON analytics(measurement_id)
        WHERE measurement_id LIKE 'mcp:%';
    `);

    // LAST, so a constructor that threw never leaves a half-built owner in the registry.
    registerDatabaseOwner(this);
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
        timestamp, session_id, metadata,
        client, client_version, model, model_version, savings_measured,
        measurement_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
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
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.client || null,
          entry.clientVersion || null,
          entry.model || null,
          entry.modelVersion || null,
          entry.savingsMeasured === true ? 1 : 0,
          entry.measurementId || null
        );
      }
    });

    insertMany(entries);
    await this.maybePrune();
  }

  /**
   * Folds whatever has aged out, occasionally.
   *
   * IT RUNS AFTER A WRITE, which is the only moment the store is known to be
   * growing. A prune on a schedule would wake a process that had nothing to do;
   * a prune on every write would read the oldest batch on every write.
   *
   * THE FIRST WRITE ALWAYS CHECKS, so a database that grew under an older build
   * -- or under a process that exits long before it reaches a counter -- is
   * actually bounded rather than bounded in principle.
   *
   * RE-ENTRANT ON PURPOSE-PROOF: the prune flushes before it reads, and that
   * flush can land here again. The flag makes the inner call a no-op instead of
   * a recursion.
   */
  private async maybePrune(): Promise<void> {
    if (this.pruning) return;
    const next = this.sinceLastPrune + 1;
    if (this.prunedOnce && next < this.PRUNE_EVERY_SAVES) {
      this.sinceLastPrune = next;
      return;
    }
    this.pruning = true;
    this.sinceLastPrune = 0;
    this.prunedOnce = true;
    try {
      await this.pruneOldEntries();
    } catch (error) {
      // A store that cannot be pruned is a store that grows, which costs a
      // disk; it is not worth failing the write that reported the savings.
      console.error('Failed to prune analytics entries:', error);
    } finally {
      this.pruning = false;
    }
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

    const result = this.db
      .prepare('SELECT COUNT(*) as count FROM analytics')
      .get() as { count: number };
    return result.count;
  }

  /**
   * Folds every row older than the report's window into per-day totals.
   *
   * ONE TRANSACTION, WHICH IS WHY THERE IS NO CRASH WINDOW HERE. The upsert
   * and the delete land together or neither lands, so unlike a file rewrite
   * there is no state where a day is both rows and a total. Nothing in the
   * readers has to resolve a half-done prune.
   *
   * IN BATCHES, because the alternative is reading a year of rows into memory
   * to save a disk. Each batch folds, merges and deletes the same ids it read,
   * so a batch that fails leaves the rows it had not reached untouched.
   */
  async pruneOldEntries(now: Date = new Date()): Promise<number> {
    await this.flushBatch();
    const cutoff = startOfLocalDay(now);
    cutoff.setDate(cutoff.getDate() - retentionDays(now));
    // THE CUTOFF IS A LOCAL DAY KEY, compared against each row's own local
    // day, because that is the grain the fold stores and the windows read. A
    // comparison against an instant would fold part of a local day and leave
    // the rest, which is the one thing that makes a day-grain total inexact.
    const cutoffDay = localDayKey(cutoff);
    const select = this.db.prepare(
      `SELECT * FROM analytics ORDER BY timestamp ASC LIMIT ?`
    );
    const remove = this.db.prepare(`DELETE FROM analytics WHERE id = ?`);
    const upsert = this.db.prepare(UPSERT_ROLLUP);
    let folded = 0;
    for (;;) {
      const rows = select.all(PRUNE_BATCH_ROWS) as Array<
        Record<string, unknown>
      >;
      const old = rows.filter((row) => {
        const day = localDayOf(String(row.timestamp));
        return day !== null && day < cutoffDay;
      });
      if (old.length === 0) return folded;
      const entries = this.rowsToEntries(old);
      const rollups = foldEntries(entries);
      this.db.transaction(() => {
        for (const rollup of rollups) upsert.run(rollupParams(rollup));
        for (const row of old) remove.run(row.id);
      })();
      folded += old.length;
      // EVERY ROW IN THE BATCH WAS OLD, so there may be more behind it; a
      // batch that was only partly old has reached the window and is done.
      if (old.length < rows.length) return folded;
    }
  }

  /** Days already folded into totals. */
  async getRollups(): Promise<readonly AnalyticsRollup[]> {
    await this.flushBatch();
    const rows = this.db
      .prepare(`SELECT * FROM analytics_rollup ORDER BY day ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => rollupOf(row));
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
      client: row.client || undefined,
      clientVersion: row.client_version || undefined,
      model: row.model || undefined,
      modelVersion: row.model_version || undefined,
      savingsMeasured: row.savings_measured !== 0,
      measurementId: row.measurement_id || undefined,
    }));
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    unregisterDatabaseOwner(this);

    // Flush any pending writes
    if (this.batchQueue.length > 0) {
      await this.saveBatch(this.batchQueue);
      this.batchQueue = [];
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    this.db.close();
  }
}

/**
 * Rows folded per pass.
 *
 * BOUNDED SO THE FOLD IS NOT ITSELF A MEMORY PROBLEM: a database that has gone
 * a year without a prune holds more rows than anyone wants resident, and the
 * point of the pass is to make the store smaller, not to need it large first.
 */
const PRUNE_BATCH_ROWS = 2000;

/**
 * Merges a folded group into whatever is already stored for it.
 *
 * ADDITION, NOT REPLACEMENT. A second prune of the same day -- which is what a
 * row that arrived late produces -- has to add to the day's totals; writing
 * over them would silently discard the first prune's work.
 */
const UPSERT_ROLLUP = `
  INSERT INTO analytics_rollup (
    day, hook_phase, tool_name, mcp_server, client, client_version,
    model, model_version, provider, route, classification,
    measurement_schema_version,
    operations, eligible_operations, tokens_saved, tokens_before,
    original_tokens, optimized_tokens, reported_savings, observed_returns,
    cost_usd, priced_operations, unpriced_operations,
    verified_operations, expansion_operations, unverified_operations, verified_original_tokens, verified_reported_savings, expansion_optimized_tokens, observed_optimized_tokens, measured_optimized_tokens, context_usd, priced_context_operations, unverified_reported_savings,
    input_displacement_tokens, displacement_operations,
    first_timestamp, last_timestamp
  ) VALUES (
    @day, @hookPhase, @toolName, @mcpServer, @client, @clientVersion,
    @model, @modelVersion, @provider, @route, @classification,
    @measurementSchemaVersion,
    @operations, @eligibleOperations, @tokensSaved, @tokensBefore,
    @originalTokens, @optimizedTokens, @reportedSavings, @observedReturns,
    @costUsd, @pricedOperations, @unpricedOperations,
    @verifiedOperations, @expansionOperations, @unverifiedOperations, @verifiedOriginalTokens, @verifiedReportedSavings, @expansionOptimizedTokens, @observedOptimizedTokens, @measuredOptimizedTokens, @contextUsd, @pricedContextOperations, @unverifiedReportedSavings,
    @inputDisplacementTokens, @displacementOperations,
    @firstTimestamp, @lastTimestamp
  )
  ON CONFLICT (
    day, hook_phase, tool_name, mcp_server, client, client_version,
    model, model_version, provider, route, classification,
    measurement_schema_version
  ) DO UPDATE SET
    operations = operations + excluded.operations,
    eligible_operations = eligible_operations + excluded.eligible_operations,
    tokens_saved = tokens_saved + excluded.tokens_saved,
    tokens_before = tokens_before + excluded.tokens_before,
    original_tokens = original_tokens + excluded.original_tokens,
    optimized_tokens = optimized_tokens + excluded.optimized_tokens,
    reported_savings = reported_savings + excluded.reported_savings,
    observed_returns = observed_returns + excluded.observed_returns,
    cost_usd = cost_usd + excluded.cost_usd,
    priced_operations = priced_operations + excluded.priced_operations,
    unpriced_operations = unpriced_operations + excluded.unpriced_operations,
    verified_operations = verified_operations + excluded.verified_operations,
    expansion_operations = expansion_operations + excluded.expansion_operations,
    unverified_operations = unverified_operations + excluded.unverified_operations,
    verified_original_tokens = verified_original_tokens + excluded.verified_original_tokens,
    verified_reported_savings = verified_reported_savings + excluded.verified_reported_savings,
    expansion_optimized_tokens = expansion_optimized_tokens + excluded.expansion_optimized_tokens,
    observed_optimized_tokens = observed_optimized_tokens + excluded.observed_optimized_tokens,
    measured_optimized_tokens = measured_optimized_tokens + excluded.measured_optimized_tokens,
    context_usd = context_usd + excluded.context_usd,
    priced_context_operations = priced_context_operations + excluded.priced_context_operations,
    unverified_reported_savings = unverified_reported_savings + excluded.unverified_reported_savings,
    input_displacement_tokens = input_displacement_tokens + excluded.input_displacement_tokens,
    displacement_operations = displacement_operations + excluded.displacement_operations,
    first_timestamp = MIN(first_timestamp, excluded.first_timestamp),
    last_timestamp = MAX(last_timestamp, excluded.last_timestamp)
`;

/** The bound parameters for one folded group. */
function rollupParams(rollup: AnalyticsRollup): Record<string, unknown> {
  return {
    day: rollup.day,
    hookPhase: rollup.hookPhase,
    toolName: rollup.toolName,
    mcpServer: rollup.mcpServer,
    client: rollup.client,
    clientVersion: rollup.clientVersion,
    model: rollup.model,
    modelVersion: rollup.modelVersion,
    provider: rollup.provider,
    route: rollup.route,
    classification: rollup.classification,
    measurementSchemaVersion: rollup.measurementSchemaVersion,
    operations: rollup.operations,
    eligibleOperations: rollup.eligibleOperations,
    tokensSaved: rollup.tokensSaved,
    tokensBefore: rollup.tokensBefore,
    originalTokens: rollup.originalTokens,
    optimizedTokens: rollup.optimizedTokens,
    reportedSavings: rollup.reportedSavings,
    observedReturns: rollup.observedReturns,
    costUsd: rollup.costUsd,
    pricedOperations: rollup.pricedOperations,
    unpricedOperations: rollup.unpricedOperations,
    verifiedOperations: rollup.verifiedOperations,
    expansionOperations: rollup.expansionOperations,
    unverifiedOperations: rollup.unverifiedOperations,
    verifiedOriginalTokens: rollup.verifiedOriginalTokens,
    verifiedReportedSavings: rollup.verifiedReportedSavings,
    expansionOptimizedTokens: rollup.expansionOptimizedTokens,
    observedOptimizedTokens: rollup.observedOptimizedTokens,
    measuredOptimizedTokens: rollup.measuredOptimizedTokens,
    contextUsd: rollup.contextUsd,
    pricedContextOperations: rollup.pricedContextOperations,
    unverifiedReportedSavings: rollup.unverifiedReportedSavings,
    inputDisplacementTokens: rollup.inputDisplacementTokens,
    displacementOperations: rollup.displacementOperations,
    firstTimestamp: rollup.firstTimestamp,
    lastTimestamp: rollup.lastTimestamp,
  };
}

/** One stored row back as a rollup. */
function rollupOf(row: Record<string, unknown>): AnalyticsRollup {
  const count = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    day: String(row.day),
    hookPhase: String(row.hook_phase),
    toolName: String(row.tool_name),
    mcpServer: String(row.mcp_server),
    client: String(row.client),
    clientVersion: String(row.client_version),
    model: String(row.model),
    modelVersion: String(row.model_version),
    provider: String(row.provider),
    route: String(row.route),
    // A CLASS THIS BUILD DOES NOT KNOW stays as written rather than being
    // mapped onto one it does: the figures beside it were computed under the
    // class the row names, and renaming it would attach them to a gate they
    // never passed.
    classification: String(
      row.classification
    ) as AnalyticsRollup['classification'],
    // 0 FOR A ROW FOLDED BEFORE THE STAMP EXISTED, which is what marks the
    // break rather than hiding it: such a row is labelled as coming from an
    // older contract instead of being counted as if it came from this one.
    measurementSchemaVersion: count(row.measurement_schema_version),
    operations: count(row.operations),
    eligibleOperations: count(row.eligible_operations),
    tokensSaved: count(row.tokens_saved),
    tokensBefore: count(row.tokens_before),
    originalTokens: count(row.original_tokens),
    optimizedTokens: count(row.optimized_tokens),
    reportedSavings: count(row.reported_savings),
    observedReturns: count(row.observed_returns),
    costUsd: count(row.cost_usd),
    pricedOperations: count(row.priced_operations),
    unpricedOperations: count(row.unpriced_operations),
    verifiedOperations: count(row.verified_operations),
    expansionOperations: count(row.expansion_operations),
    unverifiedOperations: count(row.unverified_operations),
    verifiedOriginalTokens: count(row.verified_original_tokens),
    verifiedReportedSavings: count(row.verified_reported_savings),
    expansionOptimizedTokens: count(row.expansion_optimized_tokens),
    observedOptimizedTokens: count(row.observed_optimized_tokens),
    measuredOptimizedTokens: count(row.measured_optimized_tokens),
    contextUsd: count(row.context_usd),
    pricedContextOperations: count(row.priced_context_operations),
    unverifiedReportedSavings: count(row.unverified_reported_savings),
    inputDisplacementTokens: count(row.input_displacement_tokens),
    displacementOperations: count(row.displacement_operations),
    firstTimestamp: String(row.first_timestamp),
    lastTimestamp: String(row.last_timestamp),
  };
}
