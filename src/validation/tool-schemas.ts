import { z } from 'zod';

// Base schema for common options if any, or just define individual schemas
// BaseOptionsSchema removed - not used

// ---------------------------------------------------------------------------
// Reusable security validators (defense-in-depth)
//
// These mirror the runtime argv-mode guards in src/utils/safe-exec.ts. They
// reject command-injection / option-injection payloads in the dangerous string
// fields of the git/system tools at the validation boundary, before the value
// ever reaches a tool implementation. Argv-mode execution remains the primary
// protection; these are an additional early-rejection layer.
// ---------------------------------------------------------------------------

/** A git ref / branch / tag / commit-ish: allowlist of safe characters only. */
const safeGitRef = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9._/+@~^{}-]+$/,
    'must contain only characters valid in a git ref'
  )
  .refine((v) => !v.startsWith('-'), { message: "must not start with '-'" });

/** A filesystem path argument: rejects NUL/newline and leading '-'. */
const safePathArg = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !/[\0\n\r]/.test(v), {
    message: 'must not contain control characters',
  })
  .refine((v) => !v.startsWith('-'), { message: "must not start with '-'" });

/** A free-text git filter (author, grep, date) — argv-mode safe; reject only NUL/newline. */
const safeFilterText = z
  .string()
  .max(1024)
  .refine((v) => !/[\0\n\r]/.test(v), {
    message: 'must not contain control characters',
  });

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
  modelName: z
    .string()
    .optional()
    .describe(
      'Model name (e.g. gpt-4, claude-opus-4-7, gemini-2.5-flash). ' +
        'Defaults to the server-configured model when omitted.'
    ),
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
    .describe(
      'Optional effective USD cost per million input tokens. No provider price is assumed when omitted.'
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
  .record(z.string(), z.any())
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
// packageManager is constrained to a strict enum (it is used as the executable
// name); package specs must not be option flags or contain control characters.
export const SmartInstallSchema = z
  .object({
    packageManager: z.enum(['npm', 'yarn', 'pnpm']).optional(),
    packages: z
      .array(
        z
          .string()
          .min(1)
          .max(214)
          .refine((v) => !v.startsWith('-'), {
            message: "package name must not start with '-'",
          })
          .refine((v) => !/[\0\n\r]/.test(v), {
            message: 'package name must not contain control characters',
          })
      )
      .optional(),
    dev: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .passthrough()
  .describe('Options for smart_install tool');

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
// username / groupname / path reach external lookup commands; validate them.
export const SmartUserSchema = z
  .object({
    username: safePathArg.optional(),
    groupname: safePathArg.optional(),
    path: safePathArg.optional(),
  })
  .passthrough()
  .describe('Options for smart_user tool');

// 45. smart_diff (using imported type SmartDiffOptions)
// Security-sensitive ref/path fields are validated; other documented options
// pass through so the schema stays in sync with the tool without breakage.
export const SmartDiffSchema = z
  .object({
    source: safeGitRef.optional(),
    target: safeGitRef.optional(),
    ref: safeGitRef.optional(),
    files: z.array(safePathArg).optional(),
    filePattern: safePathArg.optional(),
  })
  .passthrough()
  .describe('Options for smart_diff tool');

// 46. smart_branch (using imported type SmartBranchOptions)
export const SmartBranchSchema = z
  .object({
    mergedInto: safeGitRef.optional(),
    branch: safeGitRef.optional(),
    pattern: safeFilterText.optional(),
  })
  .passthrough()
  .describe('Options for smart_branch tool');

// 47. smart_merge (using imported type SmartMergeOptions)
export const SmartMergeSchema = z
  .object({
    branch: safeGitRef.optional(),
    commit: safeGitRef.optional(),
    strategy: safeGitRef.optional(),
    strategyOption: z.array(safeFilterText).optional(),
  })
  .passthrough()
  .describe('Options for smart_merge tool');

// 48. smart_status (using imported type SmartStatusOptions)
export const SmartStatusSchema = z
  .object({
    filePath: safePathArg.optional(),
  })
  .passthrough()
  .describe('Options for smart_status tool');

// 49. smart_log (using imported type SmartLogOptions)
export const SmartLogSchema = z
  .object({
    branch: safeGitRef.optional(),
    since: safeFilterText.optional(),
    until: safeFilterText.optional(),
    author: safeFilterText.optional(),
    grep: safeFilterText.optional(),
    filePath: safePathArg.optional(),
  })
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

// wiki_write: a deliberate agent write into the knowledge graph.
export const WikiWriteSchema = z
  .object({
    claim: z.string(),
    anchors: z.array(z.string()),
  })
  .passthrough();
// wiki_read: the retrieval counterpart to wiki_write. Neither anchors nor
// projectRoot is required at the schema level; the tool reports which is missing,
// so the caller gets an explanation rather than a validation rejection.
export const WikiReadSchema = z.object({}).passthrough();

export const ContextPageSchema = z
  .object({
    query: z.string(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    trigger: z
      .enum(['task', 'plan', 'file', 'symbol', 'tool', 'command', 'validation'])
      .optional(),
    budget: z.number().min(0).max(2048).optional(),
  })
  .passthrough();
export const ContextReceiptVerifySchema = z
  .object({ deliveryEventId: z.string().min(1) })
  .strict();
export const CognitionRecordSchema = z
  .object({
    operation: z.enum(['verify-evidence', 'record']).optional(),
    kind: z
      .enum([
        'claim',
        'failure',
        'decision',
        'procedure',
        'goal',
        'hypothesis',
        'guard',
      ])
      .optional(),
    semanticObject: z.record(z.string(), z.unknown()).optional(),
    evidenceReceipts: z.array(z.record(z.string(), z.unknown())).min(1),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.operation === 'verify-evidence') return;
    if (!value.kind)
      context.addIssue({ code: 'custom', path: ['kind'], message: 'Required' });
    if (!value.semanticObject)
      context.addIssue({
        code: 'custom',
        path: ['semanticObject'],
        message: 'Required',
      });
  });
export const CheckpointHandoffSchema = z
  .object({
    operation: z.enum(['create', 'restore']),
    checkpoint: z.record(z.string(), z.unknown()),
    currentState: z.record(z.string(), z.unknown()).optional(),
    boundary: z.string().optional(),
    consumer: z.string().optional(),
  })
  .passthrough();
export const OutcomeReportSchema = z
  .object({
    episodeId: z.string(),
    outcome: z.record(z.string(), z.unknown()),
    graderReceipt: z.record(z.string(), z.unknown()),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
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
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional start date filter in ISO 8601 format'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional end date filter in ISO 8601 format'),
});

// 69. get_action_analytics
export const GetActionAnalyticsSchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional start date filter in ISO 8601 format'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional end date filter in ISO 8601 format'),
});

