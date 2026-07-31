/**
 * Project-Level Token Analysis
 * Analyzes token usage across multiple sessions within a project
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
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
 * Discover session logs in the hooks data directory.
 *
 * READ WHAT THE HOOKS ACTUALLY WRITE.
 *
 * This looked only for `session-log-*.jsonl`. Nothing in this package has ever
 * written that file: the PowerShell orchestrator logs every tool call to
 * `operations-<sessionId>.csv` (header `timestamp,toolName,tokens,metadata`,
 * see hooks/handlers/token-optimizer-orchestrator.ps1). So on a correctly
 * installed machine with months of recorded usage -- 235 KB of it on the box
 * this was found on -- analyze_project_tokens found nothing and answered
 * "No session files found. Ensure PowerShell hooks are configured."
 *
 * Being told to configure something already working, while the data sits
 * unread in the very directory named by the error, is worse than a crash: it
 * sends the user to fix the one thing that was never broken.
 *
 * Both formats are accepted now. JSONL stays because the web server writes it
 * for live sessions; CSV is added because it is what actually accumulates.
 */
async function discoverSessionFiles(hooksDataPath: string): Promise<string[]> {
  try {
    await fs.access(hooksDataPath);
  } catch {
    return [];
  }

  const files = await fs.readdir(hooksDataPath);
  return files
    .filter(
      (file) =>
        (file.startsWith('session-log-') && file.endsWith('.jsonl')) ||
        (file.startsWith('operations-') && file.endsWith('.csv'))
    )
    .map((file) => path.join(hooksDataPath, file))
    .sort();
}

/**
 * Splits one CSV record, honouring double quotes.
 *
 * The metadata column routinely contains commas -- Windows paths, key=value
 * pairs -- so a naive split on ',' silently truncates it and misattributes the
 * rest to columns that do not exist.
 */
function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * Parse an `operations-<sessionId>.csv` log -- the format the hooks write.
 */
async function parseCsvFile(filePath: string): Promise<TurnData[]> {
  const content = (await fs.readFile(filePath, 'utf-8')).replace(/^﻿/, '');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = splitCsvRow(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iTime = col('timestamp');
  const iTool = col('toolname');
  const iTokens = col('tokens');
  const iMeta = col('metadata');

  // Without a timestamp and a tool name there is no operation to report. Say
  // nothing rather than emit rows of undefined.
  if (iTime === -1 || iTool === -1) return [];

  const operations: TurnData[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvRow(line);
    const toolName = cells[iTool]?.trim();
    const timestamp = cells[iTime]?.trim();
    if (!toolName || !timestamp) continue;

    const tokens = Number(cells[iTokens]?.trim());
    operations.push({
      timestamp,
      toolName,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      metadata: iMeta === -1 ? '' : (cells[iMeta] ?? '').trim(),
    });
  }

  return operations;
}

/**
 * Parse a session log, whichever of the two formats it is in.
 */
async function parseSessionFile(filePath: string): Promise<TurnData[]> {
  return filePath.endsWith('.csv')
    ? parseCsvFile(filePath)
    : parseJsonlFile(filePath);
}

/**
 * Parse a JSONL session log file
 */
async function parseJsonlFile(filePath: string): Promise<TurnData[]> {
  const content = (await fs.readFile(filePath, 'utf-8')).replace(/^\uFEFF/, ''); // Strip BOM
  const lines = content.trim().split('\n');
  const operations: TurnData[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);

      // Validate required fields
      if (!event.type || typeof event.type !== 'string') continue;

      // Process tool calls
      if (event.type === 'tool_call') {
        if (!event.timestamp || !event.toolName) continue;

        const tokens = event.estimatedTokens || 0;
        operations.push({
          timestamp: event.timestamp,
          toolName: event.toolName,
          tokens,
          // Normalize metadata to string
          metadata:
            typeof event.metadata === 'string'
              ? event.metadata
              : event.metadata !== undefined
                ? JSON.stringify(event.metadata)
                : '',
        });
      }
    } catch {
      // Skip malformed JSONL lines
      continue;
    }
  }

  return operations;
}

/**
 * Extract session ID from session log filename
 */
