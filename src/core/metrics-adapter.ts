/**
 * Adapter to make MetricsCollector implement IMetrics interface
 */

import { IMetrics, SummarizationMetrics } from '../interfaces/IMetrics.js';
import { MetricsCollector } from './metrics.js';

interface SummarizationRecord extends SummarizationMetrics {
  timestamp: number;
}

export class MetricsAdapter implements IMetrics {
  private summarizations: SummarizationRecord[] = [];
  private readonly maxEntries = 10000;

  constructor(private metricsCollector: MetricsCollector) {}

  recordSummarization(metrics: SummarizationMetrics): void {
    const record: SummarizationRecord = {
      ...metrics,
      timestamp: Date.now(),
    };

    this.summarizations.push(record);

    // Trim old entries
    if (this.summarizations.length > this.maxEntries) {
      this.summarizations = this.summarizations.slice(-this.maxEntries);
    }

    // Also record in the general metrics collector
    this.metricsCollector.record({
      operation: 'summarization',
      duration: metrics.latency,
      success: true,
      cacheHit: false,
      inputTokens: metrics.originalTokens,
      outputTokens: metrics.summaryTokens,
      savedTokens: metrics.originalTokens - metrics.summaryTokens,
      metadata: {
        compressionRatio: metrics.compressionRatio,
      },
    });
  }

  getSummarizationStats(): {
    totalSummarizations: number;
    averageCompressionRatio: number;
    totalTokensSaved: number;
    averageLatency: number;
  } {
    if (this.summarizations.length === 0) {
      return {
        totalSummarizations: 0,
        averageCompressionRatio: 0,
        totalTokensSaved: 0,
        averageLatency: 0,
      };
    }

    const totalCompressionRatio = this.summarizations.reduce(
      (sum, s) => sum + s.compressionRatio,
      0
    );
    const totalTokensSaved = this.summarizations.reduce(
      (sum, s) => sum + (s.originalTokens - s.summaryTokens),
      0
    );
    const totalLatency = this.summarizations.reduce(
      (sum, s) => sum + s.latency,
      0
    );

    return {
      totalSummarizations: this.summarizations.length,
      averageCompressionRatio:
        totalCompressionRatio / this.summarizations.length,
      totalTokensSaved,
      averageLatency: totalLatency / this.summarizations.length,
    };
  }
}
