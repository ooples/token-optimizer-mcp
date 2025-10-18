/**
 * Interface for metrics collection
 */

export interface SummarizationMetrics {
  originalTokens: number;
  summaryTokens: number;
  compressionRatio: number;
  latency: number;
}

export interface IMetrics {
  /**
   * Record a summarization operation
   */
  recordSummarization(metrics: SummarizationMetrics): void;

  /**
   * Get summarization statistics
   */
  getSummarizationStats?(): {
    totalSummarizations: number;
    averageCompressionRatio: number;
    totalTokensSaved: number;
    averageLatency: number;
  };
}
