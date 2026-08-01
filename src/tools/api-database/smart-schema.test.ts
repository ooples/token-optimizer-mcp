/**
 * Unit Tests for Smart Schema Tool
 * Testing import corrections and core functionality
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
} from '@jest/globals';
import { SmartSchema, getSmartSchema, runSmartSchema } from './smart-schema.js';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

/** A real SQLite database with two tables, for tests that need one. */
async function sqliteFixture(): Promise<{ file: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'schema-fixture-'));
  const file = join(dir, 'fixture.db');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);');
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);');
  db.close();
  return {
    file,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows */
      }
    },
  };
}

describe('Smart Schema - Import Type Corrections', () => {
  /*
   * One real database, shared by the tests that only care about caching
   * behaviour rather than about a particular engine.
   */
  let sharedSqlite: string;
  let sharedCleanup: () => void = () => {};

  beforeAll(async () => {
    const fixture = await sqliteFixture();
    sharedSqlite = `sqlite:${fixture.file}`;
    sharedCleanup = fixture.cleanup;
  });

  afterAll(() => sharedCleanup());

  let cacheEngine: CacheEngine;
  let tokenCounter: TokenCounter;
  let metricsCollector: MetricsCollector;
  let smartSchema: SmartSchema;

  beforeEach(() => {
    // Initialize dependencies - verifying that imports work as values
    cacheEngine = new CacheEngine(
      join(tmpdir(), '.test-schema-cache', 'test.db'),
      100
    );
    // Clear cache before each test to ensure fresh results
    cacheEngine.clear();
    tokenCounter = new TokenCounter();
    metricsCollector = new MetricsCollector();
    smartSchema = new SmartSchema(cacheEngine, tokenCounter, metricsCollector);
  });

  describe('Class Instantiation', () => {
    it('should instantiate SmartSchema with TokenCounter as value', () => {
      expect(smartSchema).toBeInstanceOf(SmartSchema);
      expect(tokenCounter).toBeInstanceOf(TokenCounter);
    });

    it('should instantiate SmartSchema with MetricsCollector as value', () => {
      expect(metricsCollector).toBeInstanceOf(MetricsCollector);
    });

    it('should instantiate SmartSchema with CacheEngine as value', () => {
      expect(cacheEngine).toBeInstanceOf(CacheEngine);
    });
  });

  describe('Factory Function', () => {
    it('should create SmartSchema instance via factory function', () => {
      const instance = getSmartSchema(
        cacheEngine,
        tokenCounter,
        metricsCollector
      );
      expect(instance).toBeInstanceOf(SmartSchema);
    });
  });

  describe('Schema Introspection', () => {
    /*
     * These used to assert that pointing at a MADE-UP PostgreSQL connection
     * string returned a schema. It did -- an invented one: ten tables named
     * table_1..table_10, five invented columns each, fifteen invented indexes,
     * version "15.0". The tests passed because they asserted the fabrication.
     *
     * A schema tool that answers a question about a database it never contacted
     * is worse than one that fails, because nothing tells the caller. So the
     * unsupported engines now refuse, and SQLite -- which better-sqlite3 makes
     * genuinely possible -- is tested against a REAL file with known contents.
     */
    it('refuses PostgreSQL rather than inventing a schema', async () => {
      await expect(
        smartSchema.run({
          connectionString: 'postgresql://user:pass@localhost/testdb',
          mode: 'summary',
        })
      ).rejects.toThrow(/no PostgreSQL driver|not available/i);
    });

    it('refuses MySQL rather than inventing a schema', async () => {
      await expect(
        smartSchema.run({
          connectionString: 'mysql://user:pass@localhost/testdb',
          mode: 'summary',
        })
      ).rejects.toThrow(/no MySQL driver|not available/i);
    });

    it('reads a REAL SQLite database, with the tables that are actually in it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'schema-fixture-'));
      const file = join(dir, 'fixture.db');

      const { default: Database } = await import('better-sqlite3');
      const db = new Database(file);
      db.exec(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'
      );
      db.exec(
        'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));'
      );
      db.prepare('INSERT INTO users (name) VALUES (?)').run('ada');
      db.close();

      try {
        const result = await smartSchema.run({
          connectionString: `sqlite:${file}`,
          mode: 'full',
        });

        const text = JSON.stringify(result);
        // The tables that exist, and nothing invented.
        expect(text).toContain('users');
        expect(text).toContain('orders');
        expect(text).not.toContain('table_1');
        // A real version string, not the hardcoded "3.40.0".
        expect(text).toMatch(/\d+\.\d+\.\d+/);
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* windows */
        }
      }
    });
  });

  describe('Output Modes', () => {
    it('should generate summary output with token reduction', async () => {
      const { file, cleanup } = await sqliteFixture();
      try {
        const result = await smartSchema.run({
          connectionString: `sqlite:${file}`,
          mode: 'summary',
        });
        expect(result.result).toContain('Schema Summary');
        expect(result.tokens.reduction).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });

    it('should generate analysis output', async () => {
      const { file, cleanup } = await sqliteFixture();
      try {
        const result = await smartSchema.run({
          connectionString: `sqlite:${file}`,
          mode: 'analysis',
        });
        expect(result.result).toContain('Schema Analysis');
      } finally {
        cleanup();
      }
    });

    it('should generate full output', async () => {
      const { file, cleanup } = await sqliteFixture();
      try {
        const result = await smartSchema.run({
          connectionString: `sqlite:${file}`,
          mode: 'full',
        });
        expect(result).toBeDefined();
        expect(result.result).toBeDefined();
      } finally {
        cleanup();
      }
    });
  });

  describe('Caching Behavior', () => {
    it('should cache schema introspection results', async () => {
      const result1 = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'summary',
        forceRefresh: false,
      });

      const result2 = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'summary',
        forceRefresh: false,
      });

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });

    it('should bypass cache when forceRefresh is true', async () => {
      const result = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'summary',
        forceRefresh: true,
      });

      expect(result.cached).toBe(false);
    });
  });

  describe('Schema Analysis Features', () => {
    it('should detect unused indexes when requested', async () => {
      const result = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'analysis',
        detectUnusedIndexes: true,
      });

      expect(result).toBeDefined();
      expect(result.result).toContain('Schema Analysis');
    });

    it('should analyze specific tables', async () => {
      const result = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'analysis',
        analyzeTables: ['users', 'orders'],
      });

      expect(result).toBeDefined();
    });

    it('should include data (row counts) when requested', async () => {
      const result = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'summary',
        includeData: true,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Token Reduction Metrics', () => {
    it('should provide token reduction statistics', async () => {
      const result = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'summary',
      });

      expect(result.tokens).toBeDefined();
      expect(result.tokens.baseline).toBeGreaterThan(0);
      expect(result.tokens.actual).toBeGreaterThan(0);
      expect(result.tokens.saved).toBeGreaterThanOrEqual(0);
      expect(result.tokens.reduction).toBeGreaterThanOrEqual(0);
    });

    it('should show high reduction in summary mode', async () => {
      const result = await smartSchema.run({
        connectionString: sharedSqlite,
        mode: 'summary',
      });

      // Summary mode should achieve high token reduction
      expect(result.tokens.reduction).toBeGreaterThan(50);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid connection string', async () => {
      await expect(
        smartSchema.run({
          connectionString: 'invalid://connection/string',
        })
      ).rejects.toThrow();
    });

    it('should handle missing connection string', async () => {
      await expect(
        smartSchema.run({
          connectionString: '' as any,
        })
      ).rejects.toThrow();
    });
  });

  describe('CLI Function', () => {
    it('should run schema analysis via CLI function', async () => {
      const result = await runSmartSchema({
        connectionString: sharedSqlite,
        mode: 'summary',
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('Schema Summary');
    });
  });
});

describe('Import Type Verification - Smart Schema', () => {
  it('should verify TokenCounter can be used as value in runSmartSchema', async () => {
    const tokenCounter = new TokenCounter();
    expect(tokenCounter).toBeInstanceOf(TokenCounter);

    const result = tokenCounter.count('test schema data');
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('should verify MetricsCollector can be used as value in runSmartSchema', () => {
    const metrics = new MetricsCollector();
    expect(metrics).toBeInstanceOf(MetricsCollector);

    metrics.record({
      operation: 'smart_schema',
      duration: 150,
      success: true,
      cacheHit: false,
      inputTokens: 20,
      outputTokens: 10,
      savedTokens: 10,
    });
  });

  it('should verify CacheEngine can be used as value in constructor', () => {
    const cache = new CacheEngine(
      join(tmpdir(), '.test-schema-cache-verify', 'test.db'),
      100
    );
    expect(cache).toBeInstanceOf(CacheEngine);

    const tokenCounter = new TokenCounter();
    const metrics = new MetricsCollector();
    const schema = new SmartSchema(cache, tokenCounter, metrics);
    expect(schema).toBeInstanceOf(SmartSchema);
  });
});
