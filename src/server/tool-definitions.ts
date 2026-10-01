/**
 * Every tool this server advertises, as one exported list.
 *
 * It lives outside the server module so that validation can be DERIVED from
 * it rather than hand-maintained beside it. The two had drifted: 43 tools
 * validated against a `z.record(z.string(), z.any())` placeholder that checks
 * nothing, and of the rest, 18 had Zod schemas missing keys their own
 * advertised schema publishes -- so a documented option would have been
 * refused the moment validation was tightened. Importing the server to read
 * the list is not an option, because the server starts transports on import.
 */

import { EXPAND_TOOL } from './disclosure.js';
import { WASTE_TOOL } from './waste-tool.js';
import { CACHE_TOOL } from './cache-tool.js';
import { ROUTING_TOOL } from './routing-tool.js';
import { AUDIT_TOOL } from './audit-tool.js';
import { DOCTOR_TOOL } from './doctor-tool.js';
import { FLEET_TOOL } from './fleet-tool.js';
import { WIKI_WRITE_TOOL_DEFINITION } from '../tools/intelligence/wiki-write.js';
import { WIKI_READ_TOOL_DEFINITION } from '../tools/intelligence/wiki-read.js';
import { WIKI_QUERY_TOOL_DEFINITION } from '../tools/intelligence/wiki-query.js';
import { UCR_TOOL_DEFINITIONS } from './ucr-tools.js';
import { PREDICTIVE_CACHE_TOOL_DEFINITION } from '../tools/advanced-caching/predictive-cache.js';
import { CACHE_WARMUP_TOOL_DEFINITION } from '../tools/advanced-caching/cache-warmup.js';
import { SMART_COMPLEXITY_TOOL_DEFINITION } from '../tools/code-analysis/lazy-tools.js';
import { SMART_DEPENDENCIES_TOOL_DEFINITION } from '../tools/code-analysis/smart-dependencies.js';
import { SMART_EXPORTS_TOOL_DEFINITION } from '../tools/code-analysis/lazy-tools.js';
import { SMART_IMPORTS_TOOL_DEFINITION } from '../tools/code-analysis/lazy-tools.js';
import { SMART_REFACTOR_TOOL_DEFINITION } from '../tools/code-analysis/lazy-tools.js';
import { SMART_SECURITY_TOOL_DEFINITION } from '../tools/code-analysis/smart-security.js';
import { SMART_SYMBOLS_TOOL_DEFINITION } from '../tools/code-analysis/lazy-tools.js';
import { SMART_TYPESCRIPT_TOOL_DEFINITION } from '../tools/code-analysis/lazy-tools.js';
import { SMART_CONFIG_READ_TOOL_DEFINITION } from '../tools/configuration/smart-config-read.js';
import { SMART_ENV_TOOL_DEFINITION } from '../tools/configuration/smart-env.js';
import { SMART_PACKAGE_JSON_TOOL_DEFINITION } from '../tools/configuration/smart-package-json.js';
import { SMART_TSCONFIG_TOOL_DEFINITION } from '../tools/configuration/smart-tsconfig.js';
import { SMART_WORKFLOW_TOOL_DEFINITION } from '../tools/configuration/smart-workflow.js';
import { SMART_PRETTY_TOOL_DEFINITION } from '../tools/output-formatting/smart-pretty.js';
import { SMART_PROCESS_TOOL_DEFINITION } from '../tools/system-operations/smart-process.js';
import { SMART_SERVICE_TOOL_DEFINITION } from '../tools/system-operations/smart-service.js';
import { SMART_AST_GREP_TOOL_DEFINITION } from '../tools/code-analysis/smart-ast-grep.js';
import { CACHE_ANALYTICS_TOOL_DEFINITION } from '../tools/advanced-caching/cache-analytics.js';
import { CACHE_BENCHMARK_TOOL_DEFINITION } from '../tools/advanced-caching/cache-benchmark.js';
import { CACHE_COMPRESSION_TOOL_DEFINITION } from '../tools/advanced-caching/cache-compression.js';
import { CACHE_INVALIDATION_TOOL_DEFINITION } from '../tools/advanced-caching/cache-invalidation.js';
import { CACHE_OPTIMIZER_TOOL_DEFINITION } from '../tools/advanced-caching/cache-optimizer.js';
import { CACHE_PARTITION_TOOL_DEFINITION } from '../tools/advanced-caching/cache-partition.js';
import { CACHE_REPLICATION_TOOL_DEFINITION } from '../tools/advanced-caching/cache-replication.js';
import { SMART_CACHE_TOOL_DEFINITION } from '../tools/advanced-caching/smart-cache.js';
import { ALERT_MANAGER_TOOL_DEFINITION } from '../tools/dashboard-monitoring/alert-manager.js';
import { METRIC_COLLECTOR_TOOL_DEFINITION } from '../tools/dashboard-monitoring/metric-collector.js';
import { MONITORING_INTEGRATION_TOOL_DEFINITION } from '../tools/dashboard-monitoring/monitoring-integration.js';
import { CUSTOM_WIDGET_TOOL_DEFINITION } from '../tools/dashboard-monitoring/custom-widget.js';
import { DATA_VISUALIZER_TOOL_DEFINITION } from '../tools/dashboard-monitoring/data-visualizer.js';
import { HEALTH_MONITOR_TOOL_DEFINITION } from '../tools/dashboard-monitoring/health-monitor.js';
import { LOG_DASHBOARD_TOOL_DEFINITION } from '../tools/dashboard-monitoring/log-dashboard.js';
import { INTELLIGENTASSISTANTTOOL } from '../tools/intelligence/intelligent-assistant.js';
import { NATURALLANGUAGEQUERYTOOL } from '../tools/intelligence/natural-language-query.js';
import { PATTERNRECOGNITIONTOOL } from '../tools/intelligence/pattern-recognition.js';
import { PREDICTIVEANALYTICSTOOL } from '../tools/intelligence/predictive-analytics.js';
import { RECOMMENDATIONENGINETOOL } from '../tools/intelligence/recommendation-engine.js';
import { SMARTSUMMARIZATIONTOOL } from '../tools/intelligence/smart-summarization.js';
import { ANOMALYEXPLAINERTOOL } from '../tools/intelligence/anomaly-explainer.js';
import { KNOWLEDGE_GRAPH_TOOL_DEFINITION } from '../tools/intelligence/knowledge-graph.js';
import { SENTIMENT_ANALYSIS_TOOL_DEFINITION } from '../tools/intelligence/sentiment-analysis.js';
import { GET_HOOK_ANALYTICS_TOOL_DEFINITION } from '../tools/analytics/get-hook-analytics.js';
import { GET_ACTION_ANALYTICS_TOOL_DEFINITION } from '../tools/analytics/get-action-analytics.js';
import { GET_MCP_SERVER_ANALYTICS_TOOL_DEFINITION } from '../tools/analytics/get-mcp-server-analytics.js';
import { EXPORT_ANALYTICS_TOOL_DEFINITION } from '../tools/analytics/export-analytics.js';
import { GET_OPTIMIZATION_REPORT_TOOL_DEFINITION } from '../tools/analytics/get-optimization-report.js';
import { OPTIMIZATION_STORAGE_TOOL_DEFINITION } from '../tools/optimization-storage-tool.js';
import { CONTEXT_DELTA_TOOL_DEFINITION } from '../tools/context-delta-tool.js';
import { SMART_SQL_TOOL_DEFINITION } from '../tools/api-database/smart-sql.js';
import { SMART_SCHEMA_TOOL_DEFINITION } from '../tools/api-database/smart-schema.js';
import { SMART_API_FETCH_TOOL_DEFINITION } from '../tools/api-database/smart-api-fetch.js';
import { SMART_CACHE_API_TOOL_DEFINITION } from '../tools/api-database/smart-cache-api.js';
import { SMART_DATABASE_TOOL_DEFINITION } from '../tools/api-database/smart-database.js';
import { SMART_GRAPHQL_TOOL_DEFINITION } from '../tools/api-database/smart-graphql.js';
import { SMART_MIGRATION_TOOL_DEFINITION } from '../tools/api-database/smart-migration.js';
import { SMART_ORM_TOOL_DEFINITION } from '../tools/api-database/smart-orm.js';
import { SMART_REST_TOOL_DEFINITION } from '../tools/api-database/smart-rest.js';
import { SMART_WEBSOCKET_TOOL_DEFINITION } from '../tools/api-database/smart-websocket.js';
import { SMART_PROCESSES_TOOL_DEFINITION } from '../tools/build-systems/smart-processes.js';
import { SMART_NETWORK_TOOL_DEFINITION } from '../tools/build-systems/smart-network.js';
import { SMART_LOGS_TOOL_DEFINITION } from '../tools/build-systems/smart-logs.js';
import { SMART_LINT_TOOL_DEFINITION } from '../tools/build-systems/smart-lint.js';
import { SMART_INSTALL_TOOL_DEFINITION } from '../tools/build-systems/smart-install.js';
import { SMART_DOCKER_TOOL_DEFINITION } from '../tools/build-systems/smart-docker.js';
import { SMART_BUILD_TOOL_DEFINITION } from '../tools/build-systems/smart-build.js';
import { SMART_SYSTEM_METRICS_TOOL_DEFINITION } from '../tools/build-systems/smart-system-metrics.js';
import { SMART_TEST_TOOL_DEFINITION } from '../tools/build-systems/smart-test.js';
import { SMART_TYPECHECK_TOOL_DEFINITION } from '../tools/build-systems/smart-typecheck.js';
import { SMART_CRON_TOOL_DEFINITION } from '../tools/system-operations/smart-cron.js';
import { SMART_USER_TOOL_DEFINITION } from '../tools/system-operations/smart-user.js';
import { SMART_DIFF_TOOL_DEFINITION } from '../tools/file-operations/smart-diff.js';
import { SMART_BRANCH_TOOL_DEFINITION } from '../tools/file-operations/smart-branch.js';
import { SMART_MERGE_TOOL_DEFINITION } from '../tools/file-operations/smart-merge.js';
import { SMART_STATUS_TOOL_DEFINITION } from '../tools/file-operations/smart-status.js';
import { SMART_LOG_TOOL_DEFINITION } from '../tools/file-operations/smart-log.js';
import { SMART_READ_TOOL_DEFINITION } from '../tools/file-operations/smart-read.js';
import { SMART_WRITE_TOOL_DEFINITION } from '../tools/file-operations/smart-write.js';
import { SMART_EDIT_TOOL_DEFINITION } from '../tools/file-operations/smart-edit.js';
import { SMART_GLOB_TOOL_DEFINITION } from '../tools/file-operations/smart-glob.js';
import { SMART_GREP_TOOL_DEFINITION } from '../tools/file-operations/smart-grep.js';

