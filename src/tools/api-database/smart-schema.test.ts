/**
 * Unit Tests for Smart Schema Tool
 * Testing import corrections and core functionality
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SmartSchema, getSmartSchema, runSmartSchema } from './smart-schema';
import { CacheEngine } from '../../core/cache-engine';
import { TokenCounter } from '../../core/token-counter';
import { MetricsCollector } from '../../core/metrics';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Smart Schema - Import Type Corrections', () => {
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
    it('should introspect PostgreSQL schema', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://user:pass@localhost/testdb',
        mode: 'summary',
      });

      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
      expect(result.tokens).toBeDefined();
      expect(result.tokens.baseline).toBeGreaterThan(0);
    });

    it('should introspect MySQL schema', async () => {
      const result = await smartSchema.run({
        connectionString: 'mysql://user:pass@localhost/testdb',
        mode: 'summary',
      });

      expect(result).toBeDefined();
      expect(result.result).toContain('Schema Summary');
    });

    it('should introspect SQLite schema', async () => {
      const result = await smartSchema.run({
        connectionString: '/path/to/database.sqlite',
        mode: 'summary',
      });

      expect(result).toBeDefined();
      expect(result.result).toContain('Schema Summary');
    });
  });

  describe('Output Modes', () => {
    it('should generate summary output with token reduction', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'summary',
      });

      expect(result.result).toContain('Schema Summary');
      expect(result.result).toContain('95% Token Reduction');
      expect(result.tokens.reduction).toBeGreaterThan(0);
    });

    it('should generate analysis output', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'analysis',
      });

      expect(result.result).toContain('Schema Analysis');
      expect(result.result).toContain('85% Token Reduction');
    });

    it('should generate full output', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'full',
      });

      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
    });
  });

  describe('Caching Behavior', () => {
    it('should cache schema introspection results', async () => {
      const result1 = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'summary',
        forceRefresh: false,
      });

      const result2 = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'summary',
        forceRefresh: false,
      });

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });

    it('should bypass cache when forceRefresh is true', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'summary',
        forceRefresh: true,
      });

      expect(result.cached).toBe(false);
    });
  });

  describe('Schema Analysis Features', () => {
    it('should detect unused indexes when requested', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'analysis',
        detectUnusedIndexes: true,
      });

      expect(result).toBeDefined();
      expect(result.result).toContain('Schema Analysis');
    });

    it('should analyze specific tables', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'analysis',
        analyzeTables: ['users', 'orders'],
      });

      expect(result).toBeDefined();
    });

    it('should include data (row counts) when requested', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
        mode: 'summary',
        includeData: true,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Token Reduction Metrics', () => {
    it('should provide token reduction statistics', async () => {
      const result = await smartSchema.run({
        connectionString: 'postgresql://localhost/testdb',
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
        connectionString: 'postgresql://localhost/testdb',
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
        connectionString: 'postgresql://localhost/testdb',
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
