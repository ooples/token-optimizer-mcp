#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startManagedInstallRepair } from './install-repair.js';
import { installShutdownHandlers } from './lifecycle.js';
import { discloseResult, expandRef } from './disclosure.js';
import { flagPayloadFailure } from './payload-failure.js';
import {
  createToolArgumentChecker,
  type ToolDefinitionLike,
} from './tool-arguments.js';
import { selectToolDefinitions } from './tool-profile.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { wasteAudit } from './waste-tool.js';
import { cacheAudit } from './cache-tool.js';
import { modelRouting } from './routing-tool.js';
import { tokenAudit } from './audit-tool.js';
import { installDoctor } from './doctor-tool.js';
import { fleetAudit } from './fleet-tool.js';
import { McpEvidenceRecorder } from './mcp-evidence.js';
import { wikiWrite } from '../tools/intelligence/wiki-write.js';
import { wikiRead } from '../tools/intelligence/wiki-read.js';
import {
  wikiQuery,
  type WikiQueryOptions,
} from '../tools/intelligence/wiki-query.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { noteToolCall, flushToolRollup } from '../telemetry/tool-rollup.js';
import { runUcrTool } from './ucr-tools.js';

import { CacheEngine } from '../core/cache-engine.js';
import { TokenCounter } from '../core/token-counter.js';
import { CompressionEngine } from '../core/compression-engine.js';
import { analyzeProjectTokens } from '../analysis/project-analyzer.js';
import { MetricsCollector } from '../core/metrics.js';
import { validateToolArgs } from '../validation/validator.js';
import { getPredictiveCacheTool } from '../tools/advanced-caching/predictive-cache.js';
import { getCacheWarmupTool } from '../tools/advanced-caching/cache-warmup.js';
// --- Previously unregistered tools ---------------------------------------
// Each of these shipped with a definition, a runner and tests, and no line
// anywhere that let a user reach it. Fifteen finished tools were invisible.
import { runSmartComplexity } from '../tools/code-analysis/lazy-tools.js';
import { runSmartDependencies } from '../tools/code-analysis/smart-dependencies.js';
import { runSmartExports } from '../tools/code-analysis/lazy-tools.js';
import { runSmartImports } from '../tools/code-analysis/lazy-tools.js';
import { runSmartRefactor } from '../tools/code-analysis/lazy-tools.js';
import { runSmartSecurity } from '../tools/code-analysis/smart-security.js';
import { runSmartSymbols } from '../tools/code-analysis/lazy-tools.js';
import { runSmartTypescript } from '../tools/code-analysis/lazy-tools.js';
import { runSmartConfigRead } from '../tools/configuration/smart-config-read.js';
import { runSmartEnv } from '../tools/configuration/smart-env.js';
import { runSmartPackageJson } from '../tools/configuration/smart-package-json.js';
import { runSmartTsconfig } from '../tools/configuration/smart-tsconfig.js';
import {
  getSmartWorkflowTool,
  type SmartWorkflowRequest,
} from '../tools/configuration/smart-workflow.js';
import { runSmartPretty } from '../tools/output-formatting/smart-pretty.js';
import { runSmartProcess } from '../tools/system-operations/smart-process.js';
import { runSmartService } from '../tools/system-operations/smart-service.js';

// Code analysis tools
import { getSmartAstGrepTool } from '../tools/code-analysis/smart-ast-grep.js';
import { getCacheAnalyticsTool } from '../tools/advanced-caching/cache-analytics.js';
import { runCacheBenchmark } from '../tools/advanced-caching/cache-benchmark.js';
import { runCacheCompression } from '../tools/advanced-caching/cache-compression.js';
import { getCacheInvalidationTool } from '../tools/advanced-caching/cache-invalidation.js';
import { getCacheOptimizerTool } from '../tools/advanced-caching/cache-optimizer.js';
import { getCachePartitionTool } from '../tools/advanced-caching/cache-partition.js';
import { getCacheReplicationTool } from '../tools/advanced-caching/cache-replication.js';
import { getSmartCacheTool } from '../tools/advanced-caching/smart-cache.js';
import { getAlertManager } from '../tools/dashboard-monitoring/alert-manager.js';
import { getMetricCollector } from '../tools/dashboard-monitoring/metric-collector.js';
import { getMonitoringIntegration } from '../tools/dashboard-monitoring/monitoring-integration.js';
import { getCustomWidget } from '../tools/dashboard-monitoring/custom-widget.js';
import { getDataVisualizer } from '../tools/dashboard-monitoring/data-visualizer.js';
import { getHealthMonitor } from '../tools/dashboard-monitoring/health-monitor.js';
import { getLogDashboard } from '../tools/dashboard-monitoring/log-dashboard.js';

// Intelligence tools
import { runIntelligentAssistant } from '../tools/intelligence/intelligent-assistant.js';
import { runNaturalLanguageQuery } from '../tools/intelligence/natural-language-query.js';
import { runPatternRecognition } from '../tools/intelligence/pattern-recognition.js';
import { runPredictiveAnalytics } from '../tools/intelligence/predictive-analytics.js';
import { runRecommendationEngine } from '../tools/intelligence/recommendation-engine.js';
import { runSmartSummarization } from '../tools/intelligence/smart-summarization.js';
import {
  runAnomalyExplainer,
  type AnomalyExplainerOptions,
} from '../tools/intelligence/anomaly-explainer.js';
import {
  getKnowledgeGraphTool,
  type KnowledgeGraphOptions,
} from '../tools/intelligence/knowledge-graph.js';
import {
  getSentimentAnalysisTool,
  type SentimentAnalysisOptions,
} from '../tools/intelligence/sentiment-analysis.js';