function extractSessionId(filePath: string): string {
  const filename = path.basename(filePath);
  const match =
    filename.match(/session-log-(.+)\.jsonl$/) ??
    filename.match(/operations-(.+)\.csv$/);
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
 * Analyze a single session file using pre-parsed operations
 */
function analyzeSession(
  filePath: string,
  operations: TurnData[]
): SessionSummary {
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
 * Analyze all operations across sessions using pre-parsed data
 */
function aggregateToolUsage(parsedSessions: Map<string, TurnData[]>): {
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

  for (const [sessionId, operations] of parsedSessions.entries()) {
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
 * Analyze server attribution (MCP servers) using pre-parsed data
 */
function analyzeServerAttribution(
  parsedSessions: Map<string, TurnData[]>,
  totalTokens: number
): {
  serverName: string;
  totalTokens: number;
  operationCount: number;
  percentOfTotal: number;
}[] {
  const serverMap = new Map<
    string,
    { totalTokens: number; operationCount: number }
  >();

  for (const operations of parsedSessions.values()) {
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
      percentOfTotal:
        totalTokens === 0 ? 0 : (stats.totalTokens / totalTokens) * 100,
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
    .filter((t) =>
      ['Read', 'Write', 'Edit', 'Grep', 'Glob'].includes(t.toolName)
    )
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
  const repeatTools = topTools.filter(
    (t) => t.sessionCount > sessions.length * 0.5
  );
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
export async function analyzeProjectTokens(
  options: ProjectAnalysisOptions
): Promise<ProjectAnalysisResult> {
  const {
    projectPath,
    startDate,
    endDate,
    costPerMillionTokens = DEFAULT_COST_PER_MILLION,
  } = options;

  // Discover all session files
  const hooksDataPath = path.join(
    projectPath,
    '.claude-global',
    'hooks',
    'data'
  );
  let sessionFiles = await discoverSessionFiles(hooksDataPath);

  if (sessionFiles.length === 0) {
    // Try global hooks directory if project-specific not found
    const globalHooksPath = path.join(
      os.homedir(),
      '.claude-global',
      'hooks',
      'data'
    );
    sessionFiles = await discoverSessionFiles(globalHooksPath);
  }

  if (sessionFiles.length === 0) {
    throw new Error(
      `No session files found. Ensure PowerShell hooks are configured.\nSearched directories:\n- ${hooksDataPath}\n- ${path.join(os.homedir(), '.claude-global', 'hooks', 'data')}`
    );
  }

  // Filter by date range if specified
  if (startDate || endDate) {
    const startDateStr = startDate ? startDate.replace(/-/g, '') : null;
    const endDateStr = endDate ? endDate.replace(/-/g, '') : null;

    // Filter with async file stat for UUID-based sessions
    sessionFiles = (
      await Promise.all(
        sessionFiles.map(async (file) => {
          const sessionId = extractSessionId(file);
          // Extract date from session ID (format: YYYYMMDD-HHMMSS-XXXX or UUID)
          const dateMatch = sessionId.match(/^(\d{8})/);
          let fileDate: string | null = null;

          if (dateMatch) {
            fileDate = dateMatch[1];
          } else {
            // Try to get file mtime as date for UUID-based sessions
            try {
              const stat = await fs.stat(file);
              const mtime = stat.mtime;
              // Format mtime as YYYYMMDD
              const mtimeStr = [
                mtime.getFullYear().toString().padStart(4, '0'),
                (mtime.getMonth() + 1).toString().padStart(2, '0'),
                mtime.getDate().toString().padStart(2, '0'),
              ].join('');
              fileDate = mtimeStr;
            } catch {
              // If we can't get mtime, exclude the file when date filter is active
              return null;
            }
          }

          if (startDateStr && fileDate && fileDate < startDateStr) return null;
          if (endDateStr && fileDate && fileDate > endDateStr) return null;
          return file;
        })
      )
    ).filter((f): f is string => f !== null);
  }

  // Parse all files with concurrency limit to avoid resource exhaustion
  // Process in batches of 10 to limit concurrent file operations
  // Wrap per-file parsing in try-catch to skip corrupt/unreadable files
  const parsedSessions = new Map<string, TurnData[]>();
  const batchSize = 10;
  for (let i = 0; i < sessionFiles.length; i += batchSize) {
    const batch = sessionFiles.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (filePath) => {
        try {
          const sessionId = extractSessionId(filePath);
          const operations = await parseSessionFile(filePath);
          parsedSessions.set(sessionId, operations);
        } catch (error) {
          console.warn(
            `Skipping corrupt/unreadable JSONL file: ${filePath}`,
            error
          );
        }
      })
    );
  }

  // Analyze each session using pre-parsed data
  const sessions = sessionFiles
    .map((filePath) => {
      const sessionId = extractSessionId(filePath);
      const operations = parsedSessions.get(sessionId);
      return operations ? analyzeSession(filePath, operations) : null;
    })
    .filter((s): s is SessionSummary => s !== null);

  // Calculate summary statistics
  const totalOperations = sessions.reduce(
    (sum, s) => sum + s.totalOperations,
    0
  );
  const totalTokens = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
  const averageTokensPerSession =
    sessions.length === 0 ? 0 : totalTokens / sessions.length;
  const averageTokensPerOperation =
    totalOperations === 0 ? 0 : totalTokens / totalOperations;

  // Get top contributing sessions
  const topContributingSessions = [...sessions]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10);

  // Aggregate tool usage using cached parsed data
  const topTools = aggregateToolUsage(parsedSessions).slice(0, 20);

  // Analyze server attribution using cached parsed data
  const serverBreakdown = analyzeServerAttribution(parsedSessions, totalTokens);

  // Calculate cost estimation
  const totalCost = (totalTokens / 1000000) * costPerMillionTokens;
  const averageCostPerSession =
    sessions.length > 0 ? totalCost / sessions.length : 0;

  // Generate recommendations
  const recommendations = generateProjectRecommendations(
    sessions,
    topTools,
    totalTokens
  );

  // Determine date range
  const allStartDates = sessions
    .filter((s) => s.startTime)
    .map((s) => new Date(s.startTime).getTime());
  const allEndDates = sessions
    .filter((s) => s.endTime)
    .map((s) => new Date(s.endTime).getTime());
  const startTimestamp =
    allStartDates.length > 0 ? Math.min(...allStartDates) : Date.now();
  const endTimestamp =
    allEndDates.length > 0 ? Math.max(...allEndDates) : Date.now();

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
      averageTokensPerSession:
        sessions.length === 0 ? 0 : Math.round(averageTokensPerSession),
      averageTokensPerOperation:
        totalOperations === 0 ? 0 : Math.round(averageTokensPerOperation),
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
