#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { CacheEngine } from '../core/cache-engine.js';
import { TokenCounter } from '../core/token-counter.js';
import { CompressionEngine } from '../core/compression-engine.js';
import {
  analyzeTokenUsage,
  SessionAnalysisOptions,
} from '../analysis/session-analyzer.js';
import {
  generateReport,
  ReportFormat,
  ReportOptions,
} from '../analysis/report-generator.js';
import { TurnData } from '../utils/thinking-mode.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Build Systems tools
import {
  getSmartProcessesTool,
  SMART_PROCESSES_TOOL_DEFINITION,
} from '../tools/build-systems/smart-processes.js';
import {
  getSmartNetwork,
  SMART_NETWORK_TOOL_DEFINITION,
} from '../tools/build-systems/smart-network.js';
import {
  getSmartLogs,
  SMART_LOGS_TOOL_DEFINITION,
} from '../tools/build-systems/smart-logs.js';
import {
  getSmartLintTool,
  SMART_LINT_TOOL_DEFINITION,
} from '../tools/build-systems/smart-lint.js';
import {
  getSmartInstall,
  SMART_INSTALL_TOOL_DEFINITION,
} from '../tools/build-systems/smart-install.js';
import {
  getSmartDocker,
  SMART_DOCKER_TOOL_DEFINITION,
} from '../tools/build-systems/smart-docker.js';
import {
  getSmartBuildTool,
  SMART_BUILD_TOOL_DEFINITION,
} from '../tools/build-systems/smart-build.js';
import {
  getSmartSystemMetrics,
  SMART_SYSTEM_METRICS_TOOL_DEFINITION,
} from '../tools/build-systems/smart-system-metrics.js';
import {
  getSmartTestTool,
  SMART_TEST_TOOL_DEFINITION,
} from '../tools/build-systems/smart-test.js';
import {
  getSmartTypeCheckTool,
  SMART_TYPECHECK_TOOL_DEFINITION,
} from '../tools/build-systems/smart-typecheck.js';
// System Operations tools
import {
  getSmartCron,
  SMART_CRON_TOOL_DEFINITION,
} from '../tools/system-operations/smart-cron.js';
import {
  getSmartUser,
  SMART_USER_TOOL_DEFINITION,
} from '../tools/system-operations/smart-user.js';
// Advanced Caching tools
import {
  getPredictiveCacheTool,
  PREDICTIVE_CACHE_TOOL_DEFINITION,
} from '../tools/advanced-caching/predictive-cache.js';
import {
  getCacheWarmupTool,
  CACHE_WARMUP_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-warmup.js';
import { MetricsCollector } from '../core/metrics.js';

// Initialize core modules
const cache = new CacheEngine();
const tokenCounter = new TokenCounter();
const compression = new CompressionEngine();

// Initialize metrics
const metrics = new MetricsCollector();

// Initialize Build Systems tools
const smartProcesses = getSmartProcessesTool(cache, tokenCounter, metrics);
const smartNetwork = getSmartNetwork(cache);
const smartLogs = getSmartLogs(cache);
const smartLint = getSmartLintTool(cache, tokenCounter, metrics);
const smartInstall = getSmartInstall(cache);
const smartDocker = getSmartDocker(cache);
const smartBuild = getSmartBuildTool(cache, tokenCounter, metrics);
const smartSystemMetrics = getSmartSystemMetrics(cache);
const smartTest = getSmartTestTool(cache, tokenCounter, metrics);
const smartTypeCheck = getSmartTypeCheckTool(cache, tokenCounter, metrics);

// Initialize System Operations tools
const smartCron = getSmartCron(cache, tokenCounter, metrics);
const smartUser = getSmartUser(cache, tokenCounter, metrics);

// Initialize Advanced Caching tools
const predictiveCacheTool = getPredictiveCacheTool(cache, tokenCounter, metrics);
const cacheWarmupTool = getCacheWarmupTool(cache, tokenCounter, metrics);

// Create MCP server
const server = new Server(
  {
    name: 'token-optimizer-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'optimize_text',
        description:
          'Compress and cache text to reduce token usage. Returns compressed version and saves to cache for future use.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to optimize',
            },
            key: {
              type: 'string',
              description: 'Cache key for storing the optimized text',
            },
            quality: {
              type: 'number',
              description: 'Compression quality (0-11, default 11)',
              minimum: 0,
              maximum: 11,
            },
          },
          required: ['text', 'key'],
        },
      },
      {
        name: 'get_cached',
        description:
          'Retrieve previously cached and optimized text. Returns the original text if found in cache.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Cache key to retrieve',
            },
          },
          required: ['key'],
        },
      },
      {
        name: 'count_tokens',
        description:
          'Count tokens in text using tiktoken. Useful for understanding token usage before and after optimization.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to count tokens for',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'compress_text',
        description:
          'Compress text using Brotli compression. Returns compressed text as base64 string.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to compress',
            },
            quality: {
              type: 'number',
              description: 'Compression quality (0-11, default 11)',
              minimum: 0,
              maximum: 11,
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'decompress_text',
        description: 'Decompress base64-encoded Brotli-compressed text.',
        inputSchema: {
          type: 'object',
          properties: {
            compressed: {
              type: 'string',
              description: 'Base64-encoded compressed text',
            },
          },
          required: ['compressed'],
        },
      },
      {
        name: 'get_cache_stats',
        description:
          'Get cache statistics including hit rate, compression ratio, and token savings.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'clear_cache',
        description: 'Clear all cached data. Use with caution.',
        inputSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              description: 'Must be true to confirm cache clearing',
            },
          },
          required: ['confirm'],
        },
      },
      {
        name: 'analyze_optimization',
        description:
          'Analyze text and provide recommendations for optimization including compression benefits and token savings.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to analyze',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'get_session_stats',
        description:
          'Get comprehensive statistics from the PowerShell wrapper session tracker including system reminders, tool operations, and total tokens with accurate tiktoken-based counting.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description:
                'Optional session ID to query. If not provided, uses current session.',
            },
          },
        },
      },
      {
        name: 'optimize_session',
        description:
          'Analyzes operations in the current session from the operations CSV, identifies large text blocks from file-based tools (Read, Write, Edit), compresses them, and stores them in the cache to reduce future token usage. Returns a summary of the optimization.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description:
                'Optional session ID to optimize. If not provided, uses the current active session.',
            },
            min_token_threshold: {
              type: 'number',
              description:
                'Minimum token count for a file operation to be considered for compression. Defaults to 30.',
            },
          },
        },
      },
      {
        name: 'generate_session_report',
        description:
          'Generate a comprehensive session report with token usage analysis, thinking mode detection, and visualizations. Supports HTML (with interactive charts), Markdown, and JSON formats.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description:
                'Optional session ID to analyze. If not provided, uses the current active session.',
            },
            format: {
              type: 'string',
              enum: ['html', 'markdown', 'json'],
              description: 'Output format for the report (default: html)',
            },
            outputPath: {
              type: 'string',
              description:
                'Optional path to save the report. If not provided, returns the report content.',
            },
          },
        },
      },
      {
        name: 'analyze_token_usage',
        description:
          'Perform detailed analysis of token usage patterns including top consumers, trends over time, anomaly detection, and optimization recommendations.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description:
                'Optional session ID to analyze. If not provided, uses the current active session.',
            },
            groupBy: {
              type: 'string',
              enum: ['turn', 'tool', 'server', 'hour'],
              description: 'How to group the analysis (default: turn)',
            },
            topN: {
              type: 'number',
              description: 'Number of top consumers to return (default: 10)',
            },
            anomalyThreshold: {
              type: 'number',
              description:
                'Multiplier for detecting anomalies (default: 3x average)',
            },
          },
        },
      },
      // Build Systems tools
      SMART_PROCESSES_TOOL_DEFINITION,
      SMART_NETWORK_TOOL_DEFINITION,
      SMART_LOGS_TOOL_DEFINITION,
      SMART_LINT_TOOL_DEFINITION,
      SMART_INSTALL_TOOL_DEFINITION,
      SMART_DOCKER_TOOL_DEFINITION,
      SMART_BUILD_TOOL_DEFINITION,
      SMART_SYSTEM_METRICS_TOOL_DEFINITION,
      SMART_TEST_TOOL_DEFINITION,
      SMART_TYPECHECK_TOOL_DEFINITION,
      // System Operations tools
      SMART_CRON_TOOL_DEFINITION,
      SMART_USER_TOOL_DEFINITION,
      // Advanced Caching tools
      PREDICTIVE_CACHE_TOOL_DEFINITION,
      CACHE_WARMUP_TOOL_DEFINITION,
      {
        name: 'get_session_summary',
        description:
          'Get comprehensive session summary from session-log.jsonl including total tokens, turns, tool/hook counts, token breakdown by category and server, and duration. Reads from the new JSONL logging format (Priority 2).',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description:
                'Optional session ID to summarize. If not provided, uses the current active session.',
            },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'optimize_text': {
        const { text, key, quality } = args as {
          text: string;
          key: string;
          quality?: number;
        };

        // Count original tokens
        const originalCount = tokenCounter.count(text);

        // Compress text
        const compressionResult = compression.compressToBase64(text, {
          quality,
        });

        // Cache the compressed text
        cache.set(
          key,
          compressionResult.compressed,
          compressionResult.compressedSize,
          compressionResult.originalSize
        );

        // Count compressed tokens
        const compressedCount = tokenCounter.count(
          compressionResult.compressed
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  key,
                  originalTokens: originalCount.tokens,
                  compressedTokens: compressedCount.tokens,
                  tokensSaved: originalCount.tokens - compressedCount.tokens,
                  percentSaved: compressionResult.percentSaved,
                  originalSize: compressionResult.originalSize,
                  compressedSize: compressionResult.compressedSize,
                  cached: true,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'get_cached': {
        const { key } = args as { key: string };

        const cached = cache.get(key);
        if (!cached) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Cache miss - key not found',
                  key,
                }),
              },
            ],
          };
        }

        // Decompress
        const decompressed = compression.decompressFromBase64(cached);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                key,
                text: decompressed,
                fromCache: true,
              }),
            },
          ],
        };
      }

      case 'count_tokens': {
        const { text } = args as { text: string };
        const result = tokenCounter.count(text);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'compress_text': {
        const { text, quality } = args as { text: string; quality?: number };
        const result = compression.compressToBase64(text, { quality });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'decompress_text': {
        const { compressed } = args as { compressed: string };
        const text = compression.decompressFromBase64(compressed);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ text }, null, 2),
            },
          ],
        };
      }

      case 'get_cache_stats': {
        const stats = cache.getStats();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      case 'clear_cache': {
        const { confirm } = args as { confirm: boolean };

        if (!confirm) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Must set confirm=true to clear cache',
                }),
              },
            ],
          };
        }

        cache.clear();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Cache cleared successfully',
              }),
            },
          ],
        };
      }

      case 'analyze_optimization': {
        const { text } = args as { text: string };

        // Get token count
        const tokenResult = tokenCounter.count(text);

        // Get compression stats
        const compStats = compression.getCompressionStats(text);

        // Estimate potential savings
        const compressedTokens = tokenCounter.count(
          compression.compressToBase64(text).compressed
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  tokens: {
                    current: tokenResult.tokens,
                    afterCompression: compressedTokens.tokens,
                    saved: tokenResult.tokens - compressedTokens.tokens,
                    percentSaved:
                      ((tokenResult.tokens - compressedTokens.tokens) /
                        tokenResult.tokens) *
                      100,
                  },
                  size: {
                    current: compStats.uncompressed,
                    compressed: compStats.compressed,
                    ratio: compStats.ratio,
                    percentSaved: compStats.percentSaved,
                  },
                  recommendations: {
                    shouldCompress: compStats.recommended,
                    reason: compStats.recommended
                      ? 'Compression will provide significant token savings'
                      : 'Text is too small or compression benefit is minimal',
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'get_session_stats': {
        const { sessionId } = args as { sessionId?: string };

        try {
          // Path to hooks data directory
          const hooksDataPath = path.join(
            os.homedir(),
            '.claude-global',
            'hooks',
            'data'
          );

          // Read current session file
          const sessionFilePath = path.join(
            hooksDataPath,
            'current-session.txt'
          );

          if (!fs.existsSync(sessionFilePath)) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: 'No active session found',
                    sessionFilePath,
                  }),
                },
              ],
            };
          }

          // Strip BOM and parse JSON
          const sessionContent = fs
            .readFileSync(sessionFilePath, 'utf-8')
            .replace(/^\uFEFF/, '');
          const sessionData = JSON.parse(sessionContent);

          const targetSessionId = sessionId || sessionData.sessionId;

          // Read operations CSV
          const csvFilePath = path.join(
            hooksDataPath,
            `operations-${targetSessionId}.csv`
          );

          if (!fs.existsSync(csvFilePath)) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `Operations file not found for session ${targetSessionId}`,
                    csvFilePath,
                  }),
                },
              ],
            };
          }

          // Parse CSV
          const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
          const lines = csvContent.trim().split('\n');

          interface Operation {
            timestamp: string;
            toolName: string;
            tokens: number;
            metadata: string;
          }

          const operations: Operation[] = [];
          let systemReminderTokens = 0;
          let toolTokens = 0;

          for (const line of lines) {
            if (!line.trim()) continue;

            const parts = line.split(',');
            if (parts.length < 3) continue;

            const timestamp = parts[0];
            const toolName = parts[1];
            const tokens = parseInt(parts[2], 10) || 0;
            const metadata = parts[3] || '';

            operations.push({
              timestamp,
              toolName,
              tokens,
              metadata,
            });

            if (toolName === 'SYSTEM_REMINDERS') {
              systemReminderTokens = tokens;
            } else {
              toolTokens += tokens;
            }
          }

          // Calculate statistics
          const totalTokens = systemReminderTokens + toolTokens;
          const systemReminderPercent =
            totalTokens > 0 ? (systemReminderTokens / totalTokens) * 100 : 0;
          const toolPercent =
            totalTokens > 0 ? (toolTokens / totalTokens) * 100 : 0;

          // Group operations by tool
          const toolBreakdown: Record<
            string,
            { count: number; tokens: number }
          > = {};
          for (const op of operations) {
            if (op.toolName === 'SYSTEM_REMINDERS') continue;

            if (!toolBreakdown[op.toolName]) {
              toolBreakdown[op.toolName] = { count: 0, tokens: 0 };
            }
            toolBreakdown[op.toolName].count++;
            toolBreakdown[op.toolName].tokens += op.tokens;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    sessionId: targetSessionId,
                    sessionInfo: {
                      startTime: sessionData.startTime,
                      lastActivity: sessionData.lastActivity,
                      totalOperations: sessionData.totalOperations,
                    },
                    tokens: {
                      total: totalTokens,
                      systemReminders: systemReminderTokens,
                      tools: toolTokens,
                      breakdown: {
                        systemReminders: {
                          tokens: systemReminderTokens,
                          percent: systemReminderPercent,
                        },
                        tools: {
                          tokens: toolTokens,
                          percent: toolPercent,
                        },
                      },
                    },
                    operations: {
                      total: operations.length,
                      byTool: toolBreakdown,
                    },
                    tracking: {
                      method: 'tiktoken-based (accurate)',
                      note: 'System reminders tracked with tiktoken via Node.js helper, tool costs use fixed estimates',
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      case 'optimize_session': {
        const { sessionId, min_token_threshold = 30 } = args as {
          sessionId?: string;
          min_token_threshold?: number;
        };

        try {
          // --- 1. Identify Target Session ---
          const hooksDataPath = path.join(
            os.homedir(),
            '.claude-global',
            'hooks',
            'data'
          );
          let targetSessionId = sessionId;

          if (!targetSessionId) {
            const sessionFilePath = path.join(
              hooksDataPath,
              'current-session.txt'
            );
            if (!fs.existsSync(sessionFilePath)) {
              throw new Error('No active session found to optimize.');
            }
            // Strip BOM and parse JSON
            const sessionContent = fs
              .readFileSync(sessionFilePath, 'utf-8')
              .replace(/^\uFEFF/, '');
            const sessionData = JSON.parse(sessionContent);
            targetSessionId = sessionData.sessionId;
          }

          // --- 2. Read Operations CSV ---
          const csvFilePath = path.join(
            hooksDataPath,
            `operations-${targetSessionId}.csv`
          );
          if (!fs.existsSync(csvFilePath)) {
            throw new Error(
              `Operations file not found for session ${targetSessionId}`
            );
          }

          const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
          const lines = csvContent.trim().split('\n');

          // --- 3. Filter and Process Operations ---
          let originalTokens = 0;
          let compressedTokens = 0;
          let operationsCompressed = 0;
          const fileOpsToCompress = new Set<string>();

          // DEBUG: Track filtering logic
          const debugInfo = {
            totalLines: lines.length,
            emptyLines: 0,
            malformedLines: 0,
            noFilePath: 0,
            belowThreshold: 0,
            duplicatePaths: 0,
            candidatesFound: 0,
            fileNotExists: 0,
            successfullyCompressed: 0,
          };

          const fileToolNames = ['Read', 'Write', 'Edit'];

          for (const line of lines) {
            if (!line.trim()) {
              debugInfo.emptyLines++;
              continue;
            }

            const parts = line.split(',');
            if (parts.length < 4) {
              debugInfo.malformedLines++;
              continue;
            }

            const toolName = parts[1];
            const tokens = parseInt(parts[2], 10) || 0;
            let metadata = parts[3] || '';

            // FIX: Strip surrounding quotes from file path
            metadata = metadata.trim().replace(/^"(.*)"$/, '$1');

            // DEBUG: Track why operations are skipped
            if (!fileToolNames.includes(toolName)) {
              continue; // Not a file operation
            }

            if (!metadata) {
              debugInfo.noFilePath++;
              continue;
            }

            if (tokens <= min_token_threshold) {
              debugInfo.belowThreshold++;
              continue;
            }

            // Check if already in set (duplicate)
            if (fileOpsToCompress.has(metadata)) {
              debugInfo.duplicatePaths++;
              continue;
            }

            debugInfo.candidatesFound++;
            fileOpsToCompress.add(metadata);
          }

          // --- 4. Batch Compress and Cache ---
          for (const filePath of fileOpsToCompress) {
            if (!fs.existsSync(filePath)) {
              debugInfo.fileNotExists++;
              continue;
            }

            const fileContent = fs.readFileSync(filePath, 'utf-8');
            if (!fileContent) continue;

            const originalCount = tokenCounter.count(fileContent);
            originalTokens += originalCount.tokens;

            const compressionResult = compression.compressToBase64(fileContent);
            cache.set(
              filePath,
              compressionResult.compressed,
              compressionResult.compressedSize,
              compressionResult.originalSize
            );

            const compressedCount = tokenCounter.count(
              compressionResult.compressed
            );
            compressedTokens += compressedCount.tokens;
            operationsCompressed++;
            debugInfo.successfullyCompressed++;
          }

          // --- 5. Return Summary with Debug Info ---
          const tokensSaved = originalTokens - compressedTokens;
          const percentSaved =
            originalTokens > 0 ? (tokensSaved / originalTokens) * 100 : 0;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    sessionId: targetSessionId,
                    operationsAnalyzed: lines.length,
                    operationsCompressed,
                    tokens: {
                      before: originalTokens,
                      after: compressedTokens,
                      saved: tokensSaved,
                      percentSaved: percentSaved,
                    },
                    debug: debugInfo,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      case 'generate_session_report': {
        const {
          sessionId,
          format = 'html',
          outputPath,
        } = args as {
          sessionId?: string;
          format?: ReportFormat;
          outputPath?: string;
        };

        try {
          // Get session data
          const hooksDataPath = path.join(
            os.homedir(),
            '.claude-global',
            'hooks',
            'data'
          );
          let targetSessionId = sessionId;
          let sessionStartTime = '';

          if (!targetSessionId) {
            const sessionFilePath = path.join(
              hooksDataPath,
              'current-session.txt'
            );
            if (!fs.existsSync(sessionFilePath)) {
              throw new Error('No active session found');
            }
            const sessionContent = fs
              .readFileSync(sessionFilePath, 'utf-8')
              .replace(/^\uFEFF/, '');
            const sessionData = JSON.parse(sessionContent);
            targetSessionId = sessionData.sessionId;
            sessionStartTime = sessionData.startTime;
          }

          // Read operations CSV
          const csvFilePath = path.join(
            hooksDataPath,
            `operations-${targetSessionId}.csv`
          );
          if (!fs.existsSync(csvFilePath)) {
            throw new Error(
              `Operations file not found for session ${targetSessionId}`
            );
          }

          const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
          const lines = csvContent.trim().split('\n');

          const operations: TurnData[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(',');
            if (parts.length < 3) continue;

            operations.push({
              timestamp: parts[0],
              toolName: parts[1],
              tokens: parseInt(parts[2], 10) || 0,
              metadata: parts[3] || '',
            });
          }

          // Analyze the session
          const analysis = analyzeTokenUsage(operations);

          // Generate report
          const reportOptions: ReportOptions = {
            sessionId: targetSessionId!,
            sessionStartTime:
              sessionStartTime || operations[0]?.timestamp || 'Unknown',
            includeCharts: format === 'html',
            includeTimeline: format === 'html',
          };

          const report = generateReport(analysis, format, reportOptions);

          // Save to file if path provided
          if (outputPath) {
            fs.writeFileSync(outputPath, report, 'utf-8');
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      message: `Report generated successfully`,
                      outputPath,
                      format,
                      sessionId: targetSessionId,
                      summary: analysis.summary,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // Return report content
          return {
            content: [
              {
                type: 'text',
                text:
                  format === 'json'
                    ? report
                    : JSON.stringify(
                        {
                          success: true,
                          format,
                          sessionId: targetSessionId,
                          report,
                        },
                        null,
                        2
                      ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      case 'analyze_token_usage': {
        const {
          sessionId,
          groupBy = 'turn',
          topN = 10,
          anomalyThreshold = 3,
        } = args as {
          sessionId?: string;
          groupBy?: SessionAnalysisOptions['groupBy'];
          topN?: number;
          anomalyThreshold?: number;
        };

        try {
          // Get session data
          const hooksDataPath = path.join(
            os.homedir(),
            '.claude-global',
            'hooks',
            'data'
          );
          let targetSessionId = sessionId;

          if (!targetSessionId) {
            const sessionFilePath = path.join(
              hooksDataPath,
              'current-session.txt'
            );
            if (!fs.existsSync(sessionFilePath)) {
              throw new Error('No active session found');
            }
            const sessionContent = fs
              .readFileSync(sessionFilePath, 'utf-8')
              .replace(/^\uFEFF/, '');
            const sessionData = JSON.parse(sessionContent);
            targetSessionId = sessionData.sessionId;
          }

          // Read operations CSV
          const csvFilePath = path.join(
            hooksDataPath,
            `operations-${targetSessionId}.csv`
          );
          if (!fs.existsSync(csvFilePath)) {
            throw new Error(
              `Operations file not found for session ${targetSessionId}`
            );
          }

          const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
          const lines = csvContent.trim().split('\n');

          const operations: TurnData[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(',');
            if (parts.length < 3) continue;

            operations.push({
              timestamp: parts[0],
              toolName: parts[1],
              tokens: parseInt(parts[2], 10) || 0,
              metadata: parts[3] || '',
            });
          }

          // Analyze
          const analysis = analyzeTokenUsage(operations, {
            groupBy,
            topN,
            anomalyThreshold,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    sessionId: targetSessionId,
                    analysis,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      case 'smart_processes': {
        const options = args as any;
        const result = await smartProcesses.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_network': {
        const options = args as any;
        const result = await smartNetwork.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_logs': {
        const options = args as any;
        const result = await smartLogs.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_lint': {
        const options = args as any;
        const result = await smartLint.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_install': {
        const options = args as any;
        const result = await smartInstall.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_docker': {
        const options = args as any;
        const result = await smartDocker.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_build': {
        const options = args as any;
        const result = await smartBuild.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_system_metrics': {
        const options = args as any;
        const result = await smartSystemMetrics.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_test': {
        const options = args as any;
        const result = await smartTest.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_typecheck': {
        const options = args as any;
        const result = await smartTypeCheck.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_cron': {
        const options = args as any;
        const result = await smartCron.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_user': {
        const options = args as any;
        const result = await smartUser.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'predictive_cache': {
        const options = args as any;
        const result = await predictiveCacheTool.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_warmup': {
        const options = args as any;
        const result = await cacheWarmupTool.run(options);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_session_summary': {
        const { sessionId } = args as { sessionId?: string };

        try {
          const hooksDataPath = path.join(
            os.homedir(),
            '.claude-global',
            'hooks',
            'data'
          );
          let targetSessionId = sessionId;

          // Get session ID from current-session.txt if not provided
          if (!targetSessionId) {
            const sessionFilePath = path.join(
              hooksDataPath,
              'current-session.txt'
            );
            if (!fs.existsSync(sessionFilePath)) {
              throw new Error('No active session found');
            }
            const sessionContent = fs
              .readFileSync(sessionFilePath, 'utf-8')
              .replace(/^\uFEFF/, '');
            const sessionData = JSON.parse(sessionContent);
            targetSessionId = sessionData.sessionId;
          }

          // Read session-log.jsonl
          const jsonlFilePath = path.join(
            hooksDataPath,
            `session-log-${targetSessionId}.jsonl`
          );

          if (!fs.existsSync(jsonlFilePath)) {
            // Fallback: Use CSV format for backward compatibility
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: `JSONL log not found for session ${targetSessionId}. This session may not have JSONL logging enabled yet.`,
                    jsonlFilePath,
                    note: 'Use get_session_stats for CSV-based sessions',
                  }),
                },
              ],
            };
          }

          // Parse JSONL file
          const jsonlContent = fs.readFileSync(jsonlFilePath, 'utf-8');
          const lines = jsonlContent.trim().split('\n');

          // Initialize statistics
          let sessionStartTime = '';
          let sessionEndTime = '';
          let totalTurns = 0;
          let totalTools = 0;
          let totalHooks = 0;

          const tokensByCategory: Record<string, number> = {
            tools: 0,
            hooks: 0,
            responses: 0,
            system_reminders: 0,
          };

          // Enhanced structure for granular MCP server tracking
          interface ServerToolBreakdown {
            total: number;
            tools: Record<string, { count: number; tokens: number }>;
          }
          const tokensByServer: Record<string, ServerToolBreakdown> = {};
          const toolDurations: number[] = [];
          const toolBreakdown: Record<
            string,
            { count: number; tokens: number; totalDuration: number }
          > = {};
          const hookBreakdown: Record<
            string,
            { count: number; tokens: number }
          > = {};

          // DEBUG: Track parsing
          let mcpToolCallEvents = 0;
          let mcpToolResultEvents = 0;

          // Parse each JSONL event
          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const event = JSON.parse(line);

              // Extract session start/end times
              if (event.type === 'session_start') {
                sessionStartTime = event.timestamp;
              }

              if (event.type === 'session_end') {
                sessionEndTime = event.timestamp;
              }

              // Count turns (maximum turn number seen)
              if (event.turn && event.turn > totalTurns) {
                totalTurns = event.turn;
              }

              // Process tool calls (PreToolUse phase)
              if (event.type === 'tool_call') {
                totalTools++;
                const tokens = event.estimatedTokens || 0;
                tokensByCategory.tools += tokens;

                // Track by tool name
                if (!toolBreakdown[event.toolName]) {
                  toolBreakdown[event.toolName] = {
                    count: 0,
                    tokens: 0,
                    totalDuration: 0,
                  };
                }
                toolBreakdown[event.toolName].count++;
                toolBreakdown[event.toolName].tokens += tokens;

                // Track by MCP server with tool-level granularity
                if (event.toolName.startsWith('mcp__')) {
                  mcpToolCallEvents++;
                  const parts = event.toolName.split('__');
                  const serverName = parts[1] || 'unknown';
                  const toolName = parts.slice(2).join('__') || 'unknown';

                  console.error(
                    `[DEBUG tool_call] Found MCP tool: ${event.toolName} -> server=${serverName}, tool=${toolName}, tokens=${tokens}`
                  );

                  // Initialize server if not exists
                  if (!tokensByServer[serverName]) {
                    tokensByServer[serverName] = { total: 0, tools: {} };
                    console.error(
                      `[DEBUG tool_call] Initialized server: ${serverName}`
                    );
                  }

                  // Initialize tool within server if not exists
                  if (!tokensByServer[serverName].tools[toolName]) {
                    tokensByServer[serverName].tools[toolName] = {
                      count: 0,
                      tokens: 0,
                    };
                    console.error(
                      `[DEBUG tool_call] Initialized tool: ${serverName}.${toolName}`
                    );
                  }

                  // Aggregate tokens at both server and tool level
                  tokensByServer[serverName].total += tokens;
                  tokensByServer[serverName].tools[toolName].count++;
                  tokensByServer[serverName].tools[toolName].tokens += tokens;
                  console.error(
                    `[DEBUG tool_call] Updated: ${serverName}.${toolName} count=${tokensByServer[serverName].tools[toolName].count} tokens=${tokensByServer[serverName].tools[toolName].tokens}`
                  );
                }
              }

              // Process tool results (PostToolUse phase) - ALSO aggregate for MCP servers
              if (event.type === 'tool_result') {
                const tokens = event.actualTokens || 0;

                // Track duration if available
                if (event.duration_ms) {
                  toolDurations.push(event.duration_ms);

                  // Add duration to tool breakdown
                  if (toolBreakdown[event.toolName]) {
                    toolBreakdown[event.toolName].totalDuration +=
                      event.duration_ms;
                  }
                }

                // CRITICAL FIX: Also aggregate MCP server attribution from tool_result events
                // This fixes the empty tokensByServer issue
                if (event.toolName.startsWith('mcp__')) {
                  mcpToolResultEvents++;
                  const parts = event.toolName.split('__');
                  const serverName = parts[1] || 'unknown';
                  const toolName = parts.slice(2).join('__') || 'unknown';

                  console.error(
                    `[DEBUG tool_result] Found MCP tool: ${event.toolName} -> server=${serverName}, tool=${toolName}, tokens=${tokens}`
                  );

                  // Initialize server if not exists
                  if (!tokensByServer[serverName]) {
                    tokensByServer[serverName] = { total: 0, tools: {} };
                    console.error(
                      `[DEBUG tool_result] Initialized server: ${serverName}`
                    );
                  }

                  // Initialize tool within server if not exists
                  if (!tokensByServer[serverName].tools[toolName]) {
                    tokensByServer[serverName].tools[toolName] = {
                      count: 0,
                      tokens: 0,
                    };
                    console.error(
                      `[DEBUG tool_result] Initialized tool: ${serverName}.${toolName}`
                    );
                  }

                  // Aggregate tokens at both server and tool level
                  // For MCP tools, increment count here since they don't have tool_call events
                  tokensByServer[serverName].total += tokens;
                  tokensByServer[serverName].tools[toolName].count++;
                  tokensByServer[serverName].tools[toolName].tokens += tokens;
                  console.error(
                    `[DEBUG tool_result] Updated: ${serverName}.${toolName} count=${tokensByServer[serverName].tools[toolName].count} tokens=${tokensByServer[serverName].tools[toolName].tokens}`
                  );
                }
              }

              // Process hook executions
              if (event.type === 'hook_execution') {
                totalHooks++;
                const tokens = event.estimated_tokens || 0;
                tokensByCategory.hooks += tokens;

                // Track by hook name
                if (!hookBreakdown[event.hookName]) {
                  hookBreakdown[event.hookName] = { count: 0, tokens: 0 };
                }
                hookBreakdown[event.hookName].count++;
                hookBreakdown[event.hookName].tokens += tokens;
              }

              // Process system reminders
              if (event.type === 'system_reminder') {
                const tokens = event.tokens || 0;
                tokensByCategory.system_reminders += tokens;
              }
            } catch (parseError) {
              // Skip malformed JSONL lines
              continue;
            }
          }

          // Calculate total tokens
          const totalTokens = Object.values(tokensByCategory).reduce(
            (sum, val) => sum + val,
            0
          );

          // Calculate duration
          let duration = 'Unknown';
          if (sessionStartTime) {
            const endTime =
              sessionEndTime ||
              new Date().toISOString().replace('T', ' ').substring(0, 19);
            const start = new Date(sessionStartTime);
            const end = new Date(endTime);
            const diffMs = end.getTime() - start.getTime();
            const minutes = Math.floor(diffMs / 60000);
            const seconds = Math.floor((diffMs % 60000) / 1000);
            duration = `${minutes}m ${seconds}s`;
          }

          // Calculate average tool duration
          const avgToolDuration =
            toolDurations.length > 0
              ? Math.round(
                  toolDurations.reduce((sum, d) => sum + d, 0) /
                    toolDurations.length
                )
              : 0;

          // DEBUG: Log final state
          console.error(
            `[DEBUG FINAL] MCP tool_call events: ${mcpToolCallEvents}`
          );
          console.error(
            `[DEBUG FINAL] MCP tool_result events: ${mcpToolResultEvents}`
          );
          console.error(
            `[DEBUG FINAL] tokensByServer keys: ${Object.keys(tokensByServer).join(', ') || 'EMPTY'}`
          );
          console.error(
            `[DEBUG FINAL] tokensByServer content: ${JSON.stringify(tokensByServer, null, 2)}`
          );

          // Build response
          const summary = {
            success: true,
            sessionId: targetSessionId,
            totalTokens,
            totalTurns,
            totalTools,
            totalHooks,
            duration,
            debug: {
              mcpToolCallEvents,
              mcpToolResultEvents,
              tokensByServerKeys: Object.keys(tokensByServer),
            },
            tokensByCategory: {
              tools: {
                tokens: tokensByCategory.tools,
                percent:
                  totalTokens > 0
                    ? ((tokensByCategory.tools / totalTokens) * 100).toFixed(2)
                    : '0.00',
              },
              hooks: {
                tokens: tokensByCategory.hooks,
                percent:
                  totalTokens > 0
                    ? ((tokensByCategory.hooks / totalTokens) * 100).toFixed(2)
                    : '0.00',
              },
              responses: {
                tokens: tokensByCategory.responses,
                percent:
                  totalTokens > 0
                    ? (
                        (tokensByCategory.responses / totalTokens) *
                        100
                      ).toFixed(2)
                    : '0.00',
              },
              system_reminders: {
                tokens: tokensByCategory.system_reminders,
                percent:
                  totalTokens > 0
                    ? (
                        (tokensByCategory.system_reminders / totalTokens) *
                        100
                      ).toFixed(2)
                    : '0.00',
              },
            },
            tokensByServer,
            toolBreakdown,
            hookBreakdown,
            performance: {
              avgToolDuration_ms: avgToolDuration,
              totalToolCalls: totalTools,
              toolsWithDuration: toolDurations.length,
            },
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(summary, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGINT', () => {
    cache.close();
    tokenCounter.free();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cache.close();
    tokenCounter.free();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