// Analytics tools
import { getHookAnalyticsTool } from '../tools/analytics/get-hook-analytics.js';
import { getActionAnalyticsTool } from '../tools/analytics/get-action-analytics.js';
import { getMcpServerAnalyticsTool } from '../tools/analytics/get-mcp-server-analytics.js';
import { getExportAnalyticsTool } from '../tools/analytics/export-analytics.js';
import { getOptimizationReportTool } from '../tools/analytics/get-optimization-report.js';
import { recordToolAnalytics } from '../analytics/record-tool-analytics.js';
import { OptimizationStorageTool } from '../tools/optimization-storage-tool.js';
import { ContextDeltaTool } from '../tools/context-delta-tool.js';
import { SessionManager } from '../core/session-manager.js';
import { createSummarizerFromEnv } from '../core/summarization.js';
import { TokenizerFactory } from '../core/tokenizers/tokenizer-factory.js';
import { ConfigManager } from '../core/config.js';
import { memoRegistry } from '../utils/lru-memoize.js';
import { AnalyticsManager } from '../analytics/analytics-manager.js';

// API & Database tools
import { getSmartSql } from '../tools/api-database/smart-sql.js';
import { getSmartSchema } from '../tools/api-database/smart-schema.js';
import { getSmartApiFetch } from '../tools/api-database/smart-api-fetch.js';
import { getSmartCacheApi } from '../tools/api-database/smart-cache-api.js';
import { getSmartDatabase } from '../tools/api-database/smart-database.js';
import { getSmartGraphQL } from '../tools/api-database/smart-graphql.js';
import { getSmartMigration } from '../tools/api-database/smart-migration.js';
import { getSmartOrm } from '../tools/api-database/smart-orm.js';
import { getSmartRest } from '../tools/api-database/smart-rest.js';
import { getSmartWebSocket } from '../tools/api-database/smart-websocket.js';

// Build Systems tools
import { getSmartProcessesTool } from '../tools/build-systems/smart-processes.js';
import { getSmartNetwork } from '../tools/build-systems/smart-network.js';
import { getSmartLogs } from '../tools/build-systems/smart-logs.js';
import { getSmartLintTool } from '../tools/build-systems/smart-lint.js';
import { getSmartInstall } from '../tools/build-systems/smart-install.js';
import { getSmartDocker } from '../tools/build-systems/smart-docker.js';
import { getSmartBuildTool } from '../tools/build-systems/smart-build.js';
import { getSmartSystemMetrics } from '../tools/build-systems/smart-system-metrics.js';
import { getSmartTestTool } from '../tools/build-systems/smart-test.js';
import { getSmartTypeCheckTool } from '../tools/build-systems/smart-typecheck.js';
// System Operations tools
import { getSmartCron } from '../tools/system-operations/smart-cron.js';
import { getSmartUser } from '../tools/system-operations/smart-user.js';

// File operations tools
import { getSmartDiffTool } from '../tools/file-operations/smart-diff.js';
import { getSmartBranchTool } from '../tools/file-operations/smart-branch.js';
import { getSmartMergeTool } from '../tools/file-operations/smart-merge.js';
import { getSmartStatusTool } from '../tools/file-operations/smart-status.js';
import { getSmartLogTool } from '../tools/file-operations/smart-log.js';
import { runSmartRead } from '../tools/file-operations/smart-read.js';
import { runSmartWrite } from '../tools/file-operations/smart-write.js';
import { runSmartEdit } from '../tools/file-operations/smart-edit.js';
import { runSmartGlob } from '../tools/file-operations/smart-glob.js';
import { runSmartGrep } from '../tools/file-operations/smart-grep.js';
import {
  parseSessionLog,
  resolveSessionLogPath,
} from './session-log-parser.js';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { isValidSessionId } from '../utils/session-id.js';
import path from 'path';
import os from 'os';

// Type imports for file-operations tools
import type { SmartDiffOptions } from '../tools/file-operations/smart-diff.js';
import type { SmartBranchOptions } from '../tools/file-operations/smart-branch.js';
import type { SmartMergeOptions } from '../tools/file-operations/smart-merge.js';
import type { SmartStatusOptions } from '../tools/file-operations/smart-status.js';
import type { SmartLogOptions } from '../tools/file-operations/smart-log.js';

// Configuration constants
const COMPRESSION_CONFIG = {
  MIN_SIZE_THRESHOLD: 500, // bytes - minimum size before attempting compression
} as const;

// Initialize core modules
const cache = new CacheEngine();
const tokenCounter = new TokenCounter();
const compression = new CompressionEngine();
const metrics = new MetricsCollector();

const analyticsManager = new AnalyticsManager();
const ANALYTICS_PROCESS_ID = randomUUID();

/*
 * The seven tools answered this way take no path argument -- they report on the
 * tool log, the cache or the install, not on a file -- so no displaced input is
 * passed here. A tool that gains one must pass its arguments through, which is
 * what the test asserting the path vocabulary against the published schemas is
 * there to catch.
 */
async function recordDirectToolResult<T>(
  toolName: string,
  operation: () => T | Promise<T>,
  operationId?: string | null
): Promise<T> {
  const result = await operation();
  await recordToolAnalytics(analyticsManager, toolName, result as any, {
    ...(await mcpEvidence.analyticsAttribution()),
    operationId,
  });
  return result;
}

/**
 * Helper function to cache uncompressed text
 * Used when compression is skipped (file too small or compression doesn't help)
 */
function cacheUncompressed(key: string, text: string, size: number): void {
  // Uncompressed, so the two sizes are the same size. A zero here would read
  // as infinite compression in every ratio computed from these columns.
  cache.set(key, text, size, size);
}

// Initialize advanced caching tools
const predictiveCache = getPredictiveCacheTool(cache, tokenCounter, metrics);
const cacheWarmup = getCacheWarmupTool(cache, tokenCounter, metrics);
// Code analysis tool instances
const smartAstGrep = getSmartAstGrepTool(cache, tokenCounter, metrics);
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
const monitoringIntegration = getMonitoringIntegration(
  cache,
  tokenCounter,
  metrics
);
const customWidget = getCustomWidget(cache, tokenCounter, metrics);
const dataVisualizer = getDataVisualizer(cache, tokenCounter, metrics);
const healthMonitor = getHealthMonitor(cache, tokenCounter, metrics);
const logDashboard = getLogDashboard(cache, tokenCounter, metrics);

