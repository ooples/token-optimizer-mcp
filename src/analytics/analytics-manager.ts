/**
 * Core analytics manager for tracking and aggregating token usage
 */

import type {
  AnalyticsEntry,
  AnalyticsStorage,
  HookAnalytics,
  ActionAnalytics,
  ServerAnalytics,
  AggregatedStats,
  HookPhase,
} from './analytics-types.js';
import { SqliteAnalyticsStorage } from './analytics-storage.js';

/**
 * Manager for tracking and analyzing token usage
 */
export class AnalyticsManager {
  private storage: AnalyticsStorage;

  constructor(storage?: AnalyticsStorage) {
    this.storage = storage || new SqliteAnalyticsStorage();
  }

  /**
   * Track a single operation
   */
  async track(entry: Omit<AnalyticsEntry, 'timestamp'>): Promise<void> {
    const fullEntry: AnalyticsEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    await this.storage.save(fullEntry);
  }

  /**
   * Track a batch of operations
   */
  async trackBatch(entries: Omit<AnalyticsEntry, 'timestamp'>[]): Promise<void> {
    const fullEntries: AnalyticsEntry[] = entries.map((entry) => ({
      ...entry,
      timestamp: new Date().toISOString(),
    }));

    await this.storage.saveBatch(fullEntries);
  }

  /**
   * Get per-hook analytics breakdown
   */
  async getHookAnalytics(options?: {
    startDate?: string;
    endDate?: string;
  }): Promise<HookAnalytics> {
    let entries: AnalyticsEntry[];

    if (options?.startDate || options?.endDate) {
      const start = options?.startDate ?? '0001-01-01T00:00:00.000Z';
      const end = options?.endDate ?? new Date().toISOString();
      entries = await this.storage.queryByDateRange(start, end);
    } else {
      entries = await this.storage.query();
    }

    return this.aggregateByHook(entries);
  }

  /**
   * Get per-action analytics breakdown
   */
  async getActionAnalytics(options?: {
    startDate?: string;
    endDate?: string;
  }): Promise<ActionAnalytics> {
    let entries: AnalyticsEntry[];

    if (options?.startDate || options?.endDate) {
      const start = options?.startDate ?? '0001-01-01T00:00:00.000Z';
      const end = options?.endDate ?? new Date().toISOString();
      entries = await this.storage.queryByDateRange(start, end);
    } else {
      entries = await this.storage.query();
    }

    return this.aggregateByAction(entries);
  }

  /**
   * Get per-MCP-server analytics breakdown
   */
  async getServerAnalytics(options?: {
    startDate?: string;
    endDate?: string;
  }): Promise<ServerAnalytics> {
    let entries: AnalyticsEntry[];

    if (options?.startDate || options?.endDate) {
      const start = options?.startDate ?? '0001-01-01T00:00:00.000Z';
      const end = options?.endDate ?? new Date().toISOString();
      entries = await this.storage.queryByDateRange(start, end);
    } else {
      entries = await this.storage.query();
    }

    return this.aggregateByServer(entries);
  }

  /**
   * Get all analytics entries with optional filters
   */
  async getEntries(filters?: {
    hookPhase?: HookPhase;
    toolName?: string;
    mcpServer?: string;
    startDate?: string;
    endDate?: string;
    sessionId?: string;
  }): Promise<AnalyticsEntry[]> {
    if (filters?.startDate || filters?.endDate) {
      const start = filters?.startDate ?? '0001-01-01T00:00:00.000Z';
      const end = filters?.endDate ?? new Date().toISOString();
      const entries = await this.storage.queryByDateRange(start, end);

      // Apply additional filters
      return entries.filter((entry) => {
        if (filters.hookPhase && entry.hookPhase !== filters.hookPhase) {
          return false;
        }
        if (filters.toolName && entry.toolName !== filters.toolName) {
          return false;
        }
        if (filters.mcpServer && entry.mcpServer !== filters.mcpServer) {
          return false;
        }
        if (filters.sessionId && entry.sessionId !== filters.sessionId) {
          return false;
        }
        return true;
      });
    }

    return await this.storage.query(filters);
  }

  /**
   * Clear all analytics data
   */
  async clear(): Promise<void> {
    await this.storage.clear();
  }

  /**
   * Get total count of analytics entries
   */
  async count(): Promise<number> {
    return await this.storage.count();
  }

  /**
   * Aggregate entries by hook phase
   */
  private aggregateByHook(entries: AnalyticsEntry[]): HookAnalytics {
    const hookMap = new Map<string, AnalyticsEntry[]>();

    for (const entry of entries) {
      const existing = hookMap.get(entry.hookPhase) || [];
      existing.push(entry);
      hookMap.set(entry.hookPhase, existing);
    }

    const byHook: AggregatedStats[] = [];
    let totalOperations = 0;
    let totalTokensSaved = 0;
    let totalOriginalTokens = 0;
    let totalOptimizedTokens = 0;

    for (const [hookPhase, hookEntries] of hookMap.entries()) {
      const stats = this.calculateAggregatedStats(hookPhase, hookEntries);
      byHook.push(stats);

      totalOperations += stats.totalOperations;
      totalTokensSaved += stats.totalTokensSaved;
      totalOriginalTokens += stats.totalOriginalTokens;
      totalOptimizedTokens += stats.totalOptimizedTokens;
    }

    // Sort by total tokens saved (descending)
    byHook.sort((a, b) => b.totalTokensSaved - a.totalTokensSaved);

    return {
      summary: {
        totalOperations,
        totalTokensSaved,
        totalOriginalTokens,
        totalOptimizedTokens,
      },
      byHook,
    };
  }

