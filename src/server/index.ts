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
import { analyzeProjectTokens } from '../analysis/project-analyzer.js';
import { MetricsCollector } from '../core/metrics.js';
import {
  getPredictiveCacheTool,
  PREDICTIVE_CACHE_TOOL_DEFINITION,
} from '../tools/advanced-caching/predictive-cache.js';
import {
  getCacheWarmupTool,
  CACHE_WARMUP_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-warmup.js';
// Code analysis tools
import {
  getSmartAstGrepTool,
  SMART_AST_GREP_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-ast-grep.js';
import {
  SMART_COMPLEXITY_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-complexity.js';
import {
  SMART_DEPENDENCIES_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-dependencies.js';
import {
  SMART_EXPORTS_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-exports.js';
import {
  SMART_IMPORTS_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-imports.js';
import {
  SMART_REFACTOR_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-refactor.js';
import {
  SMART_SECURITY_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-security.js';
import {
  SMART_SYMBOLS_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-symbols.js';
import {
  SMART_TYPESCRIPT_TOOL_DEFINITION,
} from '../tools/code-analysis/smart-typescript.js';
// Configuration tools
import {
  SMART_CONFIG_READ_TOOL_DEFINITION,
} from '../tools/configuration/smart-config-read.js';
import {
  SMART_ENV_TOOL_DEFINITION,
} from '../tools/configuration/smart-env.js';
import {
  SMART_PACKAGE_JSON_TOOL_DEFINITION,
} from '../tools/configuration/smart-package-json.js';
import {
  SMART_TSCONFIG_TOOL_DEFINITION,
} from '../tools/configuration/smart-tsconfig.js';
// Output formatting tools
import {
  SMART_PRETTY_TOOL_DEFINITION,
} from '../tools/output-formatting/smart-pretty.js';
import {
  getCacheAnalyticsTool,
  CACHE_ANALYTICS_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-analytics.js';
import {
  runCacheBenchmark,
  CACHE_BENCHMARK_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-benchmark.js';
import {
  runCacheCompression,
  CACHE_COMPRESSION_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-compression.js';
import {
  getCacheInvalidationTool,
  CACHE_INVALIDATION_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-invalidation.js';
import {
  getCacheOptimizerTool,
  CACHE_OPTIMIZER_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-optimizer.js';
import {
  getCachePartitionTool,
  CACHE_PARTITION_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-partition.js';
import {
  getCacheReplicationTool,
  CACHE_REPLICATION_TOOL_DEFINITION,
} from '../tools/advanced-caching/cache-replication.js';
import {
  getSmartCacheTool,
  SMART_CACHE_TOOL_DEFINITION,
} from '../tools/advanced-caching/smart-cache.js';

// Monitoring Tools (3 tools)
import {
  getAlertManager,
  ALERT_MANAGER_TOOL_DEFINITION,
} from '../tools/dashboard-monitoring/alert-manager.js';
import {
  getMetricCollector,
  METRIC_COLLECTOR_TOOL_DEFINITION,
} from '../tools/dashboard-monitoring/metric-collector.js';
import {
  getMonitoringIntegration,
  MONITORING_INTEGRATION_TOOL_DEFINITION,
} from '../tools/dashboard-monitoring/monitoring-integration.js';

// API & Database tools
import {
  getSmartSql,
  SMART_SQL_TOOL_DEFINITION,
} from '../tools/api-database/smart-sql.js';
import {
  getSmartSchema,
  SMART_SCHEMA_TOOL_DEFINITION,
} from '../tools/api-database/smart-schema.js';
import {
  getSmartApiFetch,
  SMART_API_FETCH_TOOL_DEFINITION,
} from '../tools/api-database/smart-api-fetch.js';
import {
  getSmartCacheApi,
  SMART_CACHE_API_TOOL_DEFINITION,
} from '../tools/api-database/smart-cache-api.js';
import {
  getSmartDatabase,
  SMART_DATABASE_TOOL_DEFINITION,
} from '../tools/api-database/smart-database.js';
import {
  getSmartGraphQL,
  SMART_GRAPHQL_TOOL_DEFINITION,
} from '../tools/api-database/smart-graphql.js';
import {
  getSmartMigration,
  SMART_MIGRATION_TOOL_DEFINITION,
} from '../tools/api-database/smart-migration.js';
import {
  getSmartOrm,
  SMART_ORM_TOOL_DEFINITION,
} from '../tools/api-database/smart-orm.js';
import {
  getSmartRest,
  SMART_REST_TOOL_DEFINITION,
} from '../tools/api-database/smart-rest.js';
import {
  getSmartWebSocket,
  SMART_WEBSOCKET_TOOL_DEFINITION,
} from '../tools/api-database/smart-websocket.js';

// File operations tools
// Disabled for live server bring-up: file-operations tools depend on extensionless
// imports in compiled output which Node ESM rejects. We expose core tools only.
// TODO: Re-enable after fixing method signatures
// import {
//   getSmartDiffTool,
//   SMART_DIFF_TOOL_DEFINITION,
// } from '../tools/file-operations/smart-diff.js';
// import {
//   getSmartBranchTool,
//   SMART_BRANCH_TOOL_DEFINITION,
// } from '../tools/file-operations/smart-branch.js';
// import {
//   getSmartMergeTool,
//   SMART_MERGE_TOOL_DEFINITION,
// } from '../tools/file-operations/smart-merge.js';
// import {
//   getSmartStatusTool,
//   SMART_STATUS_TOOL_DEFINITION,
// } from '../tools/file-operations/smart-status.js';
// import {
//   getSmartLogTool,
//   SMART_LOG_TOOL_DEFINITION,
// } from '../tools/file-operations/smart-log.js';
import { parseSessionLog } from './session-log-parser.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Configuration constants
const COMPRESSION_CONFIG = {
  MIN_SIZE_THRESHOLD: 500, // bytes - minimum size before attempting compression
} as const;

// Initialize core modules
const cache = new CacheEngine();
const tokenCounter = new TokenCounter();
const compression = new CompressionEngine();
const metrics = new MetricsCollector();

/**
 * Helper function to cache uncompressed text
 * Used when compression is skipped (file too small or compression doesn't help)
 */
function cacheUncompressed(key: string, text: string, size: number): void {
  // Store uncompressed text with size=0 for compressedSize to indicate no compression
  cache.set(key, text, size, 0);
}

// Initialize advanced caching tools
const predictiveCache = getPredictiveCacheTool(cache, tokenCounter, metrics);
const cacheWarmup = getCacheWarmupTool(cache, tokenCounter, metrics);
// Code analysis tool instances
const smartAstGrep = getSmartAstGrepTool(cache, tokenCounter, metrics);

// Configuration tool instances

// Output formatting tool instances
const cacheAnalytics = getCacheAnalyticsTool(cache, tokenCounter, metrics);
const cacheInvalidation = getCacheInvalidationTool(
  cache,
  tokenCounter,
  metrics
);
const cacheOptimizer = getCacheOptimizerTool(cache, tokenCounter, metrics);
const cachePartition = getCachePartitionTool(cache, tokenCounter, metrics);
const cacheReplication = getCacheReplicationTool(cache, tokenCounter, metrics);
const smartCache = getSmartCacheTool(cache, tokenCounter, metrics);

// Initialize API & Database tools
const smartSql = getSmartSql(cache, tokenCounter, metrics);
const smartSchema = getSmartSchema(cache, tokenCounter, metrics);
const smartApiFetch = getSmartApiFetch(cache, tokenCounter, metrics);
const smartCacheApi = getSmartCacheApi(cache, tokenCounter, metrics);
const smartDatabase = getSmartDatabase(cache, tokenCounter, metrics);
const smartGraphQL = getSmartGraphQL(cache, tokenCounter, metrics);
const smartMigration = getSmartMigration(cache, tokenCounter, metrics);
const smartOrm = getSmartOrm(cache, tokenCounter, metrics);
const smartRest = getSmartRest(cache, tokenCounter, metrics);
const smartWebSocket = getSmartWebSocket(cache, tokenCounter, metrics);

// Initialize monitoring tools
const alertManager = getAlertManager(cache, tokenCounter, metrics);
const metricCollectorTool = getMetricCollector(cache, tokenCounter, metrics);
const monitoringIntegration = getMonitoringIntegration(cache, tokenCounter, metrics);

// File operations tools disabled in this live-test configuration.
// TODO: Fix method signatures for these tools before enabling
// const smartDiff = getSmartDiffTool(cache, tokenCounter, metrics);
// const smartBranch = getSmartBranchTool(cache, tokenCounter, metrics);
// const smartMerge = getSmartMergeTool(cache, tokenCounter, metrics);
// const smartStatus = getSmartStatusTool(cache, tokenCounter, metrics);
// const smartLog = getSmartLogTool(cache, tokenCounter, metrics);

// Create MCP server
const server = new Server(
  {
    name: 'token-optimizer-mcp',
    version: '0.2.0',
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
      // NOTE: 'lookup_cache' tool never existed in master branch - this is NOT a breaking change
      // This tool (analyze_project_tokens) is a new addition to the MCP server
      {
        name: 'analyze_project_tokens',
        description:
          'Analyze token usage and estimate costs across multiple sessions within a project. Aggregates data from all operations-*.csv files, provides project-level statistics, identifies top contributing sessions and tools, and estimates monetary costs based on token usage.',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: {
              type: 'string',
              description:
                'Path to the project directory. If not provided, uses the hooks data directory.',
            },
            startDate: {
              type: 'string',
              format: 'date',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Optional start date filter (YYYY-MM-DD format).',
            },
            endDate: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Optional end date filter (YYYY-MM-DD format).',
            },
            costPerMillionTokens: {
              type: 'number',
              description:
                'Cost per million tokens in USD. Defaults to 30 (GPT-4 Turbo pricing).',
              default: 30,
              minimum: 0,
              exclusiveMinimum: 0,
            },
          },
        },
      },
      PREDICTIVE_CACHE_TOOL_DEFINITION,
      CACHE_WARMUP_TOOL_DEFINITION,
      // Code analysis tools
      SMART_AST_GREP_TOOL_DEFINITION,
      SMART_COMPLEXITY_TOOL_DEFINITION,
      SMART_DEPENDENCIES_TOOL_DEFINITION,
      SMART_EXPORTS_TOOL_DEFINITION,
      SMART_IMPORTS_TOOL_DEFINITION,
      SMART_REFACTOR_TOOL_DEFINITION,
      SMART_SECURITY_TOOL_DEFINITION,
      SMART_SYMBOLS_TOOL_DEFINITION,
      SMART_TYPESCRIPT_TOOL_DEFINITION,
      // Configuration tools
      SMART_CONFIG_READ_TOOL_DEFINITION,
      SMART_ENV_TOOL_DEFINITION,
      SMART_PACKAGE_JSON_TOOL_DEFINITION,
      SMART_TSCONFIG_TOOL_DEFINITION,
      // Output formatting tools
      SMART_PRETTY_TOOL_DEFINITION,
      CACHE_ANALYTICS_TOOL_DEFINITION,
      CACHE_BENCHMARK_TOOL_DEFINITION,
      CACHE_COMPRESSION_TOOL_DEFINITION,
      CACHE_INVALIDATION_TOOL_DEFINITION,
      CACHE_OPTIMIZER_TOOL_DEFINITION,
      CACHE_PARTITION_TOOL_DEFINITION,
      CACHE_REPLICATION_TOOL_DEFINITION,
      SMART_CACHE_TOOL_DEFINITION,
      // API & Database tools
      SMART_SQL_TOOL_DEFINITION,
      SMART_SCHEMA_TOOL_DEFINITION,
      SMART_API_FETCH_TOOL_DEFINITION,
      SMART_CACHE_API_TOOL_DEFINITION,
      SMART_DATABASE_TOOL_DEFINITION,
      SMART_GRAPHQL_TOOL_DEFINITION,
      SMART_MIGRATION_TOOL_DEFINITION,
      SMART_ORM_TOOL_DEFINITION,
      SMART_REST_TOOL_DEFINITION,
      SMART_WEBSOCKET_TOOL_DEFINITION,
      // Monitoring tools
      ALERT_MANAGER_TOOL_DEFINITION,
      METRIC_COLLECTOR_TOOL_DEFINITION,
      MONITORING_INTEGRATION_TOOL_DEFINITION,
      // File operations tools
      // File operations tool definitions intentionally omitted in live-test config
      // TODO: Re-enable after fixing method signatures
      // SMART_DIFF_TOOL_DEFINITION,
      // SMART_BRANCH_TOOL_DEFINITION,
      // SMART_MERGE_TOOL_DEFINITION,
      // SMART_STATUS_TOOL_DEFINITION,
      // SMART_LOG_TOOL_DEFINITION,
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
        const originalSize = Buffer.byteLength(text, 'utf8');

        // Minimum size threshold: don't compress small files
        if (originalSize < COMPRESSION_CONFIG.MIN_SIZE_THRESHOLD) {
          // Cache uncompressed for small files
          cacheUncompressed(key, text, originalSize);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    key,
                    originalTokens: originalCount.tokens,
                    compressedTokens: originalCount.tokens,
                    tokensSaved: 0,
                    percentSaved: 0,
                    originalSize,
                    compressedSize: originalSize,
                    cached: true,
                    compressionSkipped: true,
                    reason: `File too small (${originalSize} bytes < ${COMPRESSION_CONFIG.MIN_SIZE_THRESHOLD} bytes threshold)`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Compress text
        const compressionResult = compression.compressToBase64(text, {
          quality,
        });

        // Count compressed tokens
        const compressedCount = tokenCounter.count(
          compressionResult.compressed
        );

        // Check if compression actually reduces tokens
        if (compressedCount.tokens >= originalCount.tokens) {
          // Compression doesn't help with tokens, cache uncompressed
          cacheUncompressed(key, text, originalSize);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    key,
                    originalTokens: originalCount.tokens,
                    compressedTokens: originalCount.tokens,
                    tokensSaved: 0,
                    percentSaved: 0,
                    originalSize,
                    compressedSize: originalSize,
                    cached: true,
                    compressionSkipped: true,
                    reason: `Compression would increase tokens (${originalCount.tokens} → ${compressedCount.tokens})`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Compression helps! Cache the compressed version
        cache.set(
          key,
          compressionResult.compressed,
          compressionResult.compressedSize,
          compressionResult.originalSize
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
                  compressionUsed: true,
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

        const cachedEntry = cache.getWithMetadata(key);
        if (!cachedEntry) {
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

        let text: string;
        // Check if the item was stored uncompressed (indicated by compressedSize === 0)
        if (cachedEntry.compressedSize === 0) {
          text = cachedEntry.content;
        } else {
          // Otherwise, it was compressed, so decompress it
          text = compression.decompressFromBase64(cachedEntry.content);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                key,
                text,
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

          // Read JSONL log
          const jsonlFilePath = path.join(
            hooksDataPath,
            `session-log-${targetSessionId}.jsonl`
          );

          // Error handling: Throw to let MCP wrap errors consistently
          if (!fs.existsSync(jsonlFilePath)) {
            throw new Error(
              `JSONL log not found for session ${targetSessionId}`
            );
          }

          // Parse JSONL using shared utility (now async with streaming)
          const { operations, toolTokens, systemReminderTokens } =
            await parseSessionLog(jsonlFilePath);

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

          // DEBUG: Track filtering and security logic
          const debugInfo = {
            totalLines: lines.length,
            securityRejected: 0,
          };

          const fileToolNames = ['Read', 'Write', 'Edit'];

          // SECURITY: Define secure base directory for file access
          // Resolve to absolute path to prevent bypasses
          const secureBaseDir = path.resolve(os.homedir());

          for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(',');
            if (parts.length < 4) continue;

            const toolName = parts[1];
            const tokens = parseInt(parts[2], 10) || 0;
            let metadata = parts[3] || '';

            // Strip surrounding quotes from file path
            metadata = metadata.trim().replace(/^"(.*)"$/, '$1');

            if (
              fileToolNames.includes(toolName) &&
              tokens > min_token_threshold &&
              metadata
            ) {
              // SECURITY FIX: Validate file path to prevent path traversal
              // Resolve the file path to absolute path
              const resolvedFilePath = path.resolve(metadata);

              // Check if the resolved path is within the secure base directory
              if (!resolvedFilePath.startsWith(secureBaseDir)) {
                // Log security event for rejected access attempt
                console.error(
                  `[SECURITY] Path traversal attempt detected and blocked: ${metadata}`
                );
                console.error(`[SECURITY] Resolved path: ${resolvedFilePath}`);
                console.error(
                  `[SECURITY] Secure base directory: ${secureBaseDir}`
                );
                debugInfo.securityRejected++;
                continue;
              }

              fileOpsToCompress.add(resolvedFilePath);
            }
          }

          // --- 4. Batch Compress and Cache ---
          for (const filePath of fileOpsToCompress) {
            // Additional security check before file access
            const resolvedPath = path.resolve(filePath);
            if (!resolvedPath.startsWith(secureBaseDir)) {
              console.error(
                `[SECURITY] Path traversal attempt in compression stage blocked: ${filePath}`
              );
              debugInfo.securityRejected++;
              continue;
            }

            if (!fs.existsSync(filePath)) continue;

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
                    security: {
                      pathsRejected: debugInfo.securityRejected,
                      secureBaseDir: secureBaseDir,
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

      case 'analyze_project_tokens': {
        const { projectPath, startDate, endDate, costPerMillionTokens } =
          args as {
            projectPath?: string;
            startDate?: string;
            endDate?: string;
            costPerMillionTokens?: number;
          };

        try {
          // Validate costPerMillionTokens input
          const validatedCost =
            costPerMillionTokens != null &&
            Number.isFinite(costPerMillionTokens) &&
            costPerMillionTokens >= 0
              ? costPerMillionTokens
              : undefined;

          // Use provided path or default to global hooks directory
          const targetPath = projectPath ?? os.homedir();

          const result = await analyzeProjectTokens({
            projectPath: targetPath,
            startDate,
            endDate,
            costPerMillionTokens: validatedCost,
          });

          // Generate token-optimized summary
          const summary = {
            success: true,
            projectPath: result.projectPath,
            analysisTimestamp: result.analysisTimestamp,
            dateRange: result.dateRange,
            summary: result.summary,
            topContributingSessions: result.topContributingSessions
              .slice(0, 5)
              .map((s) => ({
                sessionId: s.sessionId,
                totalTokens: s.totalTokens,
                duration: s.duration,
                topTool: s.topTools[0]?.toolName || 'N/A',
              })),
            topTools: result.topTools.slice(0, 10).map((t) => ({
              toolName: t.toolName,
              totalTokens: t.totalTokens,
              sessionCount: t.sessionCount,
            })),
            serverBreakdown: result.serverBreakdown,
            costEstimation: result.costEstimation,
            recommendations: result.recommendations,
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(summary),
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

      case 'predictive_cache': {
        const options = args as any;
        const result = await predictiveCache.run(options);

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
        const result = await cacheWarmup.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }


      // Code analysis tools  
      case 'smart_ast_grep': {
        const options = args as any;
        const result = await smartAstGrep.grep(options.pattern, options);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'smart_complexity':
      case 'smart_dependencies':
      case 'smart_exports':
      case 'smart_imports':
      case 'smart_refactor':
      case 'smart_security':
      case 'smart_symbols':
      case 'smart_typescript':
      case 'smart_config_read':
      case 'smart_env':
      case 'smart_package_json':
      case 'smart_tsconfig':
      case 'smart_pretty': {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Tool ${name} registered but handler not yet implemented`,
              tool: name,
            }),
          }],
          isError: true,
        };
      }

      case 'cache_analytics': {
        const options = args as any;
        const result = await cacheAnalytics.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_benchmark': {
        const options = args as any;
        const result = await runCacheBenchmark(
          options,
          cache,
          tokenCounter,
          metrics
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_compression': {
        const options = args as any;
        const result = await runCacheCompression(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_invalidation': {
        const options = args as any;
        const result = await cacheInvalidation.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_optimizer': {
        const options = args as any;
        const result = await cacheOptimizer.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_partition': {
        const options = args as any;
        const result = await cachePartition.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'cache_replication': {
        const options = args as any;
        const result = await cacheReplication.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_cache': {
        const options = args as any;
        const result = await smartCache.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_sql': {
        const options = args as any;
        const result = await smartSql.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_schema': {
        const options = args as any;
        const result = await smartSchema.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_api_fetch': {
        const options = args as any;
        const result = await smartApiFetch.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_cache_api': {
        const options = args as any;
        const result = await smartCacheApi.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_database': {
        const options = args as any;
        const result = await smartDatabase.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_graphql': {
        const options = args as any;
        const result = await smartGraphQL.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_migration': {
        const options = args as any;
        const result = await smartMigration.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_orm': {
        const options = args as any;
        const result = await smartOrm.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_rest': {
        const options = args as any;
        const result = await smartRest.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'smart_websocket': {
        const options = args as any;
        const result = await smartWebSocket.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }


      case 'alert_manager': {
        const options = args as any;
        const result = await alertManager.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'metric_collector': {
        const options = args as any;
        const result = await metricCollectorTool.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'monitoring_integration': {
        const options = args as any;
        const result = await monitoringIntegration.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // File operations tools disabled in live-test config

      // TODO: Fix these tool handlers - need to verify method signatures
      case 'smart_diff':
      case 'smart_branch':
      case 'smart_merge':
      case 'smart_status':
      case 'smart_log': {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  'Tool not yet fully integrated - method signature needs verification',
                tool: name,
              }),
            },
          ],
          isError: true,
        };
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

// Helper to run cleanup operations with error handling
function runCleanupOperations(operations: { fn: () => void; name: string }[]) {
  for (const op of operations) {
    try {
      op.fn();
    } catch (err) {
      console.error(`Error during cleanup (${op.name}):`, err);
    }
  }
}

// Shared cleanup function to avoid duplication between signal handlers
function cleanup() {
  runCleanupOperations([
    { fn: () => cache?.close(), name: 'closing cache' },
    { fn: () => tokenCounter?.free(), name: 'freeing tokenCounter' },
    // Note: predictiveCache and cacheWarmup do not implement dispose() methods
    // Removed dispose() calls to prevent runtime errors during cleanup
  ]);
}

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit - Note: the signal handlers use try-catch blocks
  // to ensure cleanup continues even if disposal fails
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
