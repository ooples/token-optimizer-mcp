/**
 * Session Analysis Engine
 * Provides detailed analysis of session token usage patterns
 */

import {
  TurnData,
  TurnSummary,
  analyzeTurns,
  detectAnomalies,
} from '../utils/thinking-mode.js';

export interface SessionAnalysisOptions {
  groupBy?: 'turn' | 'tool' | 'server' | 'hour';
  topN?: number;
  anomalyThreshold?: number;
}

export interface ToolUsageStats {
  toolName: string;
  count: number;
  totalTokens: number;
  averageTokens: number;
  percentOfTotal: number;
}

export interface ServerUsageStats {
  serverName: string;
  count: number;
  totalTokens: number;
  averageTokens: number;
  percentOfTotal: number;
  tools: string[];
}

export interface HourlyUsageStats {
  hour: string;
  totalTokens: number;
  operationCount: number;
  averageTokens: number;
}

export interface AnalysisResult {
  summary: {
    totalOperations: number;
    totalTokens: number;
    averageTurnTokens: number;
    sessionDuration: string;
    thinkingTurns: number;
    planningTurns: number;
    normalTurns: number;
  };
  topConsumers: ToolUsageStats[];
  byServer: ServerUsageStats[];
  hourlyTrend: HourlyUsageStats[];
  anomalies: TurnSummary[];
  recommendations: string[];
  efficiency: {
    tokensPerTool: number;
    thinkingModePercent: number;
    cacheHitPotential: string;
  };
}

/**
 * Main analysis function
 */
export function analyzeTokenUsage(
  operations: TurnData[],
  options: SessionAnalysisOptions = {}
): AnalysisResult {
  const { topN = 10, anomalyThreshold = 3 } = options;

  // Analyze turns
  const turns = analyzeTurns(operations);
  const anomalies = detectAnomalies(turns, anomalyThreshold);

  // Calculate summary stats
  const totalTokens = operations.reduce((sum, op) => sum + op.tokens, 0);
  const thinkingTurns = turns.filter((t) => t.mode === 'thinking').length;
  const planningTurns = turns.filter((t) => t.mode === 'planning').length;
  const normalTurns = turns.filter((t) => t.mode === 'normal').length;

  // Tool usage analysis
  const toolStats = analyzeByTool(operations, totalTokens);
  const topConsumers = toolStats.slice(0, topN);

  // Server analysis (MCP servers)
  const serverStats = analyzeByServer(operations, totalTokens);

  // Hourly trend analysis
  const hourlyStats = analyzeByHour(operations);

  // Generate recommendations
  const recommendations = generateRecommendations(
    toolStats,
    turns,
    anomalies,
    totalTokens
  );

  // Calculate efficiency metrics
  const tokensPerTool = totalTokens / operations.length;
  const thinkingModePercent = (thinkingTurns / turns.length) * 100;
  const cacheHitPotential = calculateCacheHitPotential(operations);

  // Calculate session duration
  const timestamps = operations.map((op) => new Date(op.timestamp).getTime());
  const duration = Math.max(...timestamps) - Math.min(...timestamps);
  const hours = Math.floor(duration / 3600000);
  const minutes = Math.floor((duration % 3600000) / 60000);
  const sessionDuration = `${hours}h ${minutes}m`;

  return {
    summary: {
      totalOperations: operations.length,
      totalTokens,
      averageTurnTokens: totalTokens / turns.length,
      sessionDuration,
      thinkingTurns,
      planningTurns,
      normalTurns,
    },
    topConsumers,
    byServer: serverStats,
    hourlyTrend: hourlyStats,
    anomalies,
    recommendations,
    efficiency: {
      tokensPerTool,
      thinkingModePercent,
      cacheHitPotential,
    },
  };
}

function analyzeByTool(
  operations: TurnData[],
  totalTokens: number
): ToolUsageStats[] {
  const toolMap = new Map<string, { count: number; totalTokens: number }>();

  for (const op of operations) {
    if (!toolMap.has(op.toolName)) {
      toolMap.set(op.toolName, { count: 0, totalTokens: 0 });
    }
    const stats = toolMap.get(op.toolName)!;
    stats.count++;
    stats.totalTokens += op.tokens;
  }

  const toolStats: ToolUsageStats[] = [];
  for (const [toolName, stats] of toolMap.entries()) {
    toolStats.push({
      toolName,
      count: stats.count,
      totalTokens: stats.totalTokens,
      averageTokens: stats.totalTokens / stats.count,
      percentOfTotal: (stats.totalTokens / totalTokens) * 100,
    });
  }

  return toolStats.sort((a, b) => b.totalTokens - a.totalTokens);
}

