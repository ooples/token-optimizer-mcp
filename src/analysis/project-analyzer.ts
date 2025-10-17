/**
 * Project-Level Token Analysis
 * Analyzes token usage across multiple sessions within a project
 */

import fs from 'fs';
import path from 'path';
import { TurnData } from '../utils/thinking-mode.js';

export interface ProjectAnalysisOptions {
  projectPath: string;
  startDate?: string;
  endDate?: string;
  costPerMillionTokens?: number; // Default: OpenAI GPT-4 pricing
}

export interface SessionSummary {
  sessionId: string;
  sessionFile: string;
  totalTokens: number;
  totalOperations: number;
  startTime: string;
  endTime: string;
  duration: string;
  topTools: { toolName: string; tokens: number }[];
}

export interface ProjectAnalysisResult {
  projectPath: string;
  analysisTimestamp: string;
  dateRange: {
    start: string;
    end: string;
  };
  summary: {
    totalSessions: number;
    totalOperations: number;
    totalTokens: number;
    averageTokensPerSession: number;
    averageTokensPerOperation: number;
  };
  sessions: SessionSummary[];
  topContributingSessions: SessionSummary[];
  topTools: {
    toolName: string;
    totalTokens: number;
    operationCount: number;
    sessionCount: number;
    averageTokens: number;
  }[];
  serverBreakdown: {
    serverName: string;
    totalTokens: number;
    operationCount: number;
    percentOfTotal: number;
  }[];
  costEstimation: {
    totalCost: number;
    averageCostPerSession: number;
    currency: string;
    model: string;
    costPerMillionTokens: number;
  };
  recommendations: string[];
}

const DEFAULT_COST_PER_MILLION = 30; // GPT-4 Turbo pricing (USD)

/**
 * Discover all session operation CSV files in the hooks data directory
 */
function discoverSessionFiles(hooksDataPath: string): string[] {
  if (!fs.existsSync(hooksDataPath)) {
    return [];
  }

  const files = fs.readdirSync(hooksDataPath);
  return files
    .filter((file) => file.startsWith('operations-') && file.endsWith('.csv'))
    .map((file) => path.join(hooksDataPath, file))
    .sort();
}

/**
 * Parse a CSV operations file
 */
function parseOperationsFile(filePath: string): TurnData[] {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''); // Strip BOM
  const lines = content.trim().split('\n');
  const operations: TurnData[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split(',');
    if (parts.length < 3) continue;

    const timestamp = parts[0];
    const toolName = parts[1];
    const tokens = parseInt(parts[2], 10) || 0;
    const metadata = parts[3] ? parts[3].trim().replace(/^"(.*)"$/, '$1') : '';

    operations.push({
      timestamp,
      toolName,
      tokens,
      metadata,
    });
  }

  return operations;
}

/**
 * Extract session ID from operations filename
 */
function extractSessionId(filePath: string): string {
  const filename = path.basename(filePath);
  const match = filename.match(/operations-(.+)\.csv$/);
  return match ? match[1] : filename;
}

/**
 * Calculate session duration
 */
