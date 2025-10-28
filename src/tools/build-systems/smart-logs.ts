/**
 * Smart Logs Tool - System Log Aggregation and Analysis
 *
 * Provides intelligent log analysis with:
 * - Multi-source log aggregation
 * - Pattern filtering and error detection
 * - Log level analysis
 * - Token-optimized output
 */

import { spawn } from 'child_process';
import { CacheEngine } from '../../core/cache-engine.js';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface LogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
}

interface LogStats {
  total: number;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
  timeRange: { start: string; end: string };
}

interface LogResult {
  success: boolean;
  entries: LogEntry[];
  stats: LogStats;
  patterns: Array<{ pattern: string; count: number }>;
  duration: number;
  timestamp: number;
}

interface SmartLogsOptions {
  /**
   * Log sources to aggregate (file paths or system logs)
   */
  sources?: string[];

  /**
   * Filter by log level
   */
  level?: 'error' | 'warn' | 'info' | 'debug' | 'all';

  /**
   * Filter by pattern (regex)
   */
  pattern?: string;

  /**
   * Number of lines to tail
   */
  tail?: number;

  /**
   * Follow mode (watch for new entries)
   */
  follow?: boolean;

  /**
   * Time range filter (e.g., '1h', '24h', '7d')
   */
  since?: string;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Maximum cache age in seconds (default: 300 = 5 minutes for logs)
   */
  maxCacheAge?: number;
}

interface SmartLogsOutput {
  /**
   * Summary
   */
  summary: {
    success: boolean;
    totalEntries: number;
    errorCount: number;
    warnCount: number;
    timeRange: string;
    duration: number;
    fromCache: boolean;
  };

  /**
   * Log entries (filtered and categorized)
   */
  entries: Array<{
    timestamp: string;
    level: string;
    source: string;
    message: string;
  }>;

  /**
   * Statistics
   */
  stats: {
    byLevel: Record<string, number>;
    bySource: Record<string, number>;
  };

  /**
   * Detected patterns (common error messages)
   */
  patterns: Array<{
    pattern: string;
    count: number;
    severity: 'critical' | 'high' | 'medium' | 'low';
  }>;

  /**
   * Analysis insights
   */
  insights: Array<{
    type: 'error' | 'warning' | 'performance';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }>;

  /**
   * Token reduction metrics
   */
  metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPercentage: number;
  };
}

export class SmartLogs {
  private cache: CacheEngine;
  private cacheNamespace = 'smart_logs';
  private projectRoot: string;

  constructor(cache: CacheEngine, projectRoot?: string) {
    this.cache = cache;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Aggregate and analyze logs
   */
  async run(options: SmartLogsOptions = {}): Promise<SmartLogsOutput> {
    const {
      sources = [],
      level = 'all',
      pattern,
      tail = 100,
      follow = false,
      since,
      maxCacheAge = 300, // Logs have shorter cache (5 min)
    } = options;

    const startTime = Date.now();

    // Generate cache key
    const cacheKey = this.generateCacheKey(
      sources,
      level,
      pattern,
      tail,
      since
    );

    // Check cache first (unless follow mode)
    if (!follow) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        return this.formatCachedOutput(cached);
      }
    }

    // Aggregate logs from all sources
    const result = await this.aggregateLogs({
      sources,
      level,
      pattern,
      tail,
      since,
    });

    const duration = Date.now() - startTime;
    result.duration = duration;

    // Cache the result (unless follow mode)
    if (!follow) {
      this.cacheResult(cacheKey, result);
    }

    // Generate insights
    const insights = this.generateInsights(result);