/**
 * Every tool this server advertises.
 *
 * Named, rather than inline in the handler, so ONE list is both what the
 * client is shown and what requests are validated against. When they were
 * two things, a tool could declare `required: [ormCode, ormType]` in the
 * schema a caller reads while its Zod entry was the permissive
 * GenericToolOptionsSchema -- and 43 of them use that. Omitting a required
 * field then reached the tool body, where smart_orm answered:
 *
 *     The "data" argument must be of type string or an instance of Buffer,
 *     TypedArray, or DataView. Received undefined
 *
 * which tells the caller nothing about the field they left out.
 */
export const TOOL_DEFINITIONS = [
  SMART_COMPLEXITY_TOOL_DEFINITION,
  SMART_DEPENDENCIES_TOOL_DEFINITION,
  SMART_EXPORTS_TOOL_DEFINITION,
  SMART_IMPORTS_TOOL_DEFINITION,
  SMART_REFACTOR_TOOL_DEFINITION,
  SMART_SECURITY_TOOL_DEFINITION,
  SMART_SYMBOLS_TOOL_DEFINITION,
  SMART_TYPESCRIPT_TOOL_DEFINITION,
  SMART_CONFIG_READ_TOOL_DEFINITION,
  SMART_ENV_TOOL_DEFINITION,
  SMART_PACKAGE_JSON_TOOL_DEFINITION,
  SMART_TSCONFIG_TOOL_DEFINITION,
  SMART_PRETTY_TOOL_DEFINITION,
  SMART_PROCESS_TOOL_DEFINITION,
  SMART_SERVICE_TOOL_DEFINITION,
  AUDIT_TOOL,
  DOCTOR_TOOL,
  FLEET_TOOL,
  WIKI_WRITE_TOOL_DEFINITION,
  WIKI_READ_TOOL_DEFINITION,
  WIKI_QUERY_TOOL_DEFINITION,
  ...UCR_TOOL_DEFINITIONS,
  EXPAND_TOOL,
  WASTE_TOOL,
  CACHE_TOOL,
  ROUTING_TOOL,
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
      'Count tokens in text using the pluggable tokenizer framework (#124). Picks a model-specific tokenizer (tiktoken for GPT/Claude, Google AI REST for Gemini, content-aware heuristic fallback).',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to count tokens for',
        },
        modelName: {
          type: 'string',
          description:
            'Model name (e.g. gpt-4, claude-opus-4-7, gemini-2.5-flash). Defaults to the server-configured model when omitted.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'compress_text',
    description:
      'Compress text using Brotli, returned as a base64 string. Intended for AT-REST STORAGE/caching (reduces bytes ~50%). NOTE: base64 tokenizes poorly, so the output usually has MORE LLM tokens than the input — do NOT feed the result into a model context expecting savings. The response includes originalTokens/compressedTokens and a warning when the output would increase tokens.',
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
      'Analyzes operations in the current session from the session JSONL log, identifies large text blocks from file-based tools (Read, Write, Edit), compresses them, and stores them in the cache to reduce future token usage. Returns a summary of the optimization.',
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
      'Analyze observed token usage across multiple sessions within a project. Aggregates session logs and identifies top contributors. Cost is Not priced unless the caller supplies an effective input-token rate; any resulting value is a cost equivalent, not an invoice.',
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
          format: 'date',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Optional end date filter (YYYY-MM-DD format).',
        },
        costPerMillionTokens: {
          type: 'number',
          description:
            'Optional effective USD cost per million input tokens. No provider price is assumed when omitted.',
          minimum: 0,
        },
      },
    },
  },
  PREDICTIVE_CACHE_TOOL_DEFINITION,
  CACHE_WARMUP_TOOL_DEFINITION,
  // Code analysis tools
  SMART_AST_GREP_TOOL_DEFINITION,
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
  // Dashboard & Monitoring tools
  ALERT_MANAGER_TOOL_DEFINITION,
  METRIC_COLLECTOR_TOOL_DEFINITION,
  MONITORING_INTEGRATION_TOOL_DEFINITION,
  CUSTOM_WIDGET_TOOL_DEFINITION,
  DATA_VISUALIZER_TOOL_DEFINITION,
  HEALTH_MONITOR_TOOL_DEFINITION,
  LOG_DASHBOARD_TOOL_DEFINITION,
  // Intelligence tools
  INTELLIGENTASSISTANTTOOL,
  NATURALLANGUAGEQUERYTOOL,
  PATTERNRECOGNITIONTOOL,
  PREDICTIVEANALYTICSTOOL,
  RECOMMENDATIONENGINETOOL,
  SMARTSUMMARIZATIONTOOL,
  ANOMALYEXPLAINERTOOL,
  KNOWLEDGE_GRAPH_TOOL_DEFINITION,
  SENTIMENT_ANALYSIS_TOOL_DEFINITION,
  SMART_WORKFLOW_TOOL_DEFINITION,
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
  // File operations tools

  SMART_DIFF_TOOL_DEFINITION,
  SMART_BRANCH_TOOL_DEFINITION,
  SMART_MERGE_TOOL_DEFINITION,
  SMART_STATUS_TOOL_DEFINITION,
  SMART_LOG_TOOL_DEFINITION,
  SMART_READ_TOOL_DEFINITION,
  SMART_WRITE_TOOL_DEFINITION,
  SMART_EDIT_TOOL_DEFINITION,
  SMART_GLOB_TOOL_DEFINITION,
  SMART_GREP_TOOL_DEFINITION,
  // Analytics tools
  GET_HOOK_ANALYTICS_TOOL_DEFINITION,
  GET_ACTION_ANALYTICS_TOOL_DEFINITION,
  GET_MCP_SERVER_ANALYTICS_TOOL_DEFINITION,
  EXPORT_ANALYTICS_TOOL_DEFINITION,
  GET_OPTIMIZATION_REPORT_TOOL_DEFINITION,
  OPTIMIZATION_STORAGE_TOOL_DEFINITION,
  CONTEXT_DELTA_TOOL_DEFINITION,
];