function analyzeByServer(
  operations: TurnData[],
  totalTokens: number
): ServerUsageStats[] {
  const serverMap = new Map<
    string,
    { count: number; totalTokens: number; tools: Set<string> }
  >();

  for (const op of operations) {
    // Extract server name from MCP tool names (e.g., mcp__ambiance__local_context)
    let serverName = 'core';
    if (op.toolName.startsWith('mcp__')) {
      const parts = op.toolName.split('__');
      serverName = parts[1] || 'unknown';
    }

    if (!serverMap.has(serverName)) {
      serverMap.set(serverName, { count: 0, totalTokens: 0, tools: new Set() });
    }
    const stats = serverMap.get(serverName)!;
    stats.count++;
    stats.totalTokens += op.tokens;
    stats.tools.add(op.toolName);
  }

  const serverStats: ServerUsageStats[] = [];
  for (const [serverName, stats] of serverMap.entries()) {
    serverStats.push({
      serverName,
      count: stats.count,
      totalTokens: stats.totalTokens,
      averageTokens: stats.totalTokens / stats.count,
      percentOfTotal: (stats.totalTokens / totalTokens) * 100,
      tools: Array.from(stats.tools),
    });
  }

  return serverStats.sort((a, b) => b.totalTokens - a.totalTokens);
}

function analyzeByHour(operations: TurnData[]): HourlyUsageStats[] {
  const hourMap = new Map<string, { totalTokens: number; count: number }>();

  for (const op of operations) {
    const date = new Date(op.timestamp);
    const hour = `${date.getHours().toString().padStart(2, '0')}:00`;

    if (!hourMap.has(hour)) {
      hourMap.set(hour, { totalTokens: 0, count: 0 });
    }
    const stats = hourMap.get(hour)!;
    stats.totalTokens += op.tokens;
    stats.count++;
  }

  const hourlyStats: HourlyUsageStats[] = [];
  for (const [hour, stats] of hourMap.entries()) {
    hourlyStats.push({
      hour,
      totalTokens: stats.totalTokens,
      operationCount: stats.count,
      averageTokens: stats.totalTokens / stats.count,
    });
  }

  return hourlyStats.sort((a, b) => a.hour.localeCompare(b.hour));
}

function generateRecommendations(
  toolStats: ToolUsageStats[],
  turns: TurnSummary[],
  anomalies: TurnSummary[],
  totalTokens: number
): string[] {
  const recommendations: string[] = [];

  // Check for high Read/Grep usage
  const readTokens =
    toolStats.find((t) => t.toolName === 'Read')?.totalTokens || 0;
  const grepTokens =
    toolStats.find((t) => t.toolName === 'Grep')?.totalTokens || 0;
  const fileOpsTokens = readTokens + grepTokens;

  if (fileOpsTokens > totalTokens * 0.3) {
    recommendations.push(
      `File operations (Read/Grep) consume ${((fileOpsTokens / totalTokens) * 100).toFixed(1)}% of tokens. Consider using Token Optimizer MCP to cache frequently read files.`
    );
  }

  // Check for thinking mode frequency
  const thinkingTurns = turns.filter((t) => t.mode === 'thinking').length;
  if (thinkingTurns > turns.length * 0.3) {
    recommendations.push(
      `${((thinkingTurns / turns.length) * 100).toFixed(1)}% of turns are in thinking mode. This is normal for complex tasks but consider breaking down large problems.`
    );
  }

  // Check for anomalies
  if (anomalies.length > 0) {
    recommendations.push(
      `${anomalies.length} turns with unusually high token usage detected. Review these turns for optimization opportunities.`
    );
  }

  // Check for MCP tool usage
  const mcpTokens = toolStats
    .filter((t) => t.toolName.startsWith('mcp__'))
    .reduce((sum, t) => sum + t.totalTokens, 0);

  if (mcpTokens < totalTokens * 0.1) {
    recommendations.push(
      'Low MCP tool usage detected. Consider using specialized MCP servers (Ambiance, Sequential Thinking, Memory) for more efficient operations.'
    );
  }

  return recommendations;
}

function calculateCacheHitPotential(operations: TurnData[]): string {
  // Analyze file operations for caching potential
  const fileOps = operations.filter(
    (op) =>
      op.toolName === 'Read' ||
      op.toolName === 'Write' ||
      op.toolName === 'Edit'
  );

  const filePathMap = new Map<string, number>();
  for (const op of fileOps) {
    if (op.metadata) {
      filePathMap.set(op.metadata, (filePathMap.get(op.metadata) || 0) + 1);
    }
  }

  const duplicates = Array.from(filePathMap.values()).filter(
    (count) => count > 1
  );
  const potentialSavings = duplicates.reduce(
    (sum, count) => sum + count - 1,
    0
  );

  if (potentialSavings > fileOps.length * 0.2) {
    return 'High - Many files read multiple times';
  } else if (potentialSavings > fileOps.length * 0.1) {
    return 'Medium - Some files read multiple times';
  }
  return 'Low - Most files read once';
}