    // Transform to smart output
    return this.transformOutput(result, insights);
  }

  /**
   * Aggregate logs from multiple sources
   */
  private async aggregateLogs(options: {
    sources: string[];
    level: string;
    pattern?: string;
    tail: number;
    since?: string;
  }): Promise<LogResult> {
    const { sources, level, pattern, tail, since } = options;

    const allEntries: LogEntry[] = [];

    // If no sources specified, try common log locations
    const logSources =
      sources.length > 0 ? sources : this.getDefaultLogSources();

    // Collect from each source
    for (const source of logSources) {
      const entries = await this.readLogSource(source, tail);
      allEntries.push(...entries);
    }

    // Filter by level
    let filtered =
      level === 'all'
        ? allEntries
        : allEntries.filter((e) => e.level === level);

    // Filter by pattern
    if (pattern) {
      const regex = new RegExp(pattern, 'i');
      filtered = filtered.filter((e) => regex.test(e.message));
    }

    // Filter by time
    if (since) {
      const cutoffTime = this.parseTimeRange(since);
      filtered = filtered.filter((e) => new Date(e.timestamp) >= cutoffTime);
    }

    // Sort by timestamp (newest first)
    filtered.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Limit to tail count
    filtered = filtered.slice(0, tail);

    // Calculate statistics
    const stats = this.calculateStats(filtered);

    // Detect patterns
    const patterns = this.detectPatterns(filtered);

    return {
      success: true,
      entries: filtered,
      stats,
      patterns,
      duration: 0, // Set by caller
      timestamp: Date.now(),
    };
  }

  /**
   * Get default log sources based on OS
   */
  private getDefaultLogSources(): string[] {
    const sources: string[] = [];

    // Application logs
    const appLogPath = join(this.projectRoot, 'logs');
    if (existsSync(appLogPath)) {
      sources.push(join(appLogPath, 'app.log'));
      sources.push(join(appLogPath, 'error.log'));
    }

    // System logs (platform-specific)
    if (process.platform === 'win32') {
      // Windows Event Logs would need PowerShell
      sources.push('system:application');
    } else if (process.platform === 'darwin') {
      sources.push('/var/log/system.log');
    } else {
      sources.push('/var/log/syslog');
    }

    return sources.filter((s) => existsSync(s) || s.startsWith('system:'));
  }

  /**
   * Read logs from a single source
   */
  private async readLogSource(
    source: string,
    tail: number
  ): Promise<LogEntry[]> {
    // System logs vs file logs
    if (source.startsWith('system:')) {
      return this.readSystemLogs(source, tail);
    } else {
      return this.readFileLog(source, tail);
    }
  }

  /**
   * Read logs from a file
   */
  private async readFileLog(
    filePath: string,
    tail: number
  ): Promise<LogEntry[]> {
    if (!existsSync(filePath)) {
      return [];
    }

    return new Promise((resolve) => {
      const entries: LogEntry[] = [];
      let output = '';

      // Use tail command on Unix, Get-Content on Windows
      const command = process.platform === 'win32' ? 'powershell' : 'tail';
      const args =
        process.platform === 'win32'
          ? ['-Command', `Get-Content -Path "${filePath}" -Tail ${tail}`]
          : ['-n', tail.toString(), filePath];

      const child = spawn(command, args, { shell: true });

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', () => {
        const lines = output.split('\n').filter((l) => l.trim());

        for (const line of lines) {
          const entry = this.parseLogLine(line, filePath);
          if (entry) {
            entries.push(entry);
          }
        }

        resolve(entries);
      });

      child.on('error', () => {
        resolve([]); // Return empty on error
      });
    });
  }

  /**
   * Read system logs
   */
  private async readSystemLogs(
    source: string,
    tail: number
  ): Promise<LogEntry[]> {
    const logType = source.split(':')[1];

    return new Promise((resolve) => {
      const entries: LogEntry[] = [];
      let output = '';

      let command: string;
      let args: string[];

      if (process.platform === 'win32') {
        // Windows Event Log
        command = 'powershell';
        args = [
          '-Command',
          `Get-EventLog -LogName ${logType} -Newest ${tail} | Select-Object TimeGenerated,EntryType,Message | ConvertTo-Json`,
        ];
      } else if (process.platform === 'darwin') {
        // macOS - use log show
        command = 'log';
        args = ['show', '--last', '1h', '--style', 'json'];
      } else {
        // Linux - use journalctl
        command = 'journalctl';
        args = ['-n', tail.toString(), '-o', 'json'];
      }

      const child = spawn(command, args, { shell: true });

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', () => {
        try {
          const parsed = JSON.parse(output);
          const items = Array.isArray(parsed) ? parsed : [parsed];

          for (const item of items) {
            entries.push(this.parseSystemLogEntry(item, source));
          }
        } catch {
          // Failed to parse JSON, try line-by-line
          const lines = output.split('\n').filter((l) => l.trim());
          for (const line of lines) {
            const entry = this.parseLogLine(line, source);
            if (entry) entries.push(entry);
          }
        }

        resolve(entries);
      });

      child.on('error', () => {
        resolve([]);
      });
    });
  }

  /**
   * Parse a log line
   */
  private parseLogLine(line: string, source: string): LogEntry | null {
    // Try common log formats
    // ISO timestamp format: 2024-01-01T12:00:00.000Z [ERROR] message
    const isoMatch = line.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+\[(ERROR|WARN|INFO|DEBUG)\]\s+(.+)$/
    );
    if (isoMatch) {
      return {
        timestamp: isoMatch[1],
        level: isoMatch[2].toLowerCase() as LogEntry['level'],
        source,
        message: isoMatch[3],
      };
    }

    // Syslog format: Jan 1 12:00:00 hostname message
    const syslogMatch = line.match(
      /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+\S+\s+(.+)$/
    );
    if (syslogMatch) {
      return {
        timestamp: new Date(syslogMatch[1]).toISOString(),
        level: this.detectLogLevel(syslogMatch[2]),
        source,
        message: syslogMatch[2],
      };
    }

    // Default: treat whole line as message
    return {
      timestamp: new Date().toISOString(),
      level: this.detectLogLevel(line),
      source,
      message: line,
    };
  }

  /**
   * Parse system log entry
   */
  private parseSystemLogEntry(item: unknown, source: string): LogEntry {
    const entry = item as Record<string, unknown>;

    return {
      timestamp:
        entry.TimeGenerated || entry.timestamp || new Date().toISOString(),
      level: this.mapSystemLogLevel(entry.EntryType || entry.level),
      source,
      message: (entry.Message || entry.message || '') as string,
      metadata: entry,
    } as LogEntry;
  }

  /**
   * Detect log level from message
   */
  private detectLogLevel(message: string): LogEntry['level'] {
    const lower = message.toLowerCase();
    if (
      lower.includes('error') ||
      lower.includes('fatal') ||
      lower.includes('critical')
    ) {
      return 'error';
    }
    if (lower.includes('warn') || lower.includes('warning')) {
      return 'warn';
    }
    if (lower.includes('debug') || lower.includes('trace')) {
      return 'debug';
    }
    return 'info';
  }

  /**
   * Map system log level to our levels
   */
  private mapSystemLogLevel(level: unknown): LogEntry['level'] {
    const str = String(level).toLowerCase();
    if (str.includes('error') || str === '1') return 'error';
    if (str.includes('warn') || str === '2' || str === '3') return 'warn';
    if (str.includes('debug') || str === '5') return 'debug';
    return 'info';
  }

  /**
   * Parse time range string
   */
  private parseTimeRange(since: string): Date {
    const now = Date.now();
    const match = since.match(/^(\d+)([hdwm])$/);

    if (!match) {
      return new Date(now - 3600000); // Default 1 hour
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers = {
      h: 3600000, // hours
      d: 86400000, // days
      w: 604800000, // weeks
      m: 2592000000, // months (30 days)
    };

    const offset =
      value * (multipliers[unit as keyof typeof multipliers] || 3600000);
    return new Date(now - offset);
  }

  /**
   * Calculate statistics
   */
  private calculateStats(entries: LogEntry[]): LogStats {
    const byLevel: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    let earliest = new Date();
    let latest = new Date(0);

    for (const entry of entries) {
      byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;

      const time = new Date(entry.timestamp);
      if (time < earliest) earliest = time;
      if (time > latest) latest = time;
    }

    return {
      total: entries.length,
      byLevel,
      bySource,
      timeRange: {
        start: earliest.toISOString(),
        end: latest.toISOString(),
      },
    };
  }

  /**
   * Detect common patterns
   */
  private detectPatterns(
    entries: LogEntry[]
  ): Array<{ pattern: string; count: number }> {
    const patterns = new Map<string, number>();

    for (const entry of entries) {
      // Extract error codes and common patterns
      const errorCode = entry.message.match(/([A-Z]{2,}\d{4}|ERR_[A-Z_]+)/);
      if (errorCode) {
        const key = errorCode[1];
        patterns.set(key, (patterns.get(key) || 0) + 1);
      }

      // Extract exception types
      const exception = entry.message.match(/(\w+Exception|Error):/);
      if (exception) {
        const key = exception[1];
        patterns.set(key, (patterns.get(key) || 0) + 1);
      }
    }

    return Array.from(patterns.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * Generate insights
   */
  private generateInsights(result: LogResult): Array<{
    type: 'error' | 'warning' | 'performance';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }> {
    const insights = [];

    // High error rate
    const errorRate = (result.stats.byLevel.error || 0) / result.stats.total;
    if (errorRate > 0.1) {
      insights.push({
        type: 'error' as const,
        message: `High error rate: ${(errorRate * 100).toFixed(1)}% of logs are errors`,
        impact: 'high' as const,
      });
    }

    // Repeated patterns
    const topPattern = result.patterns[0];
    if (topPattern && topPattern.count > 10) {
      insights.push({
        type: 'error' as const,
        message: `Repeated error pattern: "${topPattern.pattern}" appears ${topPattern.count} times`,
        impact: 'high' as const,
      });
    }

    // Warning accumulation
    const warnCount = result.stats.byLevel.warn || 0;
    if (warnCount > 50) {
      insights.push({
        type: 'warning' as const,
        message: `High warning count: ${warnCount} warnings detected`,
        impact: 'medium' as const,
      });
    }

    return insights;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(
    sources: string[],
    level: string,
    pattern: string | undefined,
    tail: number,
    since: string | undefined
  ): string {
    const keyParts = [
      sources.join(','),
      level,
      pattern || '',
      tail.toString(),
      since || '',
    ];
    return createHash('md5').update(keyParts.join(':')).digest('hex');
  }

  /**
   * Get cached result
   */
  private getCachedResult(key: string, maxAge: number): LogResult | null {
    const cached = this.cache.get(this.cacheNamespace + ':' + key);
    if (!cached) return null;

    try {
      const result = JSON.parse(cached) as LogResult & {
        cachedAt: number;
      };
      const age = (Date.now() - result.cachedAt) / 1000;

      if (age <= maxAge) {
        return result;
      }
    } catch (err) {
      return null;
    }

    return null;
  }

  /**
   * Cache result
   */
  private cacheResult(key: string, result: LogResult): void {
    const cacheData = { ...result, cachedAt: Date.now() };
    const dataToCache = JSON.stringify(cacheData);
    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = dataToCache.length;
    this.cache.set(
      this.cacheNamespace + ':' + key,
      dataToCache,
      originalSize,
      compactSize
    );
  }

  /**
   * Transform to smart output
   */
  private transformOutput(
    result: LogResult,
    insights: Array<{
      type: 'error' | 'warning' | 'performance';
      message: string;
      impact: 'high' | 'medium' | 'low';
    }>,
    fromCache = false
  ): SmartLogsOutput {
    // For small datasets (< 20 entries), skip smart processing overhead
    // This prevents negative reduction percentages for small logs
    if (result.entries.length < 20) {
      const entries = result.entries.map((e) => ({
        timestamp: e.timestamp,
        level: e.level,
        source: e.source,
        message: e.message, // Full message, no truncation for small datasets
      }));

      const originalSize = JSON.stringify(entries).length;
      const compactSize = originalSize; // No processing = no reduction

      const timeRangeDuration =
        new Date(result.stats.timeRange.end).getTime() -
        new Date(result.stats.timeRange.start).getTime();
      const timeRangeStr = `${(timeRangeDuration / 60000).toFixed(0)} minutes`;

      return {
        summary: {
          success: result.success,
          totalEntries: result.stats.total,
          errorCount: result.stats.byLevel.error || 0,
          warnCount: result.stats.byLevel.warn || 0,
          timeRange: timeRangeStr,
          duration: result.duration,
          fromCache,
        },
        entries: entries, // All entries, no slicing
        stats: {
          byLevel: result.stats.byLevel,
          bySource: result.stats.bySource,
        },
        patterns: [], // No patterns for small datasets
        insights: [], // No insights for small datasets
        metrics: {
          originalTokens: Math.ceil(originalSize / 4),
          compactedTokens: Math.ceil(compactSize / 4),
          reductionPercentage: 0, // No reduction for small datasets
        },
      };
    }

    // For large datasets (≥ 20 entries), use full smart processing
    const entries = result.entries.map((e) => ({
      timestamp: e.timestamp,
      level: e.level,
      source: e.source,
      message: e.message.substring(0, 200), // Truncate long messages
    }));

    const patterns = result.patterns.map((p) => ({
      pattern: p.pattern,
      count: p.count,
      severity:
        p.count > 50
          ? ('critical' as const)
          : p.count > 20
            ? ('high' as const)
            : p.count > 10
              ? ('medium' as const)
              : ('low' as const),
    }));

    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = this.estimateCompactSize(
      entries.slice(0, 50), // Only measure what we actually send
      patterns,
      insights
    );

    const timeRangeDuration =
      new Date(result.stats.timeRange.end).getTime() -
      new Date(result.stats.timeRange.start).getTime();
    const timeRangeStr = `${(timeRangeDuration / 60000).toFixed(0)} minutes`;

    return {
      summary: {
        success: result.success,
        totalEntries: result.stats.total,
        errorCount: result.stats.byLevel.error || 0,
        warnCount: result.stats.byLevel.warn || 0,
        timeRange: timeRangeStr,
        duration: result.duration,
        fromCache,
      },
      entries: entries.slice(0, 50), // Limit to 50 for output
      stats: {
        byLevel: result.stats.byLevel,
        bySource: result.stats.bySource,
      },
      patterns,
      insights,
      metrics: {
        originalTokens: Math.ceil(originalSize / 4),
        compactedTokens: Math.ceil(compactSize / 4),
        reductionPercentage: Math.round(
          ((originalSize - compactSize) / originalSize) * 100
        ),
      },
    };
  }

  /**
   * Format cached output
   */
  private formatCachedOutput(result: LogResult): SmartLogsOutput {
    return this.transformOutput(result, [], true);
  }

  /**
   * Estimate original output size
   */
  private estimateOriginalOutputSize(result: LogResult): number {
    // Measure what would be sent WITHOUT compaction (full JSON)
    return JSON.stringify(result.entries).length;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(
    entries: Array<{
      timestamp: string;
      level: string;
      source: string;
      message: string;
    }>,
    patterns: Array<{ pattern: string; count: number; severity: string }>,
    insights: Array<{ type: string; message: string; impact: string }>
  ): number {
    // Measure what IS sent WITH compaction (truncated entries + patterns + insights)
    return JSON.stringify({ entries, patterns, insights }).length;
  }

  /**
   * Close cache connection
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function for dependency injection
 */
export function getSmartLogs(
  cache: CacheEngine,
  projectRoot?: string
): SmartLogs {
  return new SmartLogs(cache, projectRoot);
}

/**
 * CLI-friendly function for running smart logs
 */
export async function runSmartLogs(
  options: SmartLogsOptions = {}
): Promise<string> {
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const smartLogs = getSmartLogs(cache, options.projectRoot);
  try {
    const result = await smartLogs.run(options);

    let output = `\n📋 Smart Logs Analysis ${result.summary.fromCache ? '(cached)' : ''}\n`;
    output += `${'='.repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Total Entries: ${result.summary.totalEntries}\n`;
    output += `  Errors: ${result.summary.errorCount}\n`;
    output += `  Warnings: ${result.summary.warnCount}\n`;
    output += `  Time Range: ${result.summary.timeRange}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // Statistics
    output += `Statistics by Level:\n`;
    for (const [level, count] of Object.entries(result.stats.byLevel)) {
      const icon = level === 'error' ? '🔴' : level === 'warn' ? '⚠️' : 'ℹ️';
      output += `  ${icon} ${level}: ${count}\n`;
    }
    output += '\n';

    // Patterns
    if (result.patterns.length > 0) {
      output += `Common Patterns:\n`;
      for (const pattern of result.patterns.slice(0, 5)) {
        const icon =
          pattern.severity === 'critical'
            ? '🔴'
            : pattern.severity === 'high'
              ? '🟡'
              : '🟢';
        output += `  ${icon} ${pattern.pattern} (${pattern.count} occurrences)\n`;
      }
      output += '\n';
    }

    // Recent entries
    if (result.entries.length > 0) {
      output += `Recent Log Entries (showing ${Math.min(result.entries.length, 10)}):\n`;
      for (const entry of result.entries.slice(0, 10)) {
        const icon =
          entry.level === 'error' ? '🔴' : entry.level === 'warn' ? '⚠️' : 'ℹ️';
        const time = new Date(entry.timestamp).toLocaleTimeString();
        output += `  ${icon} [${time}] ${entry.message.substring(0, 80)}\n`;
      }
      output += '\n';
    }

    // Insights
    if (result.insights.length > 0) {
      output += `Insights:\n`;
      for (const insight of result.insights) {
        const icon =
          insight.impact === 'high'
            ? '🔴'
            : insight.impact === 'medium'
              ? '🟡'
              : '🟢';
        output += `  ${icon} [${insight.type}] ${insight.message}\n`;
      }
      output += '\n';
    }

    // Metrics
    output += `Token Reduction:\n`;
    output += `  Original: ${result.metrics.originalTokens} tokens\n`;
    output += `  Compacted: ${result.metrics.compactedTokens} tokens\n`;
    output += `  Reduction: ${result.metrics.reductionPercentage}%\n`;

    return output;
  } finally {
    smartLogs.close();
  }
}

// MCP Tool definition
export const SMART_LOGS_TOOL_DEFINITION = {
  name: 'smart_logs',
  description:
    'System log aggregation and analysis with multi-source support, pattern filtering, error detection, and insights',
  inputSchema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Log sources to aggregate (file paths or system logs)',
      },
      level: {
        type: 'string',
        enum: ['error', 'warn', 'info', 'debug', 'all'],
        description: 'Filter by log level',
        default: 'all',
      },
      pattern: {
        type: 'string',
        description: 'Filter by pattern (regex)',
      },
      tail: {
        type: 'number',
        description: 'Number of lines to tail',
        default: 100,
      },
      follow: {
        type: 'boolean',
        description: 'Follow mode (watch for new entries)',
        default: false,
      },
      since: {
        type: 'string',
        description: "Time range filter (e.g., '1h', '24h', '7d')",
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
    },
  },
};
