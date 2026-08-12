import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAnalyticsStorage } from '../../../src/analytics/analytics-storage.js';

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