// 70. get_mcp_server_analytics
export const GetMcpServerAnalyticsSchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional start date filter in ISO 8601 format'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional end date filter in ISO 8601 format'),
});

// 71. export_analytics
export const ExportAnalyticsSchema = z.object({
  format: z.enum(['json', 'csv']).describe('Output format: json or csv'),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional start date filter in ISO 8601 format'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional end date filter in ISO 8601 format'),
  hookPhase: z
    .enum([
      'PreToolUse',
      'PostToolUse',
      'SessionStart',
      'PreCompact',
      'UserPromptSubmit',
      'Unknown',
    ])
    .optional()
    .describe('Optional filter by hook phase'),
  toolName: z
    .string()
    .optional()
    .describe('Optional filter by tool/action name'),
  mcpServer: z
    .string()
    .optional()
    .describe('Optional filter by MCP server name'),
});

// 71b. get_optimization_report
export const GetOptimizationReportSchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional start date filter in ISO 8601 format'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    .optional()
    .describe('Optional end date filter in ISO 8601 format'),
  sessionId: z
    .string()
    .optional()
    .describe('Optional session ID to scope the report to a single session'),
  topN: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Limit each breakdown to the top N rows (default 10)'),
});

// 72. optimization_storage — discriminated union keyed on `operation` so
// the zod validator rejects a `store` request missing the required
// payload fields at validateToolArgs time, instead of after dispatch.
export const OptimizationStorageSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('store'),
    originalTextHash: z.string().min(1),
    optimizedText: z.string(),
    originalTokens: z.number().nonnegative(),
    optimizedTokens: z.number().nonnegative(),
    tokensSaved: z.number(),
  }),
  z.object({
    operation: z.literal('retrieve'),
    originalTextHash: z.string().min(1),
  }),
]);

// 73. context_delta — discriminated on operation so compute-delta and
// seed require currentContent at validation time rather than runtime.
export const ContextDeltaSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('compute-delta'),
    sessionId: z.string().min(1),
    filePath: z.string().min(1),
    currentContent: z.string(),
  }),
  z.object({
    operation: z.literal('seed'),
    sessionId: z.string().min(1),
    filePath: z.string().min(1),
    currentContent: z.string(),
  }),
  z.object({
    operation: z.literal('clear'),
    sessionId: z.string().min(1),
    filePath: z.string().min(1),
  }),
]);

// Map tool names to their schemas for easy lookup

