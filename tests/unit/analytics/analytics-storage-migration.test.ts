import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAnalyticsStorage } from '../../../src/analytics/analytics-storage.js';
import { SAVINGS_MEASUREMENT_SCHEMA_VERSION } from '../../../src/analytics/savings-classification.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

const databases: string[] = [];

afterEach(() => {
  for (const dbPath of databases.splice(0)) {
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        fs.unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // The file may not exist on every SQLite journal mode.
      }
    }
  }
});

describe('analytics storage migration', () => {
  it('does not certify a legacy token claim when adding provenance columns', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `token-optimizer-legacy-${process.pid}-${Date.now()}.db`
    );
    databases.push(dbPath);

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE analytics (
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
      INSERT INTO analytics (
        hook_phase, tool_name, mcp_server, original_tokens,
        optimized_tokens, tokens_saved, timestamp
      ) VALUES (
        'Unknown', 'smart_grep', 'token-optimizer', 48000000,
        1000, 47999000, '2026-08-08T12:00:00.000Z'
      );
    `);
    legacy.close();

    const storage = new SqliteAnalyticsStorage(dbPath);
    try {
      await expect(storage.query()).resolves.toEqual([
        expect.objectContaining({
          toolName: 'smart_grep',
          tokensSaved: 47_999_000,
          savingsMeasured: false,
          measurementId: undefined,
        }),
      ]);
    } finally {
      await storage.close();
    }
  });
});

describe('the rollup table gains the measurement contract', () => {
  /** A store whose rollup table predates the version stamp. */
  function legacyRollupStore(): string {
    const dbPath = path.join(
      os.tmpdir(),
      `token-optimizer-rollup-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.db`
    );
    databases.push(dbPath);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE analytics_rollup (
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
        first_timestamp TEXT NOT NULL,
        last_timestamp TEXT NOT NULL,
        PRIMARY KEY (
          day, hook_phase, tool_name, mcp_server, client, client_version,
          model, model_version, provider, route, classification
        )
      );
      CREATE INDEX idx_rollup_day ON analytics_rollup(day);
      INSERT INTO analytics_rollup VALUES (
        '2026-09-01', 'none', 'smart_read', 'token-optimizer',
        'claude-code', '2.0.0', 'claude-opus-5', '', 'anthropic', 'direct',
        'verified-transport-reduction',
        7, 7, 4321, 9000, 9000, 4679, 4321, 7,
        0.12, 7, 0, 7, 0, 0, 9000, 4321, 0, 4679, 4679, 0.04, 7, 0,
        '2026-09-01T01:00:00.000Z', '2026-09-01T23:00:00.000Z'
      );
    `);
    legacy.close();
    return dbPath;
  }

  /**
   * A row recorded under the current contract, identical to the migrated day
   * in every key dimension but the stamp.
   */
  function newContractEntry(at = '2026-09-01T12:00:00'): AnalyticsEntry {
    const id = 'b7c1d2e3-0000-4000-8000-00000000000a';
    return {
      // A LOCAL DATETIME, no `Z`: the fold keys on the local day, so a UTC
      // instant would land on 2026-08-31 west of Greenwich.
      timestamp: new Date(at).toISOString(),
      hookPhase: 'none',
      toolName: 'smart_read',
      mcpServer: 'token-optimizer',
      client: 'claude-code',
      clientVersion: '2.0.0',
      model: 'claude-opus-5',
      modelVersion: '',
      originalTokens: 1000,
      optimizedTokens: 400,
      tokensSaved: 600,
      savingsMeasured: true,
      measurementId: id,
      metadata: {
        provider: 'anthropic',
        route: 'direct',
        measurementId: id,
        measurementSchemaVersion: SAVINGS_MEASUREMENT_SCHEMA_VERSION,
        measurement: 'materialized-transport-before-after',
        measurementClass: 'verified-transport-reduction',
        baselineKind: 'materialized-undisclosed-mcp-result',
        baselineBytes: 4000,
        returnedBytes: 1600,
        bytesSaved: 2400,
        baselineSha256: 'a'.repeat(64),
        returnedSha256: 'b'.repeat(64),
        disclosureRef: 'abcdef0123456789',
      },
    } as unknown as AnalyticsEntry;
  }

  it('keeps the folded day, labelled as coming from an older contract', async () => {
    /*
     * A FOLDED DAY CANNOT BE RE-DERIVED. Its rows were pruned, so the only
     * options are to carry the totals forward or to lose them -- and carrying
     * them forward unlabelled would sum two measurement contracts into one
     * figure that belongs to neither. Version 0 is that label.
     */
    const storage = new SqliteAnalyticsStorage(legacyRollupStore());
    const rollups = await storage.getRollups();
    await storage.close();

    expect(rollups).toHaveLength(1);
    expect(rollups[0].tokensSaved).toBe(4321);
    expect(rollups[0].operations).toBe(7);
    expect(rollups[0].measurementSchemaVersion).toBe(0);
    // The columns that did not exist when the row was written read as zero
    // rather than as a figure nobody measured.
    expect(rollups[0].inputDisplacementTokens).toBe(0);
    expect(rollups[0].displacementOperations).toBe(0);
  });

  it('does not fold a new contract into the old day it migrated', async () => {
    /*
     * THE POINT OF PUTTING THE STAMP IN THE KEY. Everything else about these
     * two groups is identical -- same day, tool, server, client, model, route
     * and classification -- so under the old key the new row would have been
     * added straight onto the migrated total, and the break would have been
     * invisible in the one figure a reader actually sees.
     *
     * The new row arrives the way every real row does: recorded, then folded
     * by the retention prune. Nothing writes a rollup directly.
     */
    // THE CLOCK IS INJECTED, so the automatic post-write prune and the
    // explicit one below agree on what "now" is. Without it the store's
    // after-write prune read the WALL clock and folded this 2026-09-01 fixture
    // the moment the real date passed the retention window, leaving the
    // explicit prune nothing to do and returning 0 -- which is how this test
    // started failing on four Node shards about a month after it was written,
    // for a reason unrelated to folding.
    // TWO DIFFERENT NOWS, because that is what the premise needs: the row is
    // recorded while it is still FRESH, and folded later by the retention
    // prune. The store prunes after a write, so a clock already past the
    // retention window folds the row during `save` and leaves the explicit
    // prune nothing to count -- which is why this returned 0.
    //
    // The injected clock sits a day after the entry, so housekeeping correctly
    // leaves it alone; the explicit prune then runs at 2027 and folds it.
    const storage = new SqliteAnalyticsStorage(
      legacyRollupStore(),
      () => new Date(2026, 8, 2, 12)
    );
    await storage.save(newContractEntry());
    const folded = await storage.pruneOldEntries(new Date(2027, 0, 1, 12));
    const rollups = await storage.getRollups();
    await storage.close();

    expect(folded).toBe(1);
    expect(rollups).toHaveLength(2);
    const byVersion = new Map(
      rollups.map((row) => [row.measurementSchemaVersion, row])
    );
    // The migrated day keeps every figure it was folded with ...
    expect(byVersion.get(0)?.tokensSaved).toBe(4321);
    expect(byVersion.get(0)?.operations).toBe(7);
    // ... and the new contract's day is its own row, not an addend of it.
    // THE STAMP IS THE ONLY DIMENSION THAT SEPARATES THEM, asserted rather
    // than assumed: if the new row classified differently the two rows would
    // have split anyway and this test would prove nothing about the stamp.
    expect(
      byVersion.get(SAVINGS_MEASUREMENT_SCHEMA_VERSION)?.classification
    ).toBe('verified-transport-reduction');
    expect(byVersion.get(SAVINGS_MEASUREMENT_SCHEMA_VERSION)?.toolName).toBe(
      byVersion.get(0)?.toolName
    );
    expect(byVersion.get(SAVINGS_MEASUREMENT_SCHEMA_VERSION)?.day).toBe(
      byVersion.get(0)?.day
    );
    expect(byVersion.get(SAVINGS_MEASUREMENT_SCHEMA_VERSION)?.tokensSaved).toBe(
      600
    );
    expect(byVersion.get(SAVINGS_MEASUREMENT_SCHEMA_VERSION)?.operations).toBe(
      1
    );
  });

  it('folds a second row of the same contract onto the same day', async () => {
    /*
     * THE POSITIVE CONTROL for the test above. A key dimension that separated
     * everything would pass that test while making the fold useless, so two
     * rows that agree on the stamp have to still land on one row.
     */
    const storage = new SqliteAnalyticsStorage(legacyRollupStore());
    await storage.save(newContractEntry());
    await storage.save(newContractEntry('2026-09-01T15:00:00'));
    await storage.pruneOldEntries(new Date(2027, 0, 1, 12));
    const rollups = await storage.getRollups();
    await storage.close();

    expect(rollups).toHaveLength(2);
    const current = rollups.find(
      (row) =>
        row.measurementSchemaVersion === SAVINGS_MEASUREMENT_SCHEMA_VERSION
    );
    expect(current?.operations).toBe(2);
    expect(current?.tokensSaved).toBe(1200);
  });
});