// Initialize Intelligence tools that keep state between calls
const knowledgeGraph = getKnowledgeGraphTool(cache, tokenCounter, metrics);
const sentimentAnalysis = getSentimentAnalysisTool(
  cache,
  tokenCounter,
  metrics
);
const smartWorkflow = getSmartWorkflowTool(cache, tokenCounter, metrics);

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

const smartDiff = getSmartDiffTool(cache, tokenCounter, metrics);
const smartBranch = getSmartBranchTool(cache, tokenCounter, metrics);
const smartMerge = getSmartMergeTool(cache, tokenCounter, metrics);
const smartStatus = getSmartStatusTool(cache, tokenCounter, metrics);
const smartLog = getSmartLogTool(cache, tokenCounter, metrics);

// Initialize Analytics tools
const getHookAnalytics = getHookAnalyticsTool(analyticsManager);
const getActionAnalytics = getActionAnalyticsTool(analyticsManager);
const getMcpServerAnalytics = getMcpServerAnalyticsTool(analyticsManager);
const exportAnalytics = getExportAnalyticsTool(analyticsManager);
const getOptimizationReport = getOptimizationReportTool(analyticsManager);
const optimizationStorage = new OptimizationStorageTool();

// #120: load user config (creates ~/.token-optimizer/config.json with
// defaults on first run) and derive session-level knobs.
const configManager = new ConfigManager();
const optimizationConfig = configManager.getOptimizationConfig();
const sessionTokenizer = TokenizerFactory.createFromEnv();
const modelLimit =
  configManager.getModelTokenLimit(sessionTokenizer.modelName) ??
  // Fall back to an aggressive default for unknown models.
  128000;
const chatDefaultMaxTokens =
  optimizationConfig.chatCompression.tokenLimit ??
  Math.floor(modelLimit * optimizationConfig.compressionTokenThreshold);

const sessionManager = new SessionManager({
  persistencePath: path.join(os.homedir(), '.token-optimizer', 'sessions.json'),
  tokenizer: sessionTokenizer,
  defaultMaxTokens: chatDefaultMaxTokens,
  summarizer: createSummarizerFromEnv(),
});
const contextDelta = new ContextDeltaTool(sessionManager);

// A read depends on what this session has already seen, not just file bytes.
// Memoizing the final response replayed a cold read verbatim on every unchanged
// repeat, bypassing SmartRead's internal cache/diff logic. Let that layer own
// caching, as it already does for changes, chunk navigation, and authored bases.
const memoizedSmartRead = runSmartRead;

// smart_grep and smart_glob SCAN A TREE, and no single stat describes a tree:
// a file added three directories down changes the answer while every stat we
// could cheaply take stays identical. Both were verified serving pre-creation
// results after a new matching file appeared.
//
// So they are not memoized here. Each already caches internally against the
// content it read, which is the layer that can actually tell when it is stale;
// this one could only guess, and guessed wrong. Re-scanning costs a directory
// walk. Reporting that a file does not exist costs the user the afternoon.
const memoizedSmartGrep = runSmartGrep;
const memoizedSmartGlob = runSmartGlob;

// Periodic prune + stats log. Runs every 5 minutes; unref so it doesn't
// keep the process alive on its own.
const MEMO_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const memoPruneTimer = setInterval(() => {
  const removed = memoRegistry.pruneAll();
  if (removed > 0) {
    console.error(
      `[memo] pruned ${removed} expired cache entries; stats: ${JSON.stringify(memoRegistry.stats())}`
    );
  }
}, MEMO_PRUNE_INTERVAL_MS);
if (typeof memoPruneTimer.unref === 'function') {
  memoPruneTimer.unref();
}

// Create MCP server
const packageVersion = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version as string;

// This reaches every conforming MCP client at initialization, including hosts
// that expose no native lifecycle hook. It is deliberately capability-aware:
// the model must route through optimizer schemas that tools/list actually
// exposes, while a reduced/failed profile keeps bounded native tools usable.
const SERVER_INSTRUCTIONS =
  'Token optimization is mandatory routing policy, not a preference. When an ' +
  'exact optimizer schema is present in tools/list, use smart_read for large or ' +
  'repeated files, smart_grep for content search, smart_glob for file discovery, ' +
  'smart_edit for large edits, optimize_session when context is tight, and ' +
  'wiki_write for durable non-obvious conclusions. Never call or redirect to an ' +
  'unlisted schema; use a bounded native operation when the required optimizer ' +
  'tool is absent.';

const server = new Server(
  {
    name: 'token-optimizer-mcp',
    version: packageVersion,
  },
  {
    instructions:
      SERVER_INSTRUCTIONS +
      ' Discover only the schema for the tool you need. In code-mode hosts with ' +
      'ALL_TOOLS, filter by the exact tool-name suffix (for example __smart_read) ' +
      'and print that entry only. To discover names, list names without descriptions ' +
      'first. Broad catalog dumps can exhaust the context budget.',
    capabilities: {
      tools: {},
    },
  }
);
const mcpEvidence = new McpEvidenceRecorder(packageVersion);
server.oninitialized = () => {
  mcpEvidence.clientInitialized(server.getClientVersion());
};

// Define tools

const ADVERTISED_TOOL_DEFINITIONS = selectToolDefinitions(TOOL_DEFINITIONS);
const ADVERTISED_TOOL_NAMES = new Set(
  ADVERTISED_TOOL_DEFINITIONS.map((tool) => tool.name)
);

/**
 * Both argument checks, built from the definitions this server publishes -- so
 * neither can drift from what callers read out of `tools/list`.
 */
const { assertRequiredFields, assertKnownFields } = createToolArgumentChecker(
  ADVERTISED_TOOL_DEFINITIONS as ToolDefinitionLike[]
);