/* ------------------------------------------------------------------------ *
 * Tools that were advertised but could not be called.
 *
 * validateToolArgs looks every tools/call up in toolSchemaMap and throws
 * "Unknown tool: X. No validation schema available." when there is no entry.
 * A tool can therefore be imported, registered, listed by tools/list and
 * dispatched -- and still be impossible to invoke. Fifteen were in exactly
 * that state, and two more (cache_benchmark, smart_cache_api) advertised a
 * HYPHENATED name while their schema and dispatch case both used underscores,
 * so no client could ever reach them either.
 *
 * Each schema below is generated from the tool's OWN published inputSchema, so
 * validation accepts precisely what the advertised schema promises rather than
 * a guess at it.
 * ------------------------------------------------------------------------ */

// smart_complexity
export const SmartComplexitySchema = z
  .object({
    filePath: z.string().optional(),
    fileContent: z.string().optional(),
    projectRoot: z.string().optional(),
    includeHalstead: z.boolean().optional(),
    includeMaintainability: z.boolean().optional(),
    threshold: z.record(z.any()).optional(),
    force: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
  })
  .passthrough();

// smart_dependencies
export const SmartDependenciesSchema = z
  .object({
    cwd: z.string().optional(),
    files: z.array(z.any()).optional(),
    mode: z.enum(['graph', 'circular', 'unused', 'impact']).optional(),
    targetFile: z.string().optional(),
    includeExternal: z.boolean().optional(),
    maxDepth: z.number().optional(),
    useCache: z.boolean().optional(),
    incrementalUpdate: z.boolean().optional(),
    format: z.enum(['compact', 'detailed']).optional(),
  })
  .passthrough();

// smart_exports
export const SmartExportsSchema = z
  .object({
    filePath: z.string().optional(),
    fileContent: z.string().optional(),
    projectRoot: z.string().optional(),
    force: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
    checkUsage: z.boolean().optional(),
    scanDepth: z.number().optional(),
  })
  .passthrough();

// smart_imports
export const SmartImportsSchema = z
  .object({
    filePath: z.string().optional(),
    fileContent: z.string().optional(),
    projectRoot: z.string().optional(),
    force: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
    checkCircular: z.boolean().optional(),
    suggestMissing: z.boolean().optional(),
  })
  .passthrough();

// smart_refactor
export const SmartRefactorSchema = z
  .object({
    filePath: z.string().optional(),
    fileContent: z.string().optional(),
    projectRoot: z.string().optional(),
    refactorTypes: z.array(z.any()).optional(),
    minComplexityForExtraction: z.number().optional(),
    force: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
  })
  .passthrough();

// smart_security
export const SmartSecuritySchema = z
  .object({
    force: z.boolean().optional(),
    projectRoot: z.string().optional(),
    targets: z.array(z.any()).optional(),
    exclude: z.array(z.any()).optional(),
    minSeverity: z
      .enum(['critical', 'high', 'medium', 'low', 'info'])
      .optional(),
    maxCacheAge: z.number().optional(),
    includeLowSeverity: z.boolean().optional(),
  })
  .passthrough();

// smart_symbols
export const SmartSymbolsSchema = z
  .object({
    filePath: z.string(),
    symbolTypes: z.array(z.any()).optional(),
    includeExported: z.boolean().optional(),
    includeImported: z.boolean().optional(),
    projectRoot: z.string().optional(),
    force: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
  })
  .passthrough();

// smart_typescript
export const SmartTypescriptSchema = z
  .object({
    force: z.boolean().optional(),
    projectRoot: z.string().optional(),
    tsconfig: z.string().optional(),
    maxCacheAge: z.number().optional(),
    files: z.array(z.any()).optional(),
    includeTypeInfo: z.boolean().optional(),
  })
  .passthrough();

// smart_config_read
export const SmartConfigReadSchema = z
  .object({
    path: z.string(),
    format: z.enum(['json', 'yaml', 'yml', 'toml', 'auto']).optional(),
    diffMode: z.boolean().optional(),
    validateSchema: z.boolean().optional(),
    inferSchema: z.boolean().optional(),
    includeSuggestions: z.boolean().optional(),
    validateOnly: z.boolean().optional(),
    schema: z.record(z.any()).optional(),
    strictMode: z.boolean().optional(),
    ttl: z.number().optional(),
  })
  .passthrough();

// smart_env
export const SmartEnvSchema = z
  .object({
    envFile: z.string().optional(),
    envContent: z.string().optional(),
    checkSecurity: z.boolean().optional(),
    suggestMissing: z.boolean().optional(),
    environment: z.enum(['development', 'staging', 'production']).optional(),
    requiredVars: z.array(z.any()).optional(),
    force: z.boolean().optional(),
    ttl: z.number().optional(),
  })
  .passthrough();

