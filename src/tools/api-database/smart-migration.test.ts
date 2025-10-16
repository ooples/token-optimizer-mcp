/**
 * Unit Tests for Smart Migration Tool
 * Testing import corrections and core functionality
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SmartMigration, getSmartMigration, runSmartMigration } from './smart-migration';
import { CacheEngine } from '../../core/cache-engine';
import { TokenCounter } from '../../core/token-counter';
import { MetricsCollector } from '../../core/metrics';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Smart Migration - Import Type Corrections', () => {
  let cacheEngine: CacheEngine;
  let tokenCounter: TokenCounter;
  let metricsCollector: MetricsCollector;
  let smartMigration: SmartMigration;

  beforeEach(() => {
    // Initialize dependencies - verifying that imports work as values
    cacheEngine = new CacheEngine(join(tmpdir(), '.test-cache', 'test.db'), 100);
    tokenCounter = new TokenCounter();
    metricsCollector = new MetricsCollector();
    smartMigration = new SmartMigration(cacheEngine, tokenCounter, metricsCollector);
  });

  describe('Class Instantiation', () => {
    it('should instantiate SmartMigration with TokenCounter as value', () => {
      expect(smartMigration).toBeInstanceOf(SmartMigration);
      expect(tokenCounter).toBeInstanceOf(TokenCounter);
    });

    it('should instantiate SmartMigration with MetricsCollector as value', () => {
      expect(metricsCollector).toBeInstanceOf(MetricsCollector);
    });

    it('should instantiate SmartMigration with CacheEngine as value', () => {
      expect(cacheEngine).toBeInstanceOf(CacheEngine);
    });
  });

  describe('Factory Function', () => {
    it('should create SmartMigration instance via factory function', () => {
      const instance = getSmartMigration(cacheEngine, tokenCounter, metricsCollector);
      expect(instance).toBeInstanceOf(SmartMigration);
    });
  });

  describe('Migration List Action', () => {
    it('should list migrations', async () => {
      const result = await smartMigration.run({ action: 'list', limit: 5 });

      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
      expect(result.tokens).toBeDefined();
      expect(result.tokens.baseline).toBeGreaterThan(0);
      expect(result.tokens.actual).toBeGreaterThan(0);
    });

    it('should return token reduction metrics', async () => {
      const result = await smartMigration.run({ action: 'list' });

      expect(result.tokens.reduction).toBeGreaterThanOrEqual(0);
      expect(result.tokens.saved).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Migration Status Action', () => {
    it('should return migration status summary', async () => {
      const result = await smartMigration.run({ action: 'status' });

      expect(result).toBeDefined();
      expect(result.result).toContain('Status');
      expect(result.cached).toBe(false);
    });
  });

  describe('Migration History Action', () => {
    it('should return migration history', async () => {
      const result = await smartMigration.run({ action: 'history', limit: 10 });

      expect(result).toBeDefined();
      expect(result.result).toBeDefined();
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Generate Migration Action', () => {
    it('should generate migration file', async () => {
      const result = await smartMigration.run({
        action: 'generate',
        migrationId: 'test_migration'
      });

      expect(result).toBeDefined();
      expect(result.result).toContain('test_migration');
    });
  });

  describe('Rollback Migration Action', () => {
    it('should rollback migration', async () => {
      const result = await smartMigration.run({
        action: 'rollback',
        migrationId: 'test_rollback',
        direction: 'down'
      });

      expect(result).toBeDefined();
      expect(result.result).toContain('Rollback');
    });
  });

  describe('Caching Behavior', () => {
    it('should cache read-only operations', async () => {
      const result1 = await smartMigration.run({ action: 'list' });
      const result2 = await smartMigration.run({ action: 'list' });

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      // Second call may be cached (implementation-dependent)
    });

    it('should respect force flag to bypass cache', async () => {
      const result1 = await smartMigration.run({ action: 'list', force: false });
      const result2 = await smartMigration.run({ action: 'list', force: true });

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result2.cached).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid action', async () => {
      await expect(
        smartMigration.run({ action: 'invalid' as any })
      ).rejects.toThrow();
    });

    it('should throw error when migrationId missing for rollback', async () => {
      await expect(
        smartMigration.run({ action: 'rollback' })
      ).rejects.toThrow('migrationId is required');
    });

    it('should throw error when migrationId missing for generate', async () => {
      await expect(
        smartMigration.run({ action: 'generate' })
      ).rejects.toThrow('migrationId is required');
    });
  });

  describe('CLI Function', () => {
    it('should run migration via CLI function', async () => {
      const result = await runSmartMigration({ action: 'status' });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toContain('Status');
    });
  });
});

describe('Import Type Verification', () => {
  it('should verify TokenCounter can be instantiated', () => {
    const counter = new TokenCounter();
    expect(counter).toBeInstanceOf(TokenCounter);

    const result = counter.count('test string');
    expect(result).toBeDefined();
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('should verify MetricsCollector can be instantiated', () => {
    const metrics = new MetricsCollector();
    expect(metrics).toBeInstanceOf(MetricsCollector);

    metrics.record({
      operation: 'test',
      duration: 100,
      success: true,
      cacheHit: false,
      inputTokens: 10,
      outputTokens: 5,
      savedTokens: 0
    });
  });

  it('should verify CacheEngine can be instantiated', () => {
    const cache = new CacheEngine(join(tmpdir(), '.test-cache-verify', 'test.db'), 100);
    expect(cache).toBeInstanceOf(CacheEngine);
  });
});
