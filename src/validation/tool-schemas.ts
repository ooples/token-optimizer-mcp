import { z } from 'zod';

// Base schema for common options if any, or just define individual schemas
// BaseOptionsSchema removed - not used

// 1. optimize_text
export const OptimizeTextSchema = z.object({
  text: z.string().describe('Text to optimize'),
  key: z.string().describe('Cache key for storing the optimized text'),
  quality: z
    .number()
    .min(0)
    .max(11)
    .optional()
    .describe('Compression quality (0-11, default 11)'),
});

// 2. get_cached
export const GetCachedSchema = z.object({
  key: z.string().describe('Cache key to retrieve'),
});

// 3. count_tokens
export const CountTokensSchema = z.object({
  text: z.string().describe('Text to count tokens for'),
});

// 4. compress_text
export const CompressTextSchema = z.object({
  text: z.string().describe('Text to compress'),
  quality: z
    .number()
    .min(0)
    .max(11)
    .optional()
    .describe('Compression quality (0-11, default 11)'),
});

// 5. decompress_text
export const DecompressTextSchema = z.object({
  compressed: z.string().describe('Base64-encoded compressed text'),
});

// 6. get_cache_stats
export const GetCacheStatsSchema = z.object({});

// 7. clear_cache
export const ClearCacheSchema = z.object({
  confirm: z.boolean().refine((val) => val === true, {
    message: 'Must be true to confirm cache clearing',
  }),
});

// 8. analyze_optimization
export const AnalyzeOptimizationSchema = z.object({
  text: z.string().describe('Text to analyze'),
});

// 9. get_session_stats
export const GetSessionStatsSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      'Optional session ID to query. If not provided, uses current session.'
    ),
});

// 10. optimize_session
export const OptimizeSessionSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      'Optional session ID to optimize. If not provided, uses the current active session.'
    ),
  min_token_threshold: z
    .number()
    .optional()
    .default(30)
    .describe(
      'Minimum token count for a file operation to be considered for compression. Defaults to 30.'
    ),
});

// 11. analyze_project_tokens
export const AnalyzeProjectTokensSchema = z.object({
  projectPath: z
    .string()
    .optional()
    .describe(
      'Path to the project directory. If not provided, uses the hooks data directory.'
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Optional start date filter (YYYY-MM-DD format).'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Optional end date filter (YYYY-MM-DD format).'),
  costPerMillionTokens: z
    .number()
    .min(0)
    .optional()
    .default(30)
    .describe(
      'Cost per million tokens in USD. Defaults to 30 (GPT-4 Turbo pricing).'
    ),
});

// For tools using `args as any`, we'll create a generic schema or rely on their internal validation.
// Since the request asks for a schema that covers ALL tools, and these tools are defined
// by their `TOOL_DEFINITION` constants, we would ideally import those and extract their
// `inputSchema` to convert to Zod. However, without direct access to those files,
// and given the `args as any` usage, we'll define a placeholder for now.
// In a real-world scenario, you would import the actual Zod schemas from the tool definitions.

// Placeholder for tools that use `args as any`
const GenericToolOptionsSchema = z
  .record(z.any())
  .describe(
    'Generic options for tools without explicit inline schema validation.'
  );

// 12. predictive_cache (assuming it has its own schema defined in PREDICTIVE_CACHE_TOOL_DEFINITION)
// For now, using GenericToolOptionsSchema as a placeholder
export const PredictiveCacheSchema = GenericToolOptionsSchema;

// 13. cache_warmup
export const CacheWarmupSchema = GenericToolOptionsSchema;

// 14. smart_ast_grep
export const SmartAstGrepSchema = z
  .object({
    pattern: z.string().optional(),
  })
  .passthrough();

// 15. cache_analytics
export const CacheAnalyticsSchema = GenericToolOptionsSchema;

// 16. cache_benchmark
export const CacheBenchmarkSchema = GenericToolOptionsSchema;

// 17. cache_compression
export const CacheCompressionSchema = GenericToolOptionsSchema;

// 18. cache_invalidation
export const CacheInvalidationSchema = GenericToolOptionsSchema;

// 19. cache_optimizer
export const CacheOptimizerSchema = GenericToolOptionsSchema;

// 20. cache_partition
export const CachePartitionSchema = GenericToolOptionsSchema;

// 21. cache_replication
export const CacheReplicationSchema = GenericToolOptionsSchema;

// 22. smart_cache
export const SmartCacheSchema = GenericToolOptionsSchema;

// 23. smart_sql
export const SmartSqlSchema = GenericToolOptionsSchema;

// 24. smart_schema
export const SmartSchemaSchema = GenericToolOptionsSchema;

// 25. smart_api_fetch
export const SmartApiFetchSchema = GenericToolOptionsSchema;

