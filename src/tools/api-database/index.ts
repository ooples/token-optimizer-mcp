/**
 * API & Database Tools
 *
 * Track 2B - API Response Caching & Database Query Optimization
 */

export {
  SmartCacheAPI,
  runSmartCacheApi,
  SMART_CACHE_API_TOOL_DEFINITION,
  type SmartCacheAPIOptions,
  type SmartCacheAPIResult,
  type APIRequest,
  type CachedResponse,
  type CachingStrategy,
  type InvalidationPattern,
  type CacheAnalysis,
} from "./smart-cache-api";

export {
  SmartApiFetch,
  runSmartApiFetch,
  SMART_API_FETCH_TOOL_DEFINITION,
} from "./smart-api-fetch";

export {
  SmartSchema,
  runSmartSchema,
  SMART_SCHEMA_TOOL_DEFINITION,
  type SmartSchemaOptions,
  type SmartSchemaResult,
  type SmartSchemaOutput,
  type DatabaseSchema,
  type TableInfo,
  type ColumnInfo,
  type ViewInfo,
  type IndexInfo,
  type ConstraintInfo,
  type Relationship,
  type RelationshipGraph,
  type CircularDependency,
  type SchemaAnalysis,
  type SchemaIssue,
  type MissingIndex as SchemaMissingIndex,
  type SchemaDiff,
} from "./smart-schema";

export {
  SmartREST,
  getSmartRest,
  runSmartREST,
  SMART_REST_TOOL_DEFINITION,
  type SmartRESTOptions,
  type SmartRESTResult,
  type EndpointInfo,
  type ResourceGroup,
  type HealthIssue,
  type RateLimit,
} from "./smart-rest";

export {
  SmartORM,
  runSmartORM,
  SMART_ORM_TOOL_DEFINITION,
  type SmartORMOptions,
  type SmartORMResult,
  type ORMType,
  type N1Instance,
  type EagerLoadingSuggestion,
  type QueryReduction,
  type IndexSuggestion,
} from "./smart-orm";

export {
  SmartSql,
  runSmartSql,
  SMART_SQL_TOOL_DEFINITION,
  type SmartSqlOptions,
  type SmartSqlOutput,
  type QueryAnalysis as SqlQueryAnalysis,
  type ExecutionPlanStep,
  type ExecutionPlan,
  type OptimizationSuggestion,
  type Optimization,
  type ValidationError,
  type Validation,
  type HistoryEntry,
} from "./smart-sql";

// SmartDatabase - Implementation pending
// Note: Exports temporarily removed until implementation is complete

export {
  SmartWebSocket,
  runSmartWebSocket,
  SMART_WEBSOCKET_TOOL_DEFINITION,
  type SmartWebSocketOptions,
  type SmartWebSocketResult,
  type Message,
  type MessageType,
} from "./smart-websocket";

export {
  SmartGraphQL,
  runSmartGraphQL,
  SMART_GRAPHQL_TOOL_DEFINITION,
  type SmartGraphQLOptions,
  type SmartGraphQLResult,
  type ComplexityMetrics,
  type FragmentSuggestion,
  type FieldReduction,
  type BatchOpportunity,
  type N1Problem,
  type QueryAnalysis as GraphQLQueryAnalysis,
  type Optimizations,
  type SchemaInfo,
} from "./smart-graphql";

export {
  SmartMigration,
  runSmartMigration,
  SMART_MIGRATION_TOOL_DEFINITION,
  type SmartMigrationOptions,
  type SmartMigrationResult,
  type SmartMigrationOutput,
  type Migration,
  type MigrationStatus,
  type MigrationHistoryEntry,
  type RollbackResult,
} from "./smart-migration";
