/**
 * Type definitions for granular token analytics
 */

/**
 * Hook phases where analytics can be tracked
 */
export type HookPhase =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'PreCompact'
  | 'UserPromptSubmit'
  | 'Unknown';

/**
 * Single analytics data point
 */
export interface AnalyticsEntry {
  /** Hook phase where this operation occurred */
  hookPhase: HookPhase;
  /** Tool/action name (Read, Write, count_tokens, etc.) */
  toolName: string;
  /** MCP server name (token-optimizer, filesystem, github, etc.) */
  mcpServer: string;
  /** Original token count before optimization */
  originalTokens: number;
  /** Token count after optimization */
  optimizedTokens: number;
  /** Tokens saved by optimization */
  tokensSaved: number;
  /** Timestamp in ISO 8601 format */
  timestamp: string;
  /** Optional session ID for grouping */
  sessionId?: string;
  /** Optional additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated statistics for a specific dimension (hook, action, or server)
 */
export interface AggregatedStats {
  /** Name of the dimension (hook phase, tool name, or server name) */
  name: string;
  /** Total operations tracked */
  totalOperations: number;
  /** Total original tokens before optimization */
  totalOriginalTokens: number;
  /** Total optimized tokens */
  totalOptimizedTokens: number;
  /** Total tokens saved */
  totalTokensSaved: number;
  /** Average tokens saved per operation */
  averageTokensSaved: number;
  /** Percentage of tokens saved */
  savingsPercentage: number;
  /** First recorded timestamp */
  firstSeen: string;
  /** Last recorded timestamp */
  lastSeen: string;
}

/**
 * Per-hook analytics breakdown
 */
export interface HookAnalytics {
  /** Overall statistics */
  summary: {
    totalOperations: number;
    totalTokensSaved: number;
    totalOriginalTokens: number;
    totalOptimizedTokens: number;
  };
  /** Breakdown by hook phase */
  byHook: AggregatedStats[];
}

/**
 * Per-action analytics breakdown
 */
export interface ActionAnalytics {
  /** Overall statistics */
  summary: {
    totalOperations: number;
    totalTokensSaved: number;
    totalOriginalTokens: number;
    totalOptimizedTokens: number;
  };
  /** Breakdown by tool/action */
  byAction: AggregatedStats[];
}

/**
 * Per-MCP-server analytics breakdown
 */
export interface ServerAnalytics {
  /** Overall statistics */
  summary: {
    totalOperations: number;
    totalTokensSaved: number;
    totalOriginalTokens: number;
    totalOptimizedTokens: number;
  };
  /** Breakdown by MCP server */
  byServer: AggregatedStats[];
}

/**
 * Export format options
 */
export type ExportFormat = 'json' | 'csv';

/**
 * Export options
 */
export interface ExportOptions {
  /** Output format */
  format: ExportFormat;
  /** Optional date range filter */
  startDate?: string;
  endDate?: string;
  /** Optional filter by hook phase */
  hookPhase?: HookPhase;
  /** Optional filter by tool name */
  toolName?: string;
  /** Optional filter by MCP server */
  mcpServer?: string;
}

/**
 * Export result
 */
export interface ExportResult {
  /** Success status */
  success: boolean;
  /** Exported data (JSON string or CSV string) */
  data: string;
  /** Number of entries exported */
  entryCount: number;
  /** Export format used */
  format: ExportFormat;
  /** Timestamp of export */
  exportedAt: string;
}

/**
 * Storage interface for analytics data
 */
export interface AnalyticsStorage {
  /** Save a single analytics entry */
  save(entry: AnalyticsEntry): Promise<void>;
  /** Save multiple analytics entries */
  saveBatch(entries: AnalyticsEntry[]): Promise<void>;
  /** Query analytics entries with optional filters */
  query(filters?: Partial<AnalyticsEntry>): Promise<AnalyticsEntry[]>;
  /** Get all entries within a date range */
  queryByDateRange(
    startDate: string,
    endDate: string
  ): Promise<AnalyticsEntry[]>;
  /** Clear all analytics data */
  clear(): Promise<void>;
  /** Get total count of stored entries */
  count(): Promise<number>;
  /** Close the storage and flush any pending writes */
  close(): void;
}