// 26. smart_cache_api
export const SmartCacheApiSchema = GenericToolOptionsSchema;

// 27. smart_database
export const SmartDatabaseSchema = GenericToolOptionsSchema;

// 28. smart_graphql
export const SmartGraphQLSchema = GenericToolOptionsSchema;

// 29. smart_migration
export const SmartMigrationSchema = GenericToolOptionsSchema;

// 30. smart_orm
export const SmartOrmSchema = GenericToolOptionsSchema;

// 31. smart_rest
export const SmartRestSchema = GenericToolOptionsSchema;

// 32. smart_websocket
export const SmartWebSocketSchema = GenericToolOptionsSchema;

// 33. smart_processes
export const SmartProcessesSchema = GenericToolOptionsSchema;

// 34. smart_network
export const SmartNetworkSchema = GenericToolOptionsSchema;

// 35. smart_logs
export const SmartLogsSchema = GenericToolOptionsSchema;

// 36. smart_lint
export const SmartLintSchema = GenericToolOptionsSchema;

// 37. smart_install
export const SmartInstallSchema = GenericToolOptionsSchema;

// 38. smart_docker
export const SmartDockerSchema = GenericToolOptionsSchema;

// 39. smart_build
export const SmartBuildSchema = GenericToolOptionsSchema;

// 40. smart_system_metrics
export const SmartSystemMetricsSchema = GenericToolOptionsSchema;

// 41. smart_test
export const SmartTestSchema = GenericToolOptionsSchema;

// 42. smart_typecheck
export const SmartTypeCheckSchema = GenericToolOptionsSchema;

// 43. smart_cron
export const SmartCronSchema = GenericToolOptionsSchema;

// 44. smart_user
export const SmartUserSchema = GenericToolOptionsSchema;

// 45. smart_diff (using imported type SmartDiffOptions)
// In a real Zod implementation, you'd convert SmartDiffOptions to a Zod schema.
// For now, we'll assume it's an object with potentially any properties.
export const SmartDiffSchema = z
  .object({})
  .passthrough()
  .describe('Options for smart_diff tool');

// 46. smart_branch (using imported type SmartBranchOptions)
export const SmartBranchSchema = z
  .object({})
  .passthrough()
  .describe('Options for smart_branch tool');

// 47. smart_merge (using imported type SmartMergeOptions)
export const SmartMergeSchema = z
  .object({})
  .passthrough()
  .describe('Options for smart_merge tool');

// 48. smart_status (using imported type SmartStatusOptions)
export const SmartStatusSchema = z
  .object({})
  .passthrough()
  .describe('Options for smart_status tool');

// 49. smart_log (using imported type SmartLogOptions)
export const SmartLogSchema = z
  .object({})
  .passthrough()
  .describe('Options for smart_log tool');

// 50. smart_read
export const SmartReadSchema = z
  .object({
    path: z.string(),
  })
  .passthrough();

// 51. smart_write
export const SmartWriteSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .passthrough();

// 52. smart_edit
export const SmartEditSchema = z
  .object({
    path: z.string(),
    operations: z.any(),
  })
  .passthrough();

// 53. smart_glob
export const SmartGlobSchema = z
  .object({
    pattern: z.string(),
  })
  .passthrough();

// 54. smart_grep
export const SmartGrepSchema = z
  .object({
    pattern: z.string(),
  })
  .passthrough();

// 55. alert_manager
export const AlertManagerSchema = GenericToolOptionsSchema;

// 56. metric_collector
export const MetricCollectorSchema = GenericToolOptionsSchema;

// 57. monitoring_integration
export const MonitoringIntegrationSchema = GenericToolOptionsSchema;

// 58. custom_widget
export const CustomWidgetSchema = GenericToolOptionsSchema;

// 59. data_visualizer
export const DataVisualizerSchema = GenericToolOptionsSchema;

// 60. health_monitor
export const HealthMonitorSchema = GenericToolOptionsSchema;

// 61. log_dashboard
export const LogDashboardSchema = GenericToolOptionsSchema;

// 62. intelligent-assistant
export const IntelligentAssistantSchema = GenericToolOptionsSchema;

// 63. natural-language-query
export const NaturalLanguageQuerySchema = GenericToolOptionsSchema;

// 64. pattern-recognition
export const PatternRecognitionSchema = GenericToolOptionsSchema;

// 65. predictive-analytics
export const PredictiveAnalyticsSchema = GenericToolOptionsSchema;

// 66. recommendation-engine
export const RecommendationEngineSchema = GenericToolOptionsSchema;

// 67. smart-summarization
export const SmartSummarizationSchema = GenericToolOptionsSchema;

