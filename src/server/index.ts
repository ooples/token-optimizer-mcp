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
import fs from 'fs';
import path from 'path';
import os from 'os';

// Initialize core modules
const cache = new CacheEngine();
const tokenCounter = new TokenCounter();
const compression = new CompressionEngine();

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
              description: 'Optional session ID to query. If not provided, uses current session.',
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
              description: 'Optional session ID to optimize. If not provided, uses the current active session.',
            },
            min_token_threshold: {
              type: 'number',
              description: 'Minimum token count for a file operation to be considered for compression. Defaults to 30.',
            },
          },
        },
      },
      {
        name: 'lookup_cache',
        description:
          'Look up a cached value by key. Returns a JSON object with a "found" flag and the cached value if found; otherwise, "found" is false and "compressed" is omitted. Used by the wrapper for real-time cache injection.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Cache key to look up (e.g., file path for cached file contents)',
            },
          },
          required: ['key'],
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
        const compressionResult = compression.compressToBase64(text, { quality });

        // Cache the compressed text
        cache.set(
          key,
          compressionResult.compressed,
          compressionResult.compressedSize,
          compressionResult.originalSize
        );

        // Count compressed tokens
        const compressedCount = tokenCounter.count(compressionResult.compressed);

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
                      ((tokenResult.tokens - compressedTokens.tokens) / tokenResult.tokens) *
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
          const sessionFilePath = path.join(hooksDataPath, 'current-session.txt');

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
          const sessionContent = fs.readFileSync(sessionFilePath, 'utf-8').replace(/^\uFEFF/, '');
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
          const systemReminderPercent = totalTokens > 0
            ? (systemReminderTokens / totalTokens) * 100
            : 0;
          const toolPercent = totalTokens > 0
            ? (toolTokens / totalTokens) * 100
            : 0;

          // Group operations by tool
          const toolBreakdown: Record<string, { count: number; tokens: number }> = {};
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
          const hooksDataPath = path.join(os.homedir(), '.claude-global', 'hooks', 'data');
          let targetSessionId = sessionId;

          if (!targetSessionId) {
            const sessionFilePath = path.join(hooksDataPath, 'current-session.txt');
            if (!fs.existsSync(sessionFilePath)) {
              throw new Error('No active session found to optimize.');
            }
            // Strip BOM and parse JSON
            const sessionContent = fs.readFileSync(sessionFilePath, 'utf-8').replace(/^\uFEFF/, '');
            const sessionData = JSON.parse(sessionContent);
            targetSessionId = sessionData.sessionId;
          }

          // --- 2. Read Operations CSV ---
          const csvFilePath = path.join(hooksDataPath, `operations-${targetSessionId}.csv`);
          if (!fs.existsSync(csvFilePath)) {
            throw new Error(`Operations file not found for session ${targetSessionId}`);
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

            if (fileToolNames.includes(toolName) && tokens > min_token_threshold && metadata) {
              // SECURITY FIX: Validate file path to prevent path traversal
              // Resolve the file path to absolute path
              const resolvedFilePath = path.resolve(metadata);

              // Check if the resolved path is within the secure base directory
              if (!resolvedFilePath.startsWith(secureBaseDir)) {
                // Log security event for rejected access attempt
                console.error(`[SECURITY] Path traversal attempt detected and blocked: ${metadata}`);
                console.error(`[SECURITY] Resolved path: ${resolvedFilePath}`);
                console.error(`[SECURITY] Secure base directory: ${secureBaseDir}`);
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
              console.error(`[SECURITY] Path traversal attempt in compression stage blocked: ${filePath}`);
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

            const compressedCount = tokenCounter.count(compressionResult.compressed);
            compressedTokens += compressedCount.tokens;
            operationsCompressed++;
          }

          // --- 5. Return Summary with Debug Info ---
          const tokensSaved = originalTokens - compressedTokens;
          const percentSaved = originalTokens > 0 ? (tokensSaved / originalTokens) * 100 : 0;

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

      case 'lookup_cache': {
        /**
         * lookup_cache: Look up a cached value by key.
         *
         * Returns the cached value if found (in compressed format).
         * The returned 'cached' value is base64-encoded Brotli-compressed data
         * as stored by previous cache.set operations. Caller is responsible for
         * decompressing using CompressionEngine.decompressFromBase64() if needed.
         *
         * @param {string} key - Cache key to look up
         * @returns {Object} Response with success, found flags, and compressed data if found
         */
        const { key } = args as { key: string };

        try {
          const cached = cache.get(key);

          if (!cached) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    found: false,
                    key,
                  }),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  found: true,
                  key,
                  compressed: cached,
                }),
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