// smart_package_json
export const SmartPackageJsonSchema = z
  .object({
    projectRoot: z.string().optional(),
    force: z.boolean().optional(),
    checkOutdated: z.boolean().optional(),
    checkSecurity: z.boolean().optional(),
    includeDependencyTree: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
    maxTreeDepth: z.number().optional(),
  })
  .passthrough();

// smart_tsconfig
export const SmartTsconfigSchema = z
  .object({
    configPath: z.string().optional(),
    projectRoot: z.string().optional(),
    includeIssues: z.boolean().optional(),
    includeSuggestions: z.boolean().optional(),
    maxCacheAge: z.number().optional(),
  })
  .passthrough();

// smart_pretty
export const SmartPrettySchema = z
  .object({
    operation: z.enum([
      'highlight-code',
      'format-code',
      'detect-language',
      'apply-theme',
    ]),
    code: z.string().optional(),
    filePath: z.string().optional(),
    language: z.string().optional(),
    outputMode: z.enum(['ansi', 'html', 'plain']).optional(),
    theme: z
      .enum([
        'default',
        'monokai',
        'github',
        'solarized-dark',
        'solarized-light',
        'dracula',
        'nord',
        'atom-one-dark',
        'atom-one-light',
        'custom',
      ])
      .optional(),
    customTheme: z.record(z.any()).optional(),
    showLineNumbers: z.boolean().optional(),
    highlightLines: z.array(z.any()).optional(),
    startLine: z.number().optional(),
    formatCode: z.boolean().optional(),
    prettierConfig: z.record(z.any()).optional(),
    tabWidth: z.number().optional(),
    useTabs: z.boolean().optional(),
    semi: z.boolean().optional(),
    singleQuote: z.boolean().optional(),
    trailingComma: z.enum(['none', 'es5', 'all']).optional(),
    printWidth: z.number().optional(),
    hints: z.array(z.any()).optional(),
    includeBackground: z.boolean().optional(),
    inlineStyles: z.boolean().optional(),
    wrapCode: z.boolean().optional(),
    useCache: z.boolean().optional(),
    ttl: z.number().optional(),
  })
  .passthrough();

// smart_process
export const SmartProcessSchema = z
  .object({
    operation: z.enum([
      'start',
      'stop',
      'status',
      'monitor',
      'tree',
      'restart',
    ]),
    pid: z.number().optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.any()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.any()).optional(),
    detached: z.boolean().optional(),
    autoRestart: z.boolean().optional(),
    interval: z.number().optional(),
    duration: z.number().optional(),
    useCache: z.boolean().optional(),
    ttl: z.number().optional(),
  })
  .passthrough();

// smart_service
export const SmartServiceSchema = z
  .object({
    operation: z.enum([
      'start',
      'stop',
      'restart',
      'status',
      'enable',
      'disable',
      'health-check',
      'list-dependencies',
    ]),
    serviceType: z.enum(['systemd', 'windows', 'docker']).optional(),
    serviceName: z.string(),
    autoDetect: z.boolean().optional(),
    useCache: z.boolean().optional(),
    ttl: z.number().optional(),
  })
  .passthrough();

export const toolSchemaMap: Record<string, z.ZodType<any>> = {
  smart_complexity: SmartComplexitySchema,
  smart_dependencies: SmartDependenciesSchema,
  smart_exports: SmartExportsSchema,
  smart_imports: SmartImportsSchema,
  smart_refactor: SmartRefactorSchema,
  smart_security: SmartSecuritySchema,
  smart_symbols: SmartSymbolsSchema,
  smart_typescript: SmartTypescriptSchema,
  smart_config_read: SmartConfigReadSchema,
  smart_env: SmartEnvSchema,
  smart_package_json: SmartPackageJsonSchema,
  smart_tsconfig: SmartTsconfigSchema,
  smart_pretty: SmartPrettySchema,
  smart_process: SmartProcessSchema,
  smart_service: SmartServiceSchema,
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
  wiki_write: WikiWriteSchema,
  wiki_read: WikiReadSchema,
  context_page: ContextPageSchema,
  context_receipt_verify: ContextReceiptVerifySchema,
  cognition_record: CognitionRecordSchema,
  checkpoint_handoff: CheckpointHandoffSchema,
  outcome_report: OutcomeReportSchema,
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
  get_optimization_report: GetOptimizationReportSchema,
  optimization_storage: OptimizationStorageSchema,
  context_delta: ContextDeltaSchema,
};