// 68. get_hook_analytics
export const GetHookAnalyticsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional start date filter in ISO 8601 format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional end date filter in ISO 8601 format"),
});

// 69. get_action_analytics
export const GetActionAnalyticsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional start date filter in ISO 8601 format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional end date filter in ISO 8601 format"),
});

// 70. get_mcp_server_analytics
export const GetMcpServerAnalyticsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional start date filter in ISO 8601 format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional end date filter in ISO 8601 format"),
});

// 71. export_analytics
export const ExportAnalyticsSchema = z.object({
  format: z.enum(["json", "csv"]).describe("Output format: json or csv"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional start date filter in ISO 8601 format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).optional().describe("Optional end date filter in ISO 8601 format"),
  hookPhase: z.enum(["PreToolUse", "PostToolUse", "SessionStart", "PreCompact", "UserPromptSubmit", "Unknown"]).optional().describe("Optional filter by hook phase"),
  toolName: z.string().optional().describe("Optional filter by tool/action name"),
  mcpServer: z.string().optional().describe("Optional filter by MCP server name"),
});

// Map tool names to their schemas for easy lookup
export const toolSchemaMap: Record<string, z.ZodType<any>> = {
  optimize_text: OptimizeTextSchema,
  get_cached: GetCachedSchema,
  count_tokens: CountTokensSchema,
  compress_text: CompressTextSchema,
  decompress_text: DecompressTextSchema,
  get_cache_stats: GetCacheStatsSchema,
  clear_cache: ClearCacheSchema,
  analyze_optimization: AnalyzeOptimizationSchema,
  get_session_stats: GetSessionStatsSchema,
  optimize_session: OptimizeSessionSchema,
  analyze_project_tokens: AnalyzeProjectTokensSchema,
  predictive_cache: PredictiveCacheSchema,
  cache_warmup: CacheWarmupSchema,
  smart_ast_grep: SmartAstGrepSchema,
  cache_analytics: CacheAnalyticsSchema,
  cache_benchmark: CacheBenchmarkSchema,
  cache_compression: CacheCompressionSchema,
  cache_invalidation: CacheInvalidationSchema,
  cache_optimizer: CacheOptimizerSchema,
  cache_partition: CachePartitionSchema,
  cache_replication: CacheReplicationSchema,
  smart_cache: SmartCacheSchema,
  smart_sql: SmartSqlSchema,
  smart_schema: SmartSchemaSchema,
  smart_api_fetch: SmartApiFetchSchema,
  smart_cache_api: SmartCacheApiSchema,
  smart_database: SmartDatabaseSchema,
  smart_graphql: SmartGraphQLSchema,
  smart_migration: SmartMigrationSchema,
  smart_orm: SmartOrmSchema,
  smart_rest: SmartRestSchema,
  smart_websocket: SmartWebSocketSchema,
  smart_processes: SmartProcessesSchema,
  smart_network: SmartNetworkSchema,
  smart_logs: SmartLogsSchema,
  smart_lint: SmartLintSchema,
  smart_install: SmartInstallSchema,
  smart_docker: SmartDockerSchema,
  smart_build: SmartBuildSchema,
  smart_system_metrics: SmartSystemMetricsSchema,
  smart_test: SmartTestSchema,
  smart_typecheck: SmartTypeCheckSchema,
  smart_cron: SmartCronSchema,
  smart_user: SmartUserSchema,
  smart_diff: SmartDiffSchema,
  smart_branch: SmartBranchSchema,
  smart_merge: SmartMergeSchema,
  smart_status: SmartStatusSchema,
  smart_log: SmartLogSchema,
  smart_read: SmartReadSchema,
  smart_write: SmartWriteSchema,
  smart_edit: SmartEditSchema,
  smart_glob: SmartGlobSchema,
  smart_grep: SmartGrepSchema,
  alert_manager: AlertManagerSchema,
  metric_collector: MetricCollectorSchema,
  monitoring_integration: MonitoringIntegrationSchema,
  custom_widget: CustomWidgetSchema,
  data_visualizer: DataVisualizerSchema,
  health_monitor: HealthMonitorSchema,
  log_dashboard: LogDashboardSchema,
  'intelligent-assistant': IntelligentAssistantSchema,
  'natural-language-query': NaturalLanguageQuerySchema,
  'pattern-recognition': PatternRecognitionSchema,
  'predictive-analytics': PredictiveAnalyticsSchema,
  'recommendation-engine': RecommendationEngineSchema,
  'smart-summarization': SmartSummarizationSchema,
  get_hook_analytics: GetHookAnalyticsSchema,
  get_action_analytics: GetActionAnalyticsSchema,
  get_mcp_server_analytics: GetMcpServerAnalyticsSchema,
  export_analytics: ExportAnalyticsSchema,
};