/**
 * Tools answered before the dispatch switch, so they need the argument check
 * applied where they are answered rather than where everything else is.
 */
const DIRECT_ANSWER_TOOLS: ReadonlySet<string> = new Set([
  'expand',
  'waste_audit',
  'cache_audit',
  'model_routing',
  'token_audit',
  'install_doctor',
  'fleet_audit',
]);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  mcpEvidence.toolsListed(ADVERTISED_TOOL_DEFINITIONS.length);
  return {
    tools: ADVERTISED_TOOL_DEFINITIONS,
  };
});

/**
 * A TOOL THAT ALREADY SPEAKS TEXT MUST NOT BE ENCODED TWICE.
 *
 * Twenty-six tools hand back a string rather than an object: twelve return
 * JSON they serialised themselves, fourteen return a human-readable report.
 * Every one of them was then passed to JSON.stringify here, which wrapped the
 * whole thing in quotes and escaped it -- so smart_env's payload arrived as
 * "{\n  \"success\": true,\n ...", a JSON document encoded as a JSON string.
 * A caller had to parse it twice, every newline cost two characters instead of
 * one, and every quote cost two. That is why the compact-wire change moved
 * those tools not at all: their inflation was a layer underneath it.
 *
 * A string is already the text of the result, so it is sent as-is. Anything
 * else is serialised once, compactly.
 */
function toResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result);
}

/**
 * Both argument checks plus zod validation, as ONE step.
 *
 * It is a function rather than a block inside handleToolCall because seven
 * tools never reach handleToolCall: expand, waste_audit, cache_audit,
 * model_routing, token_audit, install_doctor and fleet_audit are answered
 * earlier in this file, and so were the seven that had no schema entry at all.
 * Having the checks in one named place is what lets that path run them too.
 */
type ArgumentCheck =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { readonly ok: true; readonly args: any }
  | {
      readonly ok: false;
      readonly response: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
    };

function checkToolArguments(name: string, raw: unknown): ArgumentCheck {
  // A field the published schema calls required must actually be required.
  assertRequiredFields(name, raw);

  // ...and a field it does NOT publish must be refused rather than dropped,
  // which is what the passthrough schemas were doing to every typo.
  assertKnownFields(name, raw);

  try {
    return { ok: true, args: validateToolArgs(name, raw || {}) };
  } catch (validationError) {
    return {
      ok: false,
      response: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                validationError instanceof Error
                  ? validationError.message
                  : String(validationError),
            }),
          },
        ],
        isError: true,
      },
    };
  }
}

