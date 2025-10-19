/**
 * Unit Tests for MetricsCollector
 *
 * Tests cover:
 * - Metric recording
 * - Cache statistics calculation
 * - Operation breakdown
 * - Performance percentiles
 * - Time-based filtering
 * - Event emission
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { MetricsCollector } from '../../src/core/metrics.js';
import { OperationMetrics } from '../../src/core/types.js';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  describe('Metric Recording', () => {
    it('should record a metric with timestamp', () => {
      const beforeRecording = Date.now();

      metrics.record({
        operation: 'test-op',
        duration: 100,
        success: true,
        cacheHit: false,
      });

      const operations = metrics.getOperations();
      expect(operations.length).toBe(1);
      expect(operations[0].operation).toBe('test-op');
      expect(operations[0].timestamp).toBeGreaterThanOrEqual(beforeRecording);
    });

    it('should record multiple metrics', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: true });
      metrics.record({ operation: 'op3', duration: 30, success: false, cacheHit: false });

      const operations = metrics.getOperations();
      expect(operations.length).toBe(3);
    });

    it('should include all optional fields', () => {
      metrics.record({
        operation: 'complex-op',
        duration: 100,
        success: true,
        cacheHit: true,
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 300,
        savedTokens: 200,
        metadata: { custom: 'data' },
      });

      const operations = metrics.getOperations();
      const op = operations[0];

      expect(op.inputTokens).toBe(1000);
      expect(op.outputTokens).toBe(500);
      expect(op.cachedTokens).toBe(300);
      expect(op.savedTokens).toBe(200);
      expect(op.metadata).toEqual({ custom: 'data' });
    });

    it('should trim old entries when exceeding maxEntries', () => {
      // Record more than maxEntries (50000)
      for (let i = 0; i < 50010; i++) {
        metrics.record({
          operation: `op${i}`,
          duration: 10,
          success: true,
          cacheHit: false,
        });
      }

      const operations = metrics.getOperations();
      expect(operations.length).toBe(50000);

      // Should keep the most recent entries
      expect(operations[operations.length - 1].operation).toBe('op50009');
    });

    it('should emit metric event on recording', (done) => {
      metrics.on('metric', (metric: OperationMetrics) => {
        expect(metric.operation).toBe('event-test');
        expect(metric.duration).toBe(100);
        done();
      });

      metrics.record({
        operation: 'event-test',
        duration: 100,
        success: true,
        cacheHit: false,
      });
    });
  });

  describe('Time-Based Filtering', () => {
    it('should filter operations by timestamp', () => {
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      // Manually create operations with specific timestamps
      metrics.record({ operation: 'old-op', duration: 10, success: true, cacheHit: false });

      // Wait a tiny bit to ensure different timestamp
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(5).then(() => {
        const recentTime = Date.now();
        metrics.record({ operation: 'new-op', duration: 20, success: true, cacheHit: false });

        const allOps = metrics.getOperations();
        const recentOps = metrics.getOperations(recentTime);

        expect(allOps.length).toBe(2);
        expect(recentOps.length).toBe(1);
        expect(recentOps[0].operation).toBe('new-op');
      });
    });

    it('should return all operations when no timestamp filter provided', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: false });
      metrics.record({ operation: 'op3', duration: 30, success: true, cacheHit: false });

      const operations = metrics.getOperations();
      expect(operations.length).toBe(3);
    });

    it('should filter by operation name', () => {
      metrics.record({ operation: 'op-A', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op-B', duration: 20, success: true, cacheHit: false });
      metrics.record({ operation: 'op-A', duration: 30, success: true, cacheHit: false });

      const opsA = metrics.getOperations(undefined, 'op-A');
      const opsB = metrics.getOperations(undefined, 'op-B');

      expect(opsA.length).toBe(2);
      expect(opsB.length).toBe(1);
    });

    it('should filter by both timestamp and operation', () => {
      metrics.record({ operation: 'op-A', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op-B', duration: 20, success: true, cacheHit: false });

      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(5).then(() => {
        const recentTime = Date.now();
        metrics.record({ operation: 'op-A', duration: 30, success: true, cacheHit: false });
        metrics.record({ operation: 'op-B', duration: 40, success: true, cacheHit: false });

        const filtered = metrics.getOperations(recentTime, 'op-A');
        expect(filtered.length).toBe(1);
        expect(filtered[0].duration).toBe(30);
      });
    });
  });

  describe('Cache Statistics', () => {
    it('should calculate cache hit rate', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: true });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: true });
      metrics.record({ operation: 'op3', duration: 30, success: true, cacheHit: false });
      metrics.record({ operation: 'op4', duration: 40, success: true, cacheHit: false });

      const stats = metrics.getCacheStats();

      expect(stats.totalOperations).toBe(4);
      expect(stats.cacheHits).toBe(2);
      expect(stats.cacheMisses).toBe(2);
      expect(stats.cacheHitRate).toBeCloseTo(50, 2);
    });

    it('should calculate average duration', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: false });
      metrics.record({ operation: 'op3', duration: 30, success: true, cacheHit: false });

      const stats = metrics.getCacheStats();
      expect(stats.averageDuration).toBeCloseTo(20, 2);
    });

    it('should calculate success rate', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: false });
      metrics.record({ operation: 'op3', duration: 30, success: false, cacheHit: false });
      metrics.record({ operation: 'op4', duration: 40, success: false, cacheHit: false });

      const stats = metrics.getCacheStats();
      expect(stats.successRate).toBeCloseTo(50, 2);
    });

    it('should handle empty metrics', () => {
      const stats = metrics.getCacheStats();

      expect(stats.totalOperations).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.averageDuration).toBe(0);
      expect(stats.successRate).toBe(0);
    });

    it('should filter stats by time', () => {
      metrics.record({ operation: 'old', duration: 10, success: true, cacheHit: true });

      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(5).then(() => {
        const recentTime = Date.now();
        metrics.record({ operation: 'new', duration: 20, success: true, cacheHit: false });

        const allStats = metrics.getCacheStats();
        const recentStats = metrics.getCacheStats(recentTime);

        expect(allStats.totalOperations).toBe(2);
        expect(recentStats.totalOperations).toBe(1);
        expect(recentStats.cacheMisses).toBe(1);
      });
    });

    it('should handle 100% cache hit rate', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: true });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: true });

      const stats = metrics.getCacheStats();
      expect(stats.cacheHitRate).toBe(100);
      expect(stats.cacheMisses).toBe(0);
    });

    it('should handle 0% cache hit rate', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: false });

      const stats = metrics.getCacheStats();
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.cacheHits).toBe(0);
    });
  });

  describe('Operation Breakdown', () => {
    it('should break down metrics by operation type', () => {
      metrics.record({ operation: 'read', duration: 10, success: true, cacheHit: true });
      metrics.record({ operation: 'read', duration: 15, success: true, cacheHit: false });
      metrics.record({ operation: 'write', duration: 30, success: true, cacheHit: false });

      const breakdown = metrics.getOperationBreakdown();

      expect(breakdown['read'].count).toBe(2);
      expect(breakdown['write'].count).toBe(1);
      expect(breakdown['read'].cacheHits).toBe(1);
      expect(breakdown['write'].cacheHits).toBe(0);
    });

    it('should calculate per-operation average duration', () => {
      metrics.record({ operation: 'fast', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'fast', duration: 20, success: true, cacheHit: false });
      metrics.record({ operation: 'slow', duration: 100, success: true, cacheHit: false });
      metrics.record({ operation: 'slow', duration: 200, success: true, cacheHit: false });

      const breakdown = metrics.getOperationBreakdown();

      expect(breakdown['fast'].averageDuration).toBeCloseTo(15, 2);
      expect(breakdown['slow'].averageDuration).toBeCloseTo(150, 2);
    });

    it('should calculate per-operation success rate', () => {
      metrics.record({ operation: 'reliable', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'reliable', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'flaky', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'flaky', duration: 10, success: false, cacheHit: false });

      const breakdown = metrics.getOperationBreakdown();

      expect(breakdown['reliable'].successRate).toBe(100);
      expect(breakdown['flaky'].successRate).toBe(50);
    });

    it('should return empty breakdown for no operations', () => {
      const breakdown = metrics.getOperationBreakdown();
      expect(Object.keys(breakdown).length).toBe(0);
    });

    it('should filter breakdown by time', () => {
      metrics.record({ operation: 'old', duration: 10, success: true, cacheHit: false });

      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(5).then(() => {
        const recentTime = Date.now();
        metrics.record({ operation: 'new', duration: 20, success: true, cacheHit: false });

        const allBreakdown = metrics.getOperationBreakdown();
        const recentBreakdown = metrics.getOperationBreakdown(recentTime);

        expect(Object.keys(allBreakdown).length).toBe(2);
        expect(Object.keys(recentBreakdown).length).toBe(1);
        expect(recentBreakdown['new']).toBeDefined();
      });
    });
  });

  describe('Performance Percentiles', () => {
    it('should calculate performance percentiles', () => {
      // Add operations with known durations
      const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      durations.forEach((duration) => {
        metrics.record({
          operation: 'test',
          duration,
          success: true,
          cacheHit: false,
        });
      });

      const percentiles = metrics.getPerformancePercentiles();

      expect(percentiles.p50).toBeCloseTo(50, 0);
      expect(percentiles.p90).toBeCloseTo(90, 0);
      expect(percentiles.p95).toBeCloseTo(100, 0);
      expect(percentiles.p99).toBeCloseTo(100, 0);
    });

    it('should handle empty metrics for percentiles', () => {
      const percentiles = metrics.getPerformancePercentiles();

      expect(percentiles.p50).toBe(0);
      expect(percentiles.p90).toBe(0);
      expect(percentiles.p95).toBe(0);
      expect(percentiles.p99).toBe(0);
    });

    it('should handle single operation', () => {
      metrics.record({ operation: 'single', duration: 42, success: true, cacheHit: false });

      const percentiles = metrics.getPerformancePercentiles();

      expect(percentiles.p50).toBe(42);
      expect(percentiles.p90).toBe(42);
      expect(percentiles.p95).toBe(42);
      expect(percentiles.p99).toBe(42);
    });

    it('should filter percentiles by time', () => {
      metrics.record({ operation: 'slow', duration: 1000, success: true, cacheHit: false });

      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(5).then(() => {
        const recentTime = Date.now();
        metrics.record({ operation: 'fast', duration: 10, success: true, cacheHit: false });

        const allPercentiles = metrics.getPerformancePercentiles();
        const recentPercentiles = metrics.getPerformancePercentiles(recentTime);

        expect(allPercentiles.p90).toBeGreaterThan(recentPercentiles.p90);
      });
    });

    it('should sort durations correctly for percentiles', () => {
      // Add operations in random order
      [50, 10, 90, 30, 70, 20, 80, 40, 60, 100].forEach((duration) => {
        metrics.record({
          operation: 'test',
          duration,
          success: true,
          cacheHit: false,
        });
      });

      const percentiles = metrics.getPerformancePercentiles();

      // Percentiles should be in ascending order (or equal)
      expect(percentiles.p50).toBeLessThan(percentiles.p90);
      expect(percentiles.p90).toBeLessThanOrEqual(percentiles.p95);
      expect(percentiles.p95).toBeLessThanOrEqual(percentiles.p99);
    });
  });

  describe('Clear and Export', () => {
    it('should clear all metrics', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: false });

      expect(metrics.getOperations().length).toBe(2);

      metrics.clear();

      expect(metrics.getOperations().length).toBe(0);
      const stats = metrics.getCacheStats();
      expect(stats.totalOperations).toBe(0);
    });

    it('should emit cleared event', (done) => {
      metrics.on('cleared', () => {
        done();
      });

      metrics.clear();
    });

    it('should export metrics as JSON', () => {
      metrics.record({ operation: 'op1', duration: 10, success: true, cacheHit: false });
      metrics.record({ operation: 'op2', duration: 20, success: true, cacheHit: true });

      const exported = metrics.export();
      const parsed = JSON.parse(exported);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].operation).toBe('op1');
      expect(parsed[1].operation).toBe('op2');
    });

    it('should export with time filter', () => {
      metrics.record({ operation: 'old', duration: 10, success: true, cacheHit: false });

      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      return delay(5).then(() => {
        const recentTime = Date.now();
        metrics.record({ operation: 'new', duration: 20, success: true, cacheHit: false });

        const allExport = JSON.parse(metrics.export());
        const recentExport = JSON.parse(metrics.export(recentTime));

        expect(allExport.length).toBe(2);
        expect(recentExport.length).toBe(1);
        expect(recentExport[0].operation).toBe('new');
      });
    });

    it('should export empty array for no metrics', () => {
      const exported = metrics.export();
      const parsed = JSON.parse(exported);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle operations with zero duration', () => {
      metrics.record({ operation: 'instant', duration: 0, success: true, cacheHit: true });

      const stats = metrics.getCacheStats();
      expect(stats.averageDuration).toBe(0);
    });

    it('should handle very large duration values', () => {
      metrics.record({
        operation: 'slow',
        duration: Number.MAX_SAFE_INTEGER,
        success: true,
        cacheHit: false,
      });

      const stats = metrics.getCacheStats();
      expect(stats.averageDuration).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle operations with undefined optional fields', () => {
      metrics.record({
        operation: 'minimal',
        duration: 10,
        success: true,
        cacheHit: false,
        inputTokens: undefined,
        outputTokens: undefined,
        cachedTokens: undefined,
        savedTokens: undefined,
      });

      const operations = metrics.getOperations();
      expect(operations[0].inputTokens).toBeUndefined();
      expect(operations[0].outputTokens).toBeUndefined();
    });

    it('should handle rapid metric recording', () => {
      for (let i = 0; i < 1000; i++) {
        metrics.record({
          operation: `op${i}`,
          duration: i,
          success: true,
          cacheHit: i % 2 === 0,
        });
      }

      const stats = metrics.getCacheStats();
      expect(stats.totalOperations).toBe(1000);
      expect(stats.cacheHits).toBe(500);
    });

    it('should handle operations with same timestamp', () => {
      const timestamp = Date.now();

      // Record multiple operations that might have the same timestamp
      for (let i = 0; i < 10; i++) {
        metrics.record({ operation: `op${i}`, duration: 10, success: true, cacheHit: false });
      }

      const operations = metrics.getOperations();
      expect(operations.length).toBe(10);
    });
  });
});