function calculateDuration(startTime: string, endTime: string): string {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const duration = end - start;

  const hours = Math.floor(duration / 3600000);
  const minutes = Math.floor((duration % 3600000) / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Analyze a single session file
 */
function analyzeSession(filePath: string): SessionSummary {
  const operations = parseOperationsFile(filePath);
  const sessionId = extractSessionId(filePath);

  if (operations.length === 0) {
    return {
      sessionId,
      sessionFile: filePath,
      totalTokens: 0,
      totalOperations: 0,
      startTime: '',
      endTime: '',
      duration: '0s',
      topTools: [],
    };
  }

  const totalTokens = operations.reduce((sum, op) => sum + op.tokens, 0);
  const startTime = operations[0].timestamp;
  const endTime = operations[operations.length - 1].timestamp;

  // Calculate top tools
  const toolMap = new Map<string, number>();
  for (const op of operations) {
    toolMap.set(op.toolName, (toolMap.get(op.toolName) || 0) + op.tokens);
  }

  const topTools = Array.from(toolMap.entries())
    .map(([toolName, tokens]) => ({ toolName, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  return {
    sessionId,
    sessionFile: filePath,
    totalTokens,
    totalOperations: operations.length,
    startTime,
    endTime,
    duration: calculateDuration(startTime, endTime),
    topTools,
  };
}

/**
 * Analyze all operations across sessions
 */
function aggregateToolUsage(sessionFiles: string[]): {
  toolName: string;
  totalTokens: number;
  operationCount: number;
  sessionCount: number;
  averageTokens: number;
}[] {
  const toolMap = new Map<
    string,
    { totalTokens: number; operationCount: number; sessions: Set<string> }
  >();

  for (const filePath of sessionFiles) {
    const operations = parseOperationsFile(filePath);
    const sessionId = extractSessionId(filePath);

    for (const op of operations) {
      if (!toolMap.has(op.toolName)) {
        toolMap.set(op.toolName, {
          totalTokens: 0,
          operationCount: 0,
          sessions: new Set(),
        });
      }
      const stats = toolMap.get(op.toolName)!;
      stats.totalTokens += op.tokens;
      stats.operationCount++;
      stats.sessions.add(sessionId);
    }
  }

  return Array.from(toolMap.entries())
    .map(([toolName, stats]) => ({
      toolName,
      totalTokens: stats.totalTokens,
      operationCount: stats.operationCount,
      sessionCount: stats.sessions.size,
      averageTokens: stats.totalTokens / stats.operationCount,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Analyze server attribution (MCP servers)
 */
function analyzeServerAttribution(
  sessionFiles: string[],
  totalTokens: number
): {
  serverName: string;
  totalTokens: number;
  operationCount: number;
  percentOfTotal: number;
}[] {
  const serverMap = new Map<string, { totalTokens: number; operationCount: number }>();

  for (const filePath of sessionFiles) {
    const operations = parseOperationsFile(filePath);

    for (const op of operations) {
      let serverName = 'core';
      if (op.toolName.startsWith('mcp__')) {
        const parts = op.toolName.split('__');
        serverName = parts[1] || 'unknown';
      }

      if (!serverMap.has(serverName)) {
        serverMap.set(serverName, { totalTokens: 0, operationCount: 0 });
      }
      const stats = serverMap.get(serverName)!;
      stats.totalTokens += op.tokens;
      stats.operationCount++;
    }
  }

  return Array.from(serverMap.entries())
    .map(([serverName, stats]) => ({
      serverName,
      totalTokens: stats.totalTokens,
      operationCount: stats.operationCount,
      percentOfTotal: (stats.totalTokens / totalTokens) * 100,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Generate recommendations based on project-level analysis
 */
function generateProjectRecommendations(
  sessions: SessionSummary[],
  topTools: {
    toolName: string;
    totalTokens: number;
    operationCount: number;
    sessionCount: number;
  }[],
  totalTokens: number
): string[] {
  const recommendations: string[] = [];

  // Check for high file operation usage
  const fileOpsTokens = topTools
    .filter((t) => ['Read', 'Write', 'Edit', 'Grep', 'Glob'].includes(t.toolName))
    .reduce((sum, t) => sum + t.totalTokens, 0);

  if (fileOpsTokens > totalTokens * 0.4) {
    recommendations.push(
      `File operations consume ${((fileOpsTokens / totalTokens) * 100).toFixed(1)}% of total tokens across all sessions. Consider implementing systematic caching strategies.`
    );
  }

  // Check for session count
  if (sessions.length > 10) {
    recommendations.push(
      `${sessions.length} sessions analyzed. Regular monitoring recommended for projects with high session frequency.`
    );
  }

  // Check for repeated tool usage across sessions
  const repeatTools = topTools.filter((t) => t.sessionCount > sessions.length * 0.5);
  if (repeatTools.length > 0) {
    recommendations.push(
      `${repeatTools.length} tools used in >50% of sessions. Consider creating reusable templates or automation for: ${repeatTools
        .slice(0, 3)
        .map((t) => t.toolName)
        .join(', ')}`
    );
  }

  // Cost-based recommendation
  const avgTokensPerSession = totalTokens / sessions.length;
  if (avgTokensPerSession > 50000) {
    recommendations.push(
      `Average session uses ${Math.round(avgTokensPerSession).toLocaleString()} tokens. Consider breaking down complex tasks into smaller sessions.`
    );
  }

  return recommendations;
}

/**
 * Main project analysis function
 */
export function analyzeProjectTokens(
  options: ProjectAnalysisOptions
): ProjectAnalysisResult {
  const { projectPath, startDate, endDate, costPerMillionTokens = DEFAULT_COST_PER_MILLION } = options;

  // Discover all session files
  const hooksDataPath = path.join(projectPath, '.claude-global', 'hooks', 'data');
  let sessionFiles = discoverSessionFiles(hooksDataPath);

  if (sessionFiles.length === 0) {
    // Try global hooks directory if project-specific not found
    const globalHooksPath = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude-global',
      'hooks',
      'data'
    );
    sessionFiles = discoverSessionFiles(globalHooksPath);
  }

  if (sessionFiles.length === 0) {
    throw new Error('No session files found. Ensure PowerShell hooks are configured.');
  }

  // Filter by date range if specified
  if (startDate || endDate) {
    sessionFiles = sessionFiles.filter((file) => {
      const sessionId = extractSessionId(file);
      // Extract date from session ID (format: YYYYMMDD-HHMMSS-XXXX or UUID)
      const dateMatch = sessionId.match(/^(\d{8})/);
      if (!dateMatch) return true; // Include UUID-based sessions

      const fileDate = dateMatch[1];
      if (startDate && fileDate < startDate.replace(/-/g, '')) return false;
      if (endDate && fileDate > endDate.replace(/-/g, '')) return false;
      return true;
    });
  }

  // Analyze each session
  const sessions = sessionFiles.map(analyzeSession);

  // Calculate summary statistics
  const totalOperations = sessions.reduce((sum, s) => sum + s.totalOperations, 0);
  const totalTokens = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
  const averageTokensPerSession = totalTokens / sessions.length;
  const averageTokensPerOperation = totalTokens / totalOperations;

  // Get top contributing sessions
  const topContributingSessions = [...sessions]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);

  // Aggregate tool usage
  const topTools = aggregateToolUsage(sessionFiles).slice(0, 20);

  // Analyze server attribution
  const serverBreakdown = analyzeServerAttribution(sessionFiles, totalTokens);

  // Calculate cost estimation
  const totalCost = (totalTokens / 1000000) * costPerMillionTokens;
  const averageCostPerSession = totalCost / sessions.length;

  // Generate recommendations
  const recommendations = generateProjectRecommendations(sessions, topTools, totalTokens);

  // Determine date range
  const allDates = sessions
    .filter((s) => s.startTime)
    .map((s) => new Date(s.startTime).getTime());
  const startTimestamp = allDates.length > 0 ? Math.min(...allDates) : Date.now();
  const endTimestamp = allDates.length > 0 ? Math.max(...allDates) : Date.now();

  return {
    projectPath,
    analysisTimestamp: new Date().toISOString(),
    dateRange: {
      start: new Date(startTimestamp).toISOString(),
      end: new Date(endTimestamp).toISOString(),
    },
    summary: {
      totalSessions: sessions.length,
      totalOperations,
      totalTokens,
      averageTokensPerSession: Math.round(averageTokensPerSession),
      averageTokensPerOperation: Math.round(averageTokensPerOperation),
    },
    sessions,
    topContributingSessions,
    topTools,
    serverBreakdown,
    costEstimation: {
      totalCost: parseFloat(totalCost.toFixed(2)),
      averageCostPerSession: parseFloat(averageCostPerSession.toFixed(2)),
      currency: 'USD',
      model: 'GPT-4 Turbo',
      costPerMillionTokens,
    },
    recommendations,
  };
}