  /**
   * Aggregate entries by tool/action
   */
  private aggregateByAction(entries: AnalyticsEntry[]): ActionAnalytics {
    const actionMap = new Map<string, AnalyticsEntry[]>();

    for (const entry of entries) {
      const existing = actionMap.get(entry.toolName) || [];
      existing.push(entry);
      actionMap.set(entry.toolName, existing);
    }

    const byAction: AggregatedStats[] = [];
    let totalOperations = 0;
    let totalTokensSaved = 0;
    let totalOriginalTokens = 0;
    let totalOptimizedTokens = 0;

    for (const [toolName, toolEntries] of actionMap.entries()) {
      const stats = this.calculateAggregatedStats(toolName, toolEntries);
      byAction.push(stats);

      totalOperations += stats.totalOperations;
      totalTokensSaved += stats.totalTokensSaved;
      totalOriginalTokens += stats.totalOriginalTokens;
      totalOptimizedTokens += stats.totalOptimizedTokens;
    }

    // Sort by total tokens saved (descending)
    byAction.sort((a, b) => b.totalTokensSaved - a.totalTokensSaved);

    return {
      summary: {
        totalOperations,
        totalTokensSaved,
        totalOriginalTokens,
        totalOptimizedTokens,
      },
      byAction,
    };
  }

  /**
   * Aggregate entries by MCP server
   */
  private aggregateByServer(entries: AnalyticsEntry[]): ServerAnalytics {
    const serverMap = new Map<string, AnalyticsEntry[]>();

    for (const entry of entries) {
      const existing = serverMap.get(entry.mcpServer) || [];
      existing.push(entry);
      serverMap.set(entry.mcpServer, existing);
    }

    const byServer: AggregatedStats[] = [];
    let totalOperations = 0;
    let totalTokensSaved = 0;
    let totalOriginalTokens = 0;
    let totalOptimizedTokens = 0;

    for (const [serverName, serverEntries] of serverMap.entries()) {
      const stats = this.calculateAggregatedStats(serverName, serverEntries);
      byServer.push(stats);

      totalOperations += stats.totalOperations;
      totalTokensSaved += stats.totalTokensSaved;
      totalOriginalTokens += stats.totalOriginalTokens;
      totalOptimizedTokens += stats.totalOptimizedTokens;
    }

    // Sort by total tokens saved (descending)
    byServer.sort((a, b) => b.totalTokensSaved - a.totalTokensSaved);

    return {
      summary: {
        totalOperations,
        totalTokensSaved,
        totalOriginalTokens,
        totalOptimizedTokens,
      },
      byServer,
    };
  }

  /**
   * Calculate aggregated statistics for a group of entries
   */
  private calculateAggregatedStats(
    name: string,
    entries: AnalyticsEntry[]
  ): AggregatedStats {
    const totalOperations = entries.length;
    const totalOriginalTokens = entries.reduce(
      (sum, e) => sum + e.originalTokens,
      0
    );
    const totalOptimizedTokens = entries.reduce(
      (sum, e) => sum + e.optimizedTokens,
      0
    );
    const totalTokensSaved = entries.reduce((sum, e) => sum + e.tokensSaved, 0);
    const averageTokensSaved = totalTokensSaved / totalOperations;
    const savingsPercentage =
      totalOriginalTokens > 0
        ? (totalTokensSaved / totalOriginalTokens) * 100
        : 0;

    const timestamps = entries.map((e) => e.timestamp).sort();
    const firstSeen = timestamps[0];
    const lastSeen = timestamps[timestamps.length - 1];

    return {
      name,
      totalOperations,
      totalOriginalTokens,
      totalOptimizedTokens,
      totalTokensSaved,
      averageTokensSaved,
      savingsPercentage,
      firstSeen,
      lastSeen,
    };
  }

  /**
   * Export analytics data as JSON
   */
  async exportAsJson(filters?: {
    startDate?: string;
    endDate?: string;
    hookPhase?: HookPhase;
    toolName?: string;
    mcpServer?: string;
  }): Promise<string> {
    const entries = await this.getEntries(filters);
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Export analytics data as CSV
   */
  async exportAsCsv(filters?: {
    startDate?: string;
    endDate?: string;
    hookPhase?: HookPhase;
    toolName?: string;
    mcpServer?: string;
  }): Promise<string> {
    const entries = await this.getEntries(filters);

    if (entries.length === 0) {
      return 'hookPhase,toolName,mcpServer,originalTokens,optimizedTokens,tokensSaved,timestamp,sessionId\n';
    }

    const header =
      'hookPhase,toolName,mcpServer,originalTokens,optimizedTokens,tokensSaved,timestamp,sessionId\n';
    const rows = entries.map((entry) => {
      return [
        entry.hookPhase,
        entry.toolName,
        entry.mcpServer,
        entry.originalTokens,
        entry.optimizedTokens,
        entry.tokensSaved,
        entry.timestamp,
        entry.sessionId || '',
      ]
        .map((value) => {
          // Escape commas and quotes in CSV values
          const str = String(value);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(',');
    });

    return header + rows.join('\n') + '\n';
  }

  /**
   * Close the underlying storage and flush any pending writes
   */
  close(): void {
    if (this.storage && typeof this.storage.close === 'function') {
      this.storage.close();
    }
  }
}
