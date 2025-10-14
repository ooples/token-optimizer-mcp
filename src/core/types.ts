/**
 * Core type definitions for Hypercontext MCP
 */

export interface CacheEntry {
  key: string;
  value: Buffer;  // Compressed binary data
  tokensSaved: number;
  createdAt: number;
  accessedAt: number;
  expiresAt: number;
  hitCount: number;
  fileHash?: string;  // For git-aware invalidation
  version: number;
}

export interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hitRate: number;
  tokensSaved: number;
  averageCompressionRatio: number;
}

export interface HypercontextConfig {
  cache: {
    enabled: boolean;
    maxSizeMB: number;
    defaultTTL: number;
    ttlByType: Record<string, number>;
    compression: 'none' | 'gzip' | 'brotli' | 'auto';
  };
  monitoring: {
    enabled: boolean;
    detailedLogging: boolean;
    metricsRetentionDays: number;
    dashboardPort: number;
    enableWebUI: boolean;
  };
  intelligence: {
    enablePatternDetection: boolean;
    enableWorkflowLearning: boolean;
    enablePredictiveCaching: boolean;
    mlModelPath?: string;
  };
  performance: {
    maxConcurrentOps: number;
    streamingThreshold: number;
    enableStreaming: boolean;
  };
}

export interface TokenMetrics {
  operation: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  savedTokens: number;
  timestamp: number;
  cost?: number;
  model?: string;
}

export type ModelType =
  | 'gpt-4'
  | 'gpt-4-turbo'
  | 'gpt-3.5-turbo'
  | 'claude-3-opus'
  | 'claude-3-sonnet'
  | 'claude-3-haiku';

export interface ModelCostConfig {
  inputCostPer1K: number;
  outputCostPer1K: number;
  encoding: 'cl100k_base' | 'p50k_base' | 'r50k_base';
}

export interface PatternDetectionResult {
  pattern: string;
  frequency: number;
  totalTokens: number;
  averageTokens: number;
  estimatedCost: number;
  recommendation: string;
}

export interface CostBreakdown {
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  savings: number;
  savingsPercent: number;
}

export interface OperationMetrics {
  operation: string;
  duration: number;
  success: boolean;
  cacheHit: boolean;
  inputTokens?: number;
  savedTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type CompressionLevel = 'none' | 'low' | 'medium' | 'high';
export type CacheStrategy = 'lru' | 'lfu' | 'ttl' | 'adaptive';

export interface SmartToolOptions {
  enableCache?: boolean;
  ttl?: number;
  compression?: CompressionLevel;
  priority?: number;
}

export interface CacheInvalidationEvent {
  type: 'file_change' | 'git_operation' | 'manual' | 'expiration';
  affectedKeys: string[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}
