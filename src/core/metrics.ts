/**
 * Metrics collection and monitoring
 */

import { OperationMetrics } from './types.js';
import { EventEmitter } from 'events';

export class MetricsCollector extends EventEmitter {
  private operations: OperationMetrics[] = [];
  private readonly maxEntries = 50000;

  /**
   * Record an operation metric
   */
  record(metric: Omit<OperationMetrics, 'timestamp'>): void {
    const fullMetric: OperationMetrics = {
      ...metric,
      timestamp: Date.now(),
    };

    this.operations.push(fullMetric);

    // Trim old entries
    if (this.operations.length > this.maxEntries) {
      this.operations = this.operations.slice(-this.maxEntries);
    }

    // Emit event for real-time monitoring
    this.emit('metric', fullMetric);
  }

  /**
   * Get operations for a time period
   */
  getOperations(since?: number, operation?: string): OperationMetrics[] {
    let filtered = this.operations;

    if (since) {
      filtered = filtered.filter((op) => op.timestamp >= since);
    }

    if (operation) {
      filtered = filtered.filter((op) => op.operation === operation);
    }

    return filtered;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(since?: number): {
    totalOperations: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    averageDuration: number;
    successRate: number;
  } {
    const ops = this.getOperations(since);

    if (ops.length === 0) {
      return {
        totalOperations: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheHitRate: 0,
        averageDuration: 0,
        successRate: 0,
      };
    }

    const cacheHits = ops.filter((op) => op.cacheHit).length;
    const cacheMisses = ops.length - cacheHits;
    const successCount = ops.filter((op) => op.success).length;
    const totalDuration = ops.reduce((sum, op) => sum + op.duration, 0);

    return {
      totalOperations: ops.length,
      cacheHits,
      cacheMisses,
      cacheHitRate: (cacheHits / ops.length) * 100,
      averageDuration: totalDuration / ops.length,
      successRate: (successCount / ops.length) * 100,
    };
  }

  /**
   * Get operation breakdown by type
   */
  getOperationBreakdown(since?: number): Record<
    string,
    {
      count: number;
      cacheHits: number;
      averageDuration: number;
      successRate: number;
    }
  > {
    const ops = this.getOperations(since);
    const breakdown: Record<
      string,
      {
        count: number;
        cacheHits: number;
        totalDuration: number;
        successCount: number;
      }
    > = {};

    for (const op of ops) {
      if (!breakdown[op.operation]) {
        breakdown[op.operation] = {
          count: 0,
          cacheHits: 0,
          totalDuration: 0,
          successCount: 0,
        };
      }

      breakdown[op.operation].count++;
      if (op.cacheHit) breakdown[op.operation].cacheHits++;
      if (op.success) breakdown[op.operation].successCount++;
      breakdown[op.operation].totalDuration += op.duration;
    }

    // Convert to final format
    const result: Record<
      string,
      {
        count: number;
        cacheHits: number;
        averageDuration: number;
        successRate: number;
      }
    > = {};
    for (const [operation, stats] of Object.entries(breakdown)) {
      result[operation] = {
        count: stats.count,
        cacheHits: stats.cacheHits,
        averageDuration: stats.totalDuration / stats.count,
        successRate: (stats.successCount / stats.count) * 100,
      };
    }

    return result;
  }

  /**
   * Get performance percentiles
   */
  getPerformancePercentiles(since?: number): {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  } {
    const ops = this.getOperations(since);

    if (ops.length === 0) {
      return { p50: 0, p90: 0, p95: 0, p99: 0 };
    }

    const durations = ops.map((op) => op.duration).sort((a, b) => a - b);

    const percentile = (p: number): number => {
      const index = Math.ceil((p / 100) * durations.length) - 1;
      return durations[index];
    };

    return {
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
    };
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.operations = [];
    this.emit('cleared');
  }

  /**
   * Export metrics for external analysis
   */
  export(since?: number): string {
    return JSON.stringify(this.getOperations(since), null, 2);
  }
}

// Singleton instance
export const globalMetricsCollector = new MetricsCollector();