// Handle tool calls
async function handleToolCall(request: {
  params: { name: string; arguments?: unknown };
}) {
  const { name } = request.params;

  // The validated result REPLACES the raw args so every downstream tool case
  // operates on validated input — closing the prior gap where the handler
  // computed `validatedArgs` but then routed the unvalidated raw `args`.
  const checked = checkToolArguments(name, request.params.arguments);
  if (!checked.ok) return checked.response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let args: any = checked.args;

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
                text: JSON.stringify({
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
                }),
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
                text: JSON.stringify({
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
                }),
              },
            ],
          };
        }

        // Compression helps! Cache the compressed version.
        //
        // ARGUMENT ORDER: set(key, value, originalSize, compressedSize). These
        // two were transposed, so every cached entry recorded its sizes
        // backwards. Measured: writing 5,000 characters reported
        // `totalOriginalSize: 13, totalCompressedSize: 5000` -- and
        // compressionRatio, computed as compressed/original, came out at 384.6.
        // A compression ratio above 1 is expansion, so the statistic said the
        // cache was making data 384x LARGER while it was in fact compressing it
        // ~384x smaller.
        cache.set(
          key,
          compressionResult.compressed,
          compressionResult.originalSize,
          compressionResult.compressedSize
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
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
              }),
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

        // DO NOT INFER THE FORMAT FROM A SIZE.
        //
        // This decided "was it compressed?" from `compressedSize === 0`. But
        // the writers disagree about that field: smart_cache stores PLAIN text
        // and passes `value.length` as the compressed size, so the flag says
        // "compressed" for content that never was. get_cached then tried to
        // gunzip plain text and returned a bare "Decompression failed" for an
        // entry written moments earlier by a sibling tool.
        //
        // The content itself is the only reliable evidence. Decompressing is
        // attempted, and content that is not compressed is returned as it was
        // stored -- which is also what makes this robust to a THIRD writer with
        // its own convention.
        let text: string;
        try {
          text = compression.decompressFromBase64(cachedEntry.content);
        } catch {
          text = cachedEntry.content;
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
        const { text, modelName } = args as {
          text: string;
          modelName?: string;
        };
        const counter = modelName ? new TokenCounter(modelName) : tokenCounter;
        try {
          const result = modelName
            ? await counter.countAsync(text)
            : counter.count(text);
          // Return the full result JSON under a dedicated `metadata`
          // key while the primary `text` payload stays the scalar token
          // count string — preserves the integer-parse contract that
          // the PowerShell orchestrator relies on
          // (e.g. token-optimizer-orchestrator.ps1 L931/1910/2092 cast
          // `content[0].text -as [int]`) and still surfaces the richer
          // object for TS callers.
          return {
            content: [
              {
                type: 'text',
                text: String(result.tokens),
              },
              {
                type: 'text',
                text: JSON.stringify({
                  ...result,
                  model: modelName ?? counter.model,
                }),
              },
            ],
          };
        } finally {
          // Always free one-shot counters — even when countAsync throws,
          // leaving the tiktoken encoder allocated was leaking native
          // resources.
          if (modelName) {
            counter.free();
          }
        }
      }

      case 'compress_text': {
        const { text, quality } = args as { text: string; quality?: number };
        const result = compression.compressToBase64(text, { quality });

        // Brotli+base64 reduces BYTES (~50%) but base64 tokenizes poorly, so
        // the output usually has MORE LLM tokens than the input. Surface both
        // token counts and a warning so callers don't feed the result back
        // into a model context expecting savings — this tool is for at-rest
        // storage, not for shrinking context.
        const originalTokens = tokenCounter.count(text).tokens;
        const compressedTokens = tokenCounter.count(result.compressed).tokens;
        const increasesTokens = compressedTokens >= originalTokens;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...result,
                originalTokens,
                compressedTokens,
                increasesTokens,
                ...(increasesTokens
                  ? {
                      warning:
                        'Base64 output has MORE LLM tokens than the input. This tool reduces BYTES for at-rest storage/caching; do NOT inject the result into a model context expecting token savings (use optimize_text with a cache key for that).',
                    }
                  : {}),
              }),
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
              text: JSON.stringify({ text }),
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
              text: JSON.stringify(stats),
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

        // CLEAR EVERYTHING THAT SERVES A READ, not just the persistent store.
        //
        // `cache.clear()` empties the SQLite store. smart_cache keeps its own
        // L1/L2/L3 tiers in memory in front of it, and those survived -- so a
        // user who cleared the cache kept being served the very entries they
        // had just cleared. Measured: set a key, clear, read it back, and the
        // value was still there while the call reported "Cache cleared
        // successfully".
        //
        // smart_cache already had a correct clear that empties all three tiers
        // AND the store; it simply was not on this path.
        cache.clear();
        await smartCache.run({ operation: 'clear' });

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
              text: JSON.stringify({
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
              }),
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

          // AN EXPLICIT sessionId MUST NOT NEED AN ACTIVE SESSION.
          //
          // This read current-session.txt first and returned "No active session
          // found" when it was absent -- before ever looking at the sessionId
          // it had been handed. So the one documented parameter was unusable
          // exactly when it mattered: asking about a session that has ENDED.
          // The file is only needed to answer "which session do you mean", so
          // it is only consulted when the caller did not say.
          const sessionFilePath = path.join(
            hooksDataPath,
            'current-session.txt'
          );

          let targetSessionId = sessionId;
          if (!targetSessionId) {
            if (!fs.existsSync(sessionFilePath)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: false,
                      error:
                        'No active session found, and no sessionId was given.',
                      sessionFilePath,
                    }),
                  },
                ],
              };
            }

            // Strip BOM and parse JSON
            const sessionContent = fs
              .readFileSync(sessionFilePath, 'utf-8')
              .replace(/^﻿/, '');
            targetSessionId = JSON.parse(sessionContent).sessionId;
          }

          if (!targetSessionId || typeof targetSessionId !== 'string') {
            throw new Error(
              'No sessionId given and none recorded in current-session.txt.'
            );
          }

          // Read the session log, in whichever format it exists. This used to
          // build `session-log-<id>.jsonl` by hand and fail when it was absent
          // -- which was always, since the hooks write operations-<id>.csv.
          const logFilePath = resolveSessionLogPath(
            hooksDataPath,
            targetSessionId
          );

          // Error handling: Throw to let MCP wrap errors consistently
          if (!logFilePath) {
            throw new Error(
              `No session log found for session ${targetSessionId} in ${hooksDataPath}`
            );
          }

          // Parse using shared utility (now async with streaming)
          const { operations, toolTokens, systemReminderTokens } =
            await parseSessionLog(logFilePath);

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
                text: JSON.stringify({
                  success: true,
                  sessionId: targetSessionId,
                  sessionInfo: {
                    // Taken from the log itself rather than from
                    // current-session.txt, which only ever describes the
                    // session running right now and says nothing about a
                    // past one the caller asked about by id.
                    startTime: operations[0]?.timestamp ?? '',
                    lastActivity:
                      operations[operations.length - 1]?.timestamp ?? '',
                    totalOperations: operations.length,
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

            if (!targetSessionId || typeof targetSessionId !== 'string') {
              throw new Error('Invalid sessionId in current-session.txt');
            }
          }

          // --- 2. Read the session log (validated) ---
          // SECURITY: strict allowlist, kept in sync with SESSION_ID_RE in
          // web-server.ts — no dots or path separators, so `..` traversal
          // sequences are rejected before the path is built.
          // Same allowlist the dashboard uses -- one definition, not two
          // copies kept in step by comment. See utils/session-id.ts.
          if (!isValidSessionId(targetSessionId)) {
            throw new Error('Invalid sessionId format.');
          }
          // Resolves .jsonl or the operations-<id>.csv the hooks actually
          // write; the containment check below still runs on whatever it picks.
          const logFilePath = resolveSessionLogPath(
            hooksDataPath,
            targetSessionId
          );
          if (!logFilePath) {
            throw new Error(
              `No session log found for session ${targetSessionId} in ${hooksDataPath}`
            );
          }
          // SECURITY: Ensure file path is contained within hooksDataPath
          const baseReal = fs.realpathSync(hooksDataPath);
          const fileReal = fs.realpathSync(logFilePath);
          const rel0 = path.relative(baseReal, fileReal);
          if (rel0.startsWith('..') || path.isAbsolute(rel0)) {
            throw new Error(
              'Resolved session log path escapes hooks data directory.'
            );
          }

          // Parse using shared utility
          const { operations } = await parseSessionLog(logFilePath);

          // --- 3. Filter and Process Operations ---
          let originalTokens = 0;
          let compressedTokens = 0;
          let operationsCompressed = 0;
          const fileOpsToCompress = new Set<string>();

          // DEBUG: Track filtering and security logic
          const debugInfo = {
            totalOperations: operations.length,
            securityRejected: 0,
          };

          const fileToolNames = ['Read', 'Write', 'Edit'];

          // SECURITY: Define secure base directory for file access
          // Resolve to absolute path to prevent bypasses
          const secureBaseDir = path.resolve(os.homedir());

          for (const op of operations) {
            const toolName = op.toolName;
            const tokens = op.tokens;
            let metadata = op.metadata;

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

              // Check if the resolved path is within the secure base directory using path.relative
              const rel = path.relative(secureBaseDir, resolvedFilePath);
              if (rel.startsWith('..') || path.isAbsolute(rel)) {
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
            // Use realpath when file exists to defeat symlink escapes
            const baseReal = fs.realpathSync(secureBaseDir);
            if (!fs.existsSync(resolvedPath)) continue;
            const fileReal = fs.realpathSync(resolvedPath);
            const rel = path.relative(baseReal, fileReal);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
              console.error(
                `[SECURITY] Path traversal attempt in compression stage blocked: ${filePath}`
              );
              debugInfo.securityRejected++;
              continue;
            }

            const fileContent = fs.readFileSync(filePath, 'utf-8');
            if (!fileContent) continue;

            const originalCount = tokenCounter.count(fileContent);
            originalTokens += originalCount.tokens;

            const compressionResult = compression.compressToBase64(fileContent);
            const compressedCount = tokenCounter.count(
              compressionResult.compressed
            );

            // Only cache if compression actually reduces tokens
            if (compressedCount.tokens < originalCount.tokens) {
              // set(key, value, originalSize, compressedSize) -- see the
              // matching fix above; these were transposed here too.
              cache.set(
                filePath,
                compressionResult.compressed,
                compressionResult.originalSize,
                compressionResult.compressedSize
              );
              compressedTokens += compressedCount.tokens;
              operationsCompressed++;
            } else {
              // Compression increased tokens, skip caching
              compressedTokens += originalCount.tokens;
            }
          }

          // --- 5. Return Summary with Debug Info ---
          const tokensSaved = originalTokens - compressedTokens;
          const percentSaved =
            originalTokens > 0 ? (tokensSaved / originalTokens) * 100 : 0;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  sessionId: targetSessionId,
                  operationsAnalyzed: operations.length,
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
              text: toResultText(result),
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
              text: toResultText(result),
            },
          ],
        };
      }

      // Code analysis tools
      case 'smart_complexity': {
        const result = await runSmartComplexity(
          args as any,
          cache,
          tokenCounter,
          metrics
        );
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_dependencies': {
        const result = await runSmartDependencies(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_exports': {
        const result = await runSmartExports(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_imports': {
        const result = await runSmartImports(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_refactor': {
        const result = await runSmartRefactor(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_security': {
        const result = await runSmartSecurity(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_symbols': {
        const result = await runSmartSymbols(
          args as any,
          cache,
          tokenCounter,
          metrics
        );
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_typescript': {
        const result = await runSmartTypescript(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_config_read': {
        // The ADVERTISED parameter is `path`, and the runner takes the file
        // first and options second. Destructuring `filePath` here -- a name the
        // published schema never mentions -- meant a caller passing exactly
        // what the schema documents got "Config file not found: undefined".
        const { path: configPath, ...configOptions } = args as any;
        const result = await runSmartConfigRead(configPath, configOptions);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_env': {
        const result = await runSmartEnv(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_package_json': {
        const result = await runSmartPackageJson(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_tsconfig': {
        const result = await runSmartTsconfig(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_pretty': {
        const result = await runSmartPretty(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_process': {
        const result = await runSmartProcess(
          args as any,
          cache,
          tokenCounter,
          metrics
        );
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_service': {
        const result = await runSmartService(
          args as any,
          cache,
          tokenCounter,
          metrics
        );
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_ast_grep': {
        const options = args as any;
        const result = await smartAstGrep.grep(options.pattern, options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'cache_analytics': {
        const options = args as any;
        const result = await cacheAnalytics.run(options);

        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_processes': {
        const options = args as any;
        const result = await smartProcesses.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_diff': {
        const options = args as SmartDiffOptions;
        const result = await smartDiff.diff(options);

        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_branch': {
        const options = args as SmartBranchOptions;
        const result = await smartBranch.branch(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_merge': {
        const options = args as SmartMergeOptions;
        const result = await smartMerge.merge(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_status': {
        const options = args as SmartStatusOptions;
        const result = await smartStatus.status(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_log': {
        const options = args as SmartLogOptions;
        const result = await smartLog.log(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_read': {
        const { path, ...options } = args as any;
        const result = await memoizedSmartRead(path, options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_write': {
        const { path, content, ...options } = args as any;
        const result = await runSmartWrite(path, content, options);
        // Filesystem was mutated — drop every memoized read-only cache
        // entry so the next smart_read/grep/glob reflects the new state
        // instead of waiting for TTL expiry.
        memoRegistry.clearAll();
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_edit': {
        const { path, operations, ...options } = args as any;
        const result = await runSmartEdit(path, operations, options);
        memoRegistry.clearAll();
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_glob': {
        const { pattern, ...options } = args as any;
        const result = await memoizedSmartGlob(pattern, options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'wiki_write': {
        // Deliberate agent write into the knowledge graph. Routed like any
        // other tool so it carries a schema and a dispatch case, which the
        // reachability suite requires of everything advertised.
        const result = await wikiWrite(args as any);
        return {
          content: [{ type: 'text', text: toResultText(result) }],
        };
      }
      case 'wiki_read': {
        // The read counterpart to wiki_write. Until this existed the graph had a
        // deliberate write path and no deliberate read path, so a subagent -- which
        // never receives the SessionStart briefing -- could not reach it at all.
        const result = await wikiRead(args as any);
        return {
          content: [{ type: 'text', text: toResultText(result) }],
        };
      }
      case 'wiki_query': {
        // The general read path: one finding by key, a ranked search over claims,
        // a node with its neighbours, or the graph's own audit.
        // NOT by anchor -- that operation was removed deliberately and a
        // test asserts it now answers "unknown operation"; `wiki_read` is the
        // path that takes files. The SessionStart index has been telling the model
        // to call this for detail since injection landed, so a missing dispatch
        // case here is the difference between an escape hatch and a dead end.
        const result = await wikiQuery(args as WikiQueryOptions);
        return {
          content: [{ type: 'text', text: toResultText(result) }],
        };
      }
      case 'context_page':
      case 'context_receipt_verify':
      case 'cognition_record':
      case 'checkpoint_handoff':
      case 'outcome_report': {
        const result = await runUcrTool(name, args);
        return {
          content: [{ type: 'text', text: toResultText(result) }],
        };
      }
      case 'smart_grep': {
        const { pattern, ...options } = args as any;
        const result = await memoizedSmartGrep(pattern, options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'optimization_storage': {
        const result = optimizationStorage.run(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'context_delta': {
        const result = contextDelta.run(args as any);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
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
              text: toResultText(result),
            },
          ],
        };
      }

      case 'custom_widget': {
        const options = args as any;
        const result = await customWidget.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'data_visualizer': {
        const options = args as any;
        const result = await dataVisualizer.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'health_monitor': {
        const options = args as any;
        const result = await healthMonitor.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'log_dashboard': {
        const options = args as any;
        const result = await logDashboard.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'intelligent-assistant': {
        const options = args as any;
        const result = await runIntelligentAssistant(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'natural-language-query': {
        const options = args as any;
        const result = await runNaturalLanguageQuery(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'pattern-recognition': {
        const options = args as any;
        const result = await runPatternRecognition(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'predictive-analytics': {
        const options = args as any;
        const result = await runPredictiveAnalytics(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'recommendation-engine': {
        const options = args as any;
        const result = await runRecommendationEngine(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart-summarization': {
        const options = args as any;
        const result = await runSmartSummarization(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }
      case 'anomaly_explainer': {
        const options = args as unknown as AnomalyExplainerOptions;
        const result = await runAnomalyExplainer(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'knowledge_graph': {
        const options = args as unknown as KnowledgeGraphOptions;
        const result = await knowledgeGraph.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'sentiment_analysis': {
        const options = args as unknown as SentimentAnalysisOptions;
        const result = await sentimentAnalysis.run(options);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'smart_workflow': {
        const request = args as unknown as SmartWorkflowRequest;
        const result = await smartWorkflow.run(request);
        return {
          content: [
            {
              type: 'text',
              text: toResultText(result),
            },
          ],
        };
      }

      case 'get_hook_analytics': {
        const result = await getHookAnalytics(args as any);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'get_action_analytics': {
        const result = await getActionAnalytics(args as any);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'get_mcp_server_analytics': {
        const result = await getMcpServerAnalytics(args as any);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'export_analytics': {
        const result = await exportAnalytics(args as any);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'get_optimization_report': {
        const result = await getOptimizationReport(args as any);
        return {
          content: [{ type: 'text', text: result }],
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
}

async function observeMcpToolCall<T>(
  toolName: string,
  operation: () => T | Promise<T>
): Promise<T> {
  const started = Date.now();

  try {
    const result = await operation();
    const ok = !(result as { isError?: boolean } | null)?.isError;
    mcpEvidence.toolOutcome(toolName, Date.now() - started, ok);
    countToolCall(toolName, Date.now() - started, ok);
    return result;
  } catch (error) {
    mcpEvidence.toolOutcome(toolName, Date.now() - started, false);
    countToolCall(toolName, Date.now() - started, false);
    throw error;
  }
}

/**
 * Feed one tool call to the opt-in rollup.
 *
 * THE ONE PLACE THE MCP SURFACE IS COUNTED, and it is here rather than in the
 * request handler because a tool that throws is exactly the tool worth knowing
 * about, and the handler's own body is what threw. Whether the name was
 * advertised is passed through rather than re-derived inside the telemetry
 * module: the catalog is this file's fact, and an unadvertised name -- which a
 * client is free to send -- must never mint a property key.
 *
 * Instrumentation may not break a tool call. `record` already swallows its own
 * write failures, so this catch is for the unforeseen rest of the path.
 */
function countToolCall(toolName: string, elapsedMs: number, ok: boolean): void {
  try {
    noteToolCall(toolName, elapsedMs, ok, ADVERTISED_TOOL_NAMES.has(toolName));
  } catch {
    /* Optional telemetry cannot fail a tool call. */
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
  observeMcpToolCall(request.params.name, async () => {
    const operationId = `mcp:${ANALYTICS_PROCESS_ID}:${String(extra.sessionId || 'stdio')}:${String(extra.requestId)}`;
    if (!ADVERTISED_TOOL_NAMES.has(request.params.name)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Tool ${request.params.name} is not available in the active MCP tool profile. ` +
                'Set TOKEN_OPTIMIZER_TOOL_PROFILE=full before starting the server to expose the full catalog.',
            }),
          },
        ],
        isError: true,
      };
    }

    /*
     * The seven tools answered below never reach handleToolCall, which is where
     * arguments were checked -- so for years they took `request.params
     * .arguments as any` unvalidated, and none of them had a schema entry
     * either. Both halves are fixed: every advertised tool now has a derived
     * schema, and this path runs the same check the switch does.
     */
    let directArgs: unknown = request.params.arguments;
    if (DIRECT_ANSWER_TOOLS.has(request.params.name)) {
      const checked = checkToolArguments(
        request.params.name,
        request.params.arguments
      );
      if (!checked.ok) return checked.response;
      directArgs = checked.args;
    }

    // Following a pointer is handled here rather than in the tool switch, because
    // it is not an operation on the codebase -- it is an operation on what we
    // already said about it.
    if (request.params.name === 'expand') {
      return recordDirectToolResult(
        request.params.name,
        () => expandRef(directArgs as any),
        operationId
      );
    }

    // Likewise the audit: it reports on the tool log rather than operating on the
    // codebase, and its own output must not be disclosed away.
    if (request.params.name === 'waste_audit') {
      return recordDirectToolResult(
        request.params.name,
        () => wasteAudit(directArgs as any),
        operationId
      );
    }

    if (request.params.name === 'cache_audit') {
      return recordDirectToolResult(
        request.params.name,
        () => cacheAudit(),
        operationId
      );
    }

    if (request.params.name === 'model_routing') {
      return recordDirectToolResult(
        request.params.name,
        () => modelRouting(directArgs as any),
        operationId
      );
    }

    if (request.params.name === 'token_audit') {
      return recordDirectToolResult(
        request.params.name,
        () => tokenAudit(directArgs as any),
        operationId
      );
    }

    if (request.params.name === 'install_doctor') {
      return recordDirectToolResult(
        request.params.name,
        () =>
          installDoctor({
            ...(directArgs as any),
            clientName: server.getClientVersion()?.name,
            // A runtime fact no file inspection can reach: this process may be
            // running on an in-memory cache because the real one would not open.
            // Nothing persists in that state and nothing outside says so.
            cacheDegradedReason: cache.getDegradedReason(),
          }),
        operationId
      );
    }

    if (request.params.name === 'fleet_audit') {
      return recordDirectToolResult(
        request.params.name,
        () => fleetAudit(directArgs as any),
        operationId
      );
    }

    const started = Date.now();
    const result = flagPayloadFailure(await handleToolCall(request));
    const disclosed = (await discloseResult(
      request.params.name,
      request.params.arguments as Record<string, unknown> | undefined,
      result as any,
      Date.now() - started
    )) as any;
    // Best-effort: feed savings into analytics so the report/breakdown tools have
    // real data. The returned-context side is measured AFTER disclosure because
    // that is what actually enters the client's context window.
    await recordToolAnalytics(
      analyticsManager,
      request.params.name,
      disclosed,
      { ...(await mcpEvidence.analyticsAttribution()), operationId },
      result,
      // The arguments as the caller sent them, so the recorder can count the
      // input this call stood in for instead of taking the tool's word for it.
      request.params.arguments
    );
    // THE ONE PLACE EVERY TOOL RESULT PASSES THROUGH. Disclosing here rather than
    // per-tool is what keeps it a single policy instead of ninety. The elapsed
    // time is passed along because it is what later decides whether a stale
    // artifact is worth regenerating or worth serving with a marker.
    return disclosed;
  })
);

// Helper to run cleanup operations with error handling
async function runCleanupOperations(
  operations: { fn: () => void | Promise<void>; name: string }[]
) {
  for (const op of operations) {
    try {
      await op.fn();
    } catch (err) {
      console.error(`Error during cleanup (${op.name}):`, err);
    }
  }
}

let stopRoutingMaintenance: (() => void) | undefined;
let shuttingDown = false;

// Shared cleanup function to avoid duplication between signal handlers
async function cleanup() {
  shuttingDown = true;
  stopRoutingMaintenance?.();
  mcpEvidence.shutdown();
  await runCleanupOperations([
    // Before anything else closes: a window's worth of counts is lost on a kill,
    // and a clean exit is the one chance to narrow that to zero.
    { fn: () => void flushToolRollup(), name: 'flushing tool rollup' },
    {
      fn: async () => await analyticsManager.close(),
      name: 'flushing analytics',
    },
    { fn: () => cache?.close(), name: 'closing cache' },
    { fn: () => tokenCounter?.free(), name: 'freeing tokenCounter' },
    { fn: async () => await sessionManager.flush(), name: 'flushing sessions' },
    { fn: () => TokenizerFactory.disposeAll(), name: 'disposing tokenizers' },
    {
      fn: () => optimizationStorage.close(),
      name: 'closing optimization storage',
    },
    {
      fn: () => {
        clearInterval(memoPruneTimer);
        memoRegistry.clearAll();
      },
      name: 'clearing memo caches',
    },
    // Note: predictiveCache and cacheWarmup do not implement dispose() methods
    // Removed dispose() calls to prevent runtime errors during cleanup
  ]);
}

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpEvidence.transportConnected();

  // Recovery must continue after startup: an already-connected Claude session still uses
  // its saved endpoint when the detached supervisor dies.
  // Keep the proxy dependency tree off the cold MCP handshake path.
  void import('../proxy/routing-maintenance.js')
    .then(({ startRoutingMaintenance }) => {
      if (!shuttingDown) stopRoutingMaintenance = startRoutingMaintenance();
    })
    .catch(() => {
      /* Optional recovery cannot fail MCP startup. */
    });
  startManagedInstallRepair();

  // Both of these refuse on their own when the policy or the opt-in says no, and
  // the imports are dynamic to keep them off the cold handshake path.
  void (async () => {
    // THE HOOKS CANNOT REPORT FOR THEMSELVES, so their ledger is read here. A
    // hook is a process per tool call, so it holds no window, and it imports
    // nothing from dist/ -- so it cannot reach the consent policy either. This
    // reduces its log to counts and records one event. It runs BEFORE the flush
    // below so the snapshot leaves on this boot instead of waiting for the next.
    try {
      const { flushHookSnapshot } = await import('../telemetry/hook-rollup.js');
      await flushHookSnapshot();
    } catch {
      /* Optional telemetry cannot fail MCP startup. */
    }
    // WHAT WAS RECORDED EARLIER GOES NOW, NOT AT EXIT. A flush on shutdown has a
    // bounded window and then exits unconditionally, so the request it starts is
    // usually cut off mid-flight -- which is indistinguishable, from here, from a
    // receiver that is down. Sending at boot gives the request the whole session;
    // the cost is that the last session's events arrive one session late.
    try {
      const { flushBeacon } = await import('../telemetry/beacon.js');
      await flushBeacon();
    } catch {
      /* Optional telemetry cannot fail MCP startup. */
    }
  })();

  // All termination paths (SIGINT/SIGTERM/SIGHUP + stdin end/close/error) run
  // through one guarded shutdown. See ./lifecycle.ts for the full rationale
  // (the stdin handlers are the Windows orphan-leak fix from PR #177).
  installShutdownHandlers({ cleanup });
}

main().catch((error) => {
  mcpEvidence.startupFailed(error);
  console.error('Server error:', error);
  process.exit(1);
});
