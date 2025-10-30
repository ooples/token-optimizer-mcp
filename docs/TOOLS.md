# Token Optimizer MCP - Complete Tool Reference

This document provides comprehensive documentation for all 61 tools available in the Token Optimizer MCP server.

## Table of Contents

- [Core Caching & Optimization](#core-caching--optimization) (8 tools)
- [Smart File Operations](#smart-file-operations) (10 tools)
- [API & Database Operations](#api--database-operations) (10 tools)
- [Build & Test Operations](#build--test-operations) (10 tools)
- [Advanced Caching](#advanced-caching) (10 tools)
- [Monitoring & Dashboards](#monitoring--dashboards) (7 tools)
- [System Operations](#system-operations) (6 tools)

---

## Core Caching & Optimization

### optimize_text

Compress and cache text to reduce token usage. This is the primary tool for removing content from your context window.

**Parameters:**
- `text` (string, required) - Text to optimize
- `key` (string, required) - Cache key for storing
- `quality` (number, optional) - Compression quality 0-11 (default: 11)

**Returns:**
- `success` (boolean) - Operation status
- `key` (string) - Cache key
- `originalTokens` (number) - Tokens before optimization
- `compressedTokens` (number) - Tokens in compressed form
- `tokensSaved` (number) - Context window savings
- `percentSaved` (number) - Percentage reduction
- `cached` (boolean) - Whether data was cached

**Token Reduction:** 60-90% average

**Example:**
```typescript
optimize_text({
  text: "Large API response or file content...",
  key: "api-response-key",
  quality: 11
})
```

---

### get_cached

Retrieve previously cached and optimized text.

**Parameters:**
- `key` (string, required) - Cache key to retrieve

**Returns:**
- `success` (boolean) - Operation status
- `key` (string) - Cache key
- `text` (string) - Original cached text
- `fromCache` (boolean) - Whether data was found in cache

**Example:**
```typescript
get_cached({ key: "api-response-key" })
```

---

### compress_text

Compress text using Brotli compression. Returns base64-encoded compressed data.

**Parameters:**
- `text` (string, required) - Text to compress
- `quality` (number, optional) - Compression quality 0-11 (default: 11)

**Returns:**
- `compressed` (string) - Base64-encoded compressed data

**Note:** Base64 encoding adds ~33% overhead. Use `optimize_text` for better token reduction.

---

### decompress_text

Decompress base64-encoded Brotli-compressed text.

**Parameters:**
- `compressed` (string, required) - Base64-encoded compressed text

**Returns:**
- `text` (string) - Original decompressed text

---

### count_tokens

Count tokens in text using tiktoken (GPT-4 tokenizer).

**Parameters:**
- `text` (string, required) - Text to count tokens for

**Returns:**
- `tokens` (number) - Token count
- `characters` (number) - Character count

**Example:**
```typescript
count_tokens({ text: "Your text here" })
// Result: { tokens: 150, characters: 500 }
```

---

### analyze_optimization

Analyze text and provide recommendations for optimization including compression benefits and token savings.

**Parameters:**
- `text` (string, required) - Text to analyze

**Returns:**
- `tokens` - Token analysis
  - `current` (number) - Current token count
  - `afterCompression` (number) - Estimated tokens after compression
  - `saved` (number) - Estimated token savings
  - `percentSaved` (number) - Percentage reduction
- `size` - Size analysis
  - `current` (number) - Current size in bytes
  - `compressed` (number) - Estimated compressed size
  - `ratio` (number) - Compression ratio
  - `percentSaved` (number) - Percentage reduction
- `recommendations` - Optimization recommendations
  - `shouldCompress` (boolean) - Whether compression is recommended
  - `reason` (string) - Recommendation rationale

---

### get_cache_stats

Get comprehensive cache statistics including hit rate, compression ratio, and token savings.

**Parameters:** None

**Returns:**
- `totalEntries` (number) - Number of cached entries
- `totalSize` (number) - Total cache size in bytes
- `hits` (number) - Cache hits
- `misses` (number) - Cache misses
- `hitRate` (number) - Hit rate percentage
- `avgCompressionRatio` (number) - Average compression ratio
- `totalTokensSaved` (number) - Total tokens saved across all operations

---

### clear_cache

Clear all cached data. Use with caution.

**Parameters:**
- `confirm` (boolean, required) - Must be true to confirm

**Returns:**
- `success` (boolean) - Operation status

---

## Smart File Operations

### smart_read

Read files with 80% token reduction through intelligent caching and diff-based updates.

**Parameters:**
- `path` (string, required) - Path to file
- `diffMode` (boolean, optional) - Return only diff if previously read (default: true)
- `maxSize` (number, optional) - Max content size in bytes (default: 100000)
- `chunkSize` (number, optional) - Size of chunks for large files (default: 4000)
- `chunkIndex` (number, optional) - Chunk index to retrieve

**Token Reduction:** 80% on subsequent reads (diff-only)

**Example:**
```typescript
// First read: full content
smart_read({ path: "/src/app.ts" })

// Subsequent reads: only changes
smart_read({ path: "/src/app.ts" })
```

---

### smart_write

Write files with verification, atomic operations, and change tracking.

**Parameters:**
- `path` (string, required) - Path to file
- `content` (string, required) - Content to write
- `atomic` (boolean, optional) - Use atomic write with temp file (default: true)
- `autoFormat` (boolean, optional) - Auto-format code before writing (default: true)
- `verifyBeforeWrite` (boolean, optional) - Skip write if content identical (default: true)
- `returnDiff` (boolean, optional) - Return diff instead of full content (default: true)

**Token Reduction:** 85% through verification and diff output

---

### smart_edit

Line-based file editing with diff-only output.

**Parameters:**
- `path` (string, required) - Path to file
- `operations` (array, required) - Edit operations
  - `type` - "replace", "insert", or "delete"
  - `startLine` (number) - Starting line number (1-based)
  - `endLine` (number, optional) - Ending line for replace/delete
  - `content` (string, optional) - Content for replace/insert
  - `pattern` (string, optional) - Regex pattern for pattern-based replacement
  - `replacement` (string, optional) - Replacement text for pattern
- `createBackup` (boolean, optional) - Create backup before editing (default: true)
- `dryRun` (boolean, optional) - Preview changes without applying (default: false)
- `returnDiff` (boolean, optional) - Return diff instead of full content (default: true)

**Token Reduction:** 90% through diff-only output

---

### smart_grep

Search file contents with match-only output and smart filtering.

**Parameters:**
- `pattern` (string, required) - Search pattern (regex)
- `cwd` (string, optional) - Working directory for search
- `files` (array, optional) - File patterns to search (glob patterns)
- `extensions` (array, optional) - Search only these file extensions
- `caseSensitive` (boolean, optional) - Case-sensitive search (default: false)
- `regex` (boolean, optional) - Treat pattern as regex (default: false)
- `count` (boolean, optional) - Only return match counts per file (default: false)
- `filesWithMatches` (boolean, optional) - Only return filenames (default: false)
- `includeContext` (boolean, optional) - Include context lines around matches (default: false)
- `contextBefore` (number, optional) - Lines of context before match (default: 0)
- `contextAfter` (number, optional) - Lines of context after match (default: 0)
- `limit` (number, optional) - Maximum matches to return

**Token Reduction:** 80% through match-only output

---

### smart_glob

File pattern matching with path-only results and smart filtering.

**Parameters:**
- `pattern` (string, required) - Glob pattern (e.g., "src/**/*.ts")
- `cwd` (string, optional) - Working directory
- `extensions` (array, optional) - Filter by file extensions
- `includeMetadata` (boolean, optional) - Include file metadata (default: false)
- `includeContent` (boolean, optional) - Include file content for small files (default: false)
- `sortBy` (string, optional) - Sort by "name", "size", "modified", or "path" (default: "path")
- `limit` (number, optional) - Maximum results

**Token Reduction:** 75% through path-only results

---

### smart_diff

Git diffs with diff-only output and smart filtering.

**Parameters:**
- `source` (string, optional) - Source commit/branch (default: HEAD)
- `target` (string, optional) - Target commit/branch (default: working directory)
- `files` (array, optional) - Specific files to diff
- `filePattern` (string, optional) - Pattern to filter files
- `contextLines` (number, optional) - Lines of context around changes (default: 3)
- `staged` (boolean, optional) - Diff staged changes only (default: false)
- `summaryOnly` (boolean, optional) - Only return statistics (default: false)
- `limit` (number, optional) - Maximum files to diff
- `cwd` (string, optional) - Working directory

**Token Reduction:** 85% through diff-only output

---

### smart_branch

Git branch listing with structured JSON output and smart filtering.

**Parameters:**
- `cwd` (string, optional) - Working directory
- `all` (boolean, optional) - Include local and remote branches (default: false)
- `remote` (boolean, optional) - Include remote branches (default: false)
- `pattern` (string, optional) - Filter branches by pattern (e.g., "feature/*")
- `merged` (boolean, optional) - Only show merged branches (default: false)
- `unmerged` (boolean, optional) - Only show unmerged branches (default: false)
- `includeCommit` (boolean, optional) - Include last commit info (default: false)
- `includeTracking` (boolean, optional) - Include ahead/behind tracking (default: false)
- `namesOnly` (boolean, optional) - Only return branch names (default: false)
- `sortBy` (string, optional) - Sort by "name", "date", or "author" (default: "name")
- `limit` (number, optional) - Maximum branches to return

**Token Reduction:** 60% through structured JSON

---

### smart_log

Git commit history with smart filtering and structured output.

**Parameters:**
- `cwd` (string, optional) - Working directory
- `limit` (number, optional) - Maximum commits to return (default: 50)
- `offset` (number, optional) - Skip first N commits (default: 0)
- `branch` (string, optional) - Specific branch (default: current)
- `author` (string, optional) - Filter by author name or email
- `since` (string, optional) - Show commits since ref/date
- `until` (string, optional) - Show commits until ref/date
- `filePath` (string, optional) - Only commits affecting this file/directory
- `grep` (string, optional) - Filter by commit message pattern
- `format` (string, optional) - "oneline", "short", or "full" (default: "short")
- `includeFiles` (boolean, optional) - Include changed files list (default: false)
- `includeStats` (boolean, optional) - Include addition/deletion stats (default: false)

**Token Reduction:** 75% through structured JSON

---

### smart_merge

Git merge management with structured status and conflict analysis.

**Parameters:**
- `mode` (string, optional) - "status", "merge", "abort", or "continue" (default: "status")
- `branch` (string, optional) - Branch to merge from (for merge mode)
- `commit` (string, optional) - Specific commit to merge (for merge mode)
- `strategy` (string, optional) - Merge strategy: "recursive", "ours", "theirs", "octopus", "subtree" (default: "recursive")
- `noFf` (boolean, optional) - No fast-forward merge (default: false)
- `ffOnly` (boolean, optional) - Fast-forward only (default: false)
- `squash` (boolean, optional) - Squash commits (default: false)
- `noCommit` (boolean, optional) - Don't create merge commit (default: false)
- `summaryOnly` (boolean, optional) - Only return counts and status (default: false)
- `conflictsOnly` (boolean, optional) - Only return conflict information (default: false)
- `includeContent` (boolean, optional) - Include file content for conflicts (default: false)
- `maxConflicts` (number, optional) - Maximum conflicts to return
- `cwd` (string, optional) - Working directory

**Token Reduction:** 80% through structured status

---

### smart_status

Git status with status-only output and smart filtering.

**Parameters:**
- `cwd` (string, optional) - Repository directory
- `summaryOnly` (boolean, optional) - Return counts only (default: false)
- `staged` (boolean, optional) - Only staged files
- `unstaged` (boolean, optional) - Only unstaged files
- `statuses` (array, optional) - Filter by specific file statuses
- `filePattern` (string, optional) - Filter files by regex pattern
- `limit` (number, optional) - Maximum files to return
- `includeDetail` (boolean, optional) - Include diff output for specific files (default: false)
- `detailFiles` (array, optional) - Files to include diff for (requires includeDetail)

**Token Reduction:** 70% through status-only output

---

## API & Database Operations

### smart_api_fetch

HTTP requests with intelligent caching and retry logic.

**Parameters:**
- `method` (string, required) - HTTP method: "GET", "POST", "PUT", "DELETE", "PATCH"
- `url` (string, required) - Request URL
- `headers` (object, optional) - Request headers
- `body` (string/object, optional) - Request body for POST/PUT/PATCH
- `ttl` (number, optional) - Cache TTL in seconds (default: 300)
- `force` (boolean, optional) - Force fresh request, ignore cache (default: false)
- `timeout` (number, optional) - Request timeout in ms (default: 30000)
- `maxRetries` (number, optional) - Maximum retry attempts (default: 3)
- `followRedirects` (boolean, optional) - Follow HTTP redirects (default: true)
- `parseJson` (boolean, optional) - Parse response as JSON (default: true)

**Token Reduction:** 83% on cache hits, 95% on cached responses

**Example:**
```typescript
// First request: fetch and cache
smart_api_fetch({
  method: "GET",
  url: "https://api.example.com/data",
  ttl: 300
})

// Subsequent requests: cached (95% reduction)
smart_api_fetch({
  method: "GET",
  url: "https://api.example.com/data"
})
```

---

### smart_cache_api

API response caching with TTL, ETag, and event-based invalidation strategies.

**Parameters:**
- `action` (string, required) - "get", "set", "invalidate", "analyze", or "warm"
- `request` (object, optional) - API request data (for get/set)
  - `url` (string) - Request URL
  - `method` (string) - HTTP method
  - `headers` (object) - Request headers
  - `params` (object) - Query parameters
  - `body` (object) - Request body
- `response` (any, optional) - API response data (for set)
- `strategy` (string, optional) - "ttl", "etag", "event", "lru", "size-based", "hybrid"
- `ttl` (number, optional) - Time-to-live in seconds (default: 3600)
- `tags` (array, optional) - Tags for grouping cached entries
- `invalidationPattern` (string, optional) - "time", "pattern", "tag", "manual", "event"
- `pattern` (string, optional) - URL pattern for invalidation (e.g., "/api/users/*")
- `endpoints` (array, optional) - Endpoints to warm (for warm action)
- `normalizeQuery` (boolean, optional) - Normalize query parameters (default: true)
- `ignoreHeaders` (array, optional) - Headers to exclude from cache key
- `staleWhileRevalidate` (boolean, optional) - Enable stale-while-revalidate
- `staleTime` (number, optional) - Time before considering cache stale (seconds)
- `maxCacheSize` (number, optional) - Maximum cache size in bytes
- `maxEntries` (number, optional) - Maximum number of cache entries

**Token Reduction:** 83-95% depending on strategy

---

### smart_database

Database queries with connection pooling, circuit breaking, and intelligent caching.

**Parameters:**
- `query` (string, optional) - SQL query to execute (required for query/explain/analyze/optimize)
- `action` (string, optional) - "query", "explain", "analyze", "optimize", "health", "pool", "slow", "batch" (default: "query")
- `engine` (string, optional) - "postgresql", "mysql", "sqlite", "mongodb", "redis", "generic" (default: "generic")
- `params` (array, optional) - Query parameters for prepared statements
- `ttl` (number, optional) - Cache TTL in seconds (default: 300)
- `force` (boolean, optional) - Force fresh query, bypass cache (default: false)
- `limit` (number, optional) - Maximum rows to return (default: 10)
- `timeout` (number, optional) - Query timeout in ms (default: 30000)
- `enableCache` (boolean, optional) - Enable query result caching (default: true)
- `enableRetry` (boolean, optional) - Enable automatic retry on failure (default: true)
- `enableCircuitBreaker` (boolean, optional) - Enable circuit breaker pattern (default: true)
- `maxRetries` (number, optional) - Maximum retry attempts (default: 3)
- `poolSize` (number, optional) - Connection pool size (default: 10)
- `maxPoolSize` (number, optional) - Maximum pool size (default: 20)
- `slowQueryThreshold` (number, optional) - Slow query threshold in ms (default: 1000)
- `queries` (array, optional) - Array of queries for batch execution
- `batchSize` (number, optional) - Batch size for batch operations (default: 100)
- `parallelBatches` (number, optional) - Number of parallel batch operations (default: 4)

**Token Reduction:** 83% on cached results

---

### smart_sql

SQL query analysis with optimization suggestions and execution plan analysis.

**Parameters:**
- `query` (string, required) - SQL query to analyze
- `action` (string, optional) - "analyze", "explain", "validate", "optimize", "history" (default: "analyze")
- `database` (string, optional) - "postgresql", "mysql", "sqlite", "sqlserver"
- `schema` (string, optional) - Schema name
- `includeExecutionPlan` (boolean, optional) - Include execution plan analysis (default: false)
- `force` (boolean, optional) - Force fresh analysis, bypass cache (default: false)
- `ttl` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 83% through structured analysis

---

### smart_schema

Database schema analysis with intelligent caching and 83% token reduction.

**Parameters:**
- `connectionString` (string, required) - Database connection string
  - PostgreSQL: `postgresql://user:pass@host:port/db`
  - MySQL: `mysql://user:pass@host/db`
  - SQLite: `/path/to/database.sqlite`
- `mode` (string, optional) - "full", "summary", "analysis", "diff" (default: "full")
- `analyzeTables` (array, optional) - Specific tables to analyze (all if not specified)
- `forceRefresh` (boolean, optional) - Force refresh, bypass cache (default: false)
- `includeData` (boolean, optional) - Include row counts and table sizes (default: false)
- `detectUnusedIndexes` (boolean, optional) - Detect potentially unused indexes (default: false)
- `compareWith` (string, optional) - Second connection string for diff mode

**Token Reduction:** 83-95% depending on mode

---

### smart_graphql

GraphQL query optimization with complexity analysis and N+1 detection.

**Parameters:**
- `query` (string, required) - GraphQL query to analyze
- `operationName` (string, optional) - Operation name
- `variables` (object, optional) - Query variables
- `endpoint` (string, optional) - GraphQL endpoint for schema introspection
- `analyzeComplexity` (boolean, optional) - Enable complexity analysis (default: true)
- `detectN1` (boolean, optional) - Detect N+1 query problems (default: true)
- `suggestOptimizations` (boolean, optional) - Suggest query optimizations (default: true)
- `force` (boolean, optional) - Force fresh analysis, bypass cache
- `ttl` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 83% through structured analysis

---

### smart_rest

REST API analysis with endpoint discovery and health scoring.

**Parameters:**
- `specContent` (string, optional) - OpenAPI/Swagger spec content (JSON string)
- `specUrl` (string, optional) - OpenAPI/Swagger spec URL (not yet supported)
- `baseUrl` (string, optional) - Base API URL
- `methods` (array, optional) - Filter by HTTP methods: "GET", "POST", "PUT", "DELETE", "PATCH"
- `resourceFilter` (string, optional) - Filter by resource path (e.g., "users")
- `analyzeEndpoints` (boolean, optional) - Analyze all endpoints (default: true)
- `checkHealth` (boolean, optional) - Check API health and generate score (default: false)
- `detectPatterns` (boolean, optional) - Detect API patterns (auth, versioning, etc.) (default: false)
- `generateDocs` (boolean, optional) - Generate documentation (default: false)
- `force` (boolean, optional) - Force fresh analysis, bypass cache (default: false)
- `ttl` (number, optional) - Cache TTL in seconds (default: 3600)

**Token Reduction:** 83% through structured analysis

---

### smart_orm

ORM query optimization with N+1 detection and eager loading suggestions.

**Parameters:**
- `ormCode` (string, required) - ORM query code to analyze
- `ormType` (string, required) - "prisma", "sequelize", "typeorm", "mongoose", "generic"
- `modelDefinitions` (string, optional) - Schema/model definitions for enhanced analysis
- `detectN1` (boolean, optional) - Detect N+1 query problems (default: true)
- `suggestEagerLoading` (boolean, optional) - Suggest eager loading optimizations (default: true)
- `analyzeRelationships` (boolean, optional) - Analyze relationship patterns (default: false)
- `estimateQueries` (boolean, optional) - Estimate generated SQL queries (default: false)
- `force` (boolean, optional) - Force fresh analysis, bypass cache (default: false)
- `ttl` (number, optional) - Cache TTL in seconds (default: 3600)

**Token Reduction:** 83% through structured analysis

---

### smart_migration

Database migration tracking with status monitoring and 83% token reduction.

**Parameters:**
- `action` (string, optional) - "list", "status", "pending", "history", "rollback", "generate" (default: "list")
- `migrationId` (string, optional) - Migration ID (required for rollback and generate)
- `direction` (string, optional) - "up" or "down" for rollback (default: "down")
- `limit` (number, optional) - Maximum results (default: 20 for list/pending, 50 for history)
- `force` (boolean, optional) - Force fresh analysis, bypass cache (default: false)
- `ttl` (number, optional) - Cache TTL in seconds (default: 3600)

**Token Reduction:** 83% through structured output

---

### smart_websocket

WebSocket connection management with message tracking and 83% token reduction.

**Parameters:**
- `url` (string, required) - WebSocket URL (ws:// or wss://)
- `action` (string, required) - "connect", "disconnect", "send", "history", "analyze"
- `message` (any, optional) - Message to send (for send action)
- `protocols` (array, optional) - WebSocket sub-protocols
- `trackMessages` (boolean, optional) - Track message history (default: true)
- `maxHistory` (number, optional) - Maximum messages to keep (default: 100)
- `maxReconnectAttempts` (number, optional) - Maximum reconnection attempts (default: 5)
- `analyzeHealth` (boolean, optional) - Analyze connection health (default: true)
- `detectPatterns` (boolean, optional) - Detect message patterns (default: true)
- `force` (boolean, optional) - Force fresh analysis, bypass cache
- `ttl` (number, optional) - Cache TTL in seconds (default: 60)

**Token Reduction:** 83% through message tracking

---

## Build & Test Operations

### smart_build

TypeScript builds with intelligent caching and diff-based change detection.

**Parameters:**
- `projectRoot` (string, optional) - Project root directory
- `tsconfig` (string, optional) - TypeScript config file path
- `force` (boolean, optional) - Force full rebuild, ignore cache (default: false)
- `watch` (boolean, optional) - Watch mode for continuous builds (default: false)
- `includeWarnings` (boolean, optional) - Include warnings in output (default: true)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 3600)

**Token Reduction:** Variable based on changes (70-85% typical)

---

### smart_test

Test execution with intelligent caching and incremental test selection.

**Parameters:**
- `projectRoot` (string, optional) - Project root directory
- `pattern` (string, optional) - Pattern to match test files
- `onlyChanged` (boolean, optional) - Run only tests that changed (default: false)
- `coverage` (boolean, optional) - Collect coverage information (default: false)
- `watch` (boolean, optional) - Watch mode for continuous testing (default: false)
- `force` (boolean, optional) - Force full test run, ignore cache (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 300)

**Token Reduction:** Variable based on test count (60-80% typical)

---

### smart_lint

ESLint with intelligent caching, incremental analysis, and auto-fix suggestions.

**Parameters:**
- `files` (string/array, required) - Files or pattern to lint
- `projectRoot` (string, optional) - Project root directory
- `fix` (boolean, optional) - Auto-fix issues (default: false)
- `force` (boolean, optional) - Force full lint, ignore cache (default: false)
- `onlyNew` (boolean, optional) - Show only new issues since last run (default: false)
- `includeIgnored` (boolean, optional) - Include previously ignored issues (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 3600)

**Token Reduction:** 70-85% through incremental analysis

---

### smart_typecheck

TypeScript type checking with intelligent caching and categorized error reporting.

**Parameters:**
- `projectRoot` (string, optional) - Project root directory
- `tsconfig` (string, optional) - TypeScript config file path
- `watch` (boolean, optional) - Watch mode for continuous type checking (default: false)
- `force` (boolean, optional) - Force full type check, ignore cache (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 3600)

**Token Reduction:** 70-85% through caching

---

### smart_install

Package installation with dependency analysis, conflict detection, and smart caching.

**Parameters:**
- `packages` (array, optional) - Packages to install (if empty, installs all from package.json)
- `projectRoot` (string, optional) - Project root directory
- `dev` (boolean, optional) - Install as dev dependency (default: false)
- `packageManager` (string, optional) - "npm", "yarn", or "pnpm" (auto-detect if not specified)
- `force` (boolean, optional) - Force reinstall, ignore cache (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 3600)

**Token Reduction:** Variable based on dependency tree

---

### smart_docker

Docker operations with build/run/stop/logs support, image layer analysis, and optimization suggestions.

**Parameters:**
- `operation` (string, required) - "build", "run", "stop", "logs", "ps"
- `projectRoot` (string, optional) - Project root directory
- `imageName` (string, optional) - Image name for build/run
- `containerName` (string, optional) - Container name for run/stop/logs
- `dockerfile` (string, optional) - Dockerfile path
- `context` (string, optional) - Build context directory
- `ports` (array, optional) - Port mappings for run (e.g., ['8080:80', '443:443'])
- `env` (object, optional) - Environment variables for run
- `follow` (boolean, optional) - Follow logs (tail mode) (default: false)
- `tail` (number, optional) - Number of log lines to show
- `force` (boolean, optional) - Force operation, ignore cache (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 3600)

**Token Reduction:** Variable based on operation

---

### smart_logs

System log aggregation and analysis with multi-source support, pattern filtering, error detection, and insights.

**Parameters:**
- `sources` (array, optional) - Log sources to aggregate (file paths or system logs)
- `projectRoot` (string, optional) - Project root directory
- `level` (string, optional) - Filter by log level: "error", "warn", "info", "debug", "all" (default: "all")
- `pattern` (string, optional) - Filter by pattern (regex)
- `since` (string, optional) - Time range filter (e.g., '1h', '24h', '7d')
- `tail` (number, optional) - Number of lines to tail (default: 100)
- `follow` (boolean, optional) - Follow mode (watch for new entries) (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 300)

**Token Reduction:** 70-85% through filtering and aggregation

---

### smart_network

Network diagnostics and monitoring with connectivity testing, port scanning, DNS resolution, and anomaly detection.

**Parameters:**
- `operation` (string, required) - "ping", "port-scan", "dns", "traceroute", "all"
- `hosts` (array, optional) - Hosts to test (for ping/port-scan operations)
- `ports` (array, optional) - Ports to scan (for port-scan operation)
- `hostnames` (array, optional) - Hostnames for DNS resolution
- `pingCount` (number, optional) - Number of ping attempts per host (default: 4)
- `timeout` (number, optional) - Timeout in milliseconds (default: 5000)
- `projectRoot` (string, optional) - Project root directory
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 300)

**Token Reduction:** Variable based on operation results

---

### smart_processes

Monitor and analyze system processes with anomaly detection and resource tracking.

**Parameters:**
- `projectRoot` (string, optional) - Project root directory
- `filter` (string, optional) - Filter processes by name pattern
- `cpuThreshold` (number, optional) - Show only high CPU usage processes (> threshold %)
- `memoryThreshold` (number, optional) - Show only high memory usage processes (> threshold MB)
- `limit` (number, optional) - Maximum number of processes to show (default: 20)
- `includeSystem` (boolean, optional) - Include system processes (default: false)
- `compareWithPrevious` (boolean, optional) - Compare with previous snapshot (default: true)

**Token Reduction:** Variable based on process count

---

### smart_system_metrics

System resource monitoring with CPU, memory, disk usage tracking, anomaly detection, and performance recommendations.

**Parameters:**
- `projectRoot` (string, optional) - Project root directory
- `includeDisk` (boolean, optional) - Include disk metrics (default: true)
- `diskPaths` (array, optional) - Disk paths to monitor (default: root partition)
- `detectAnomalies` (boolean, optional) - Detect anomalies by comparing with previous snapshot (default: true)
- `force` (boolean, optional) - Force operation, ignore cache (default: false)
- `maxCacheAge` (number, optional) - Maximum cache age in seconds (default: 60)

**Token Reduction:** Variable based on metrics

---

## Advanced Caching

### smart_cache

Advanced multi-tier cache (L1/L2/L3) with 6 eviction strategies, stampede prevention, and automatic tier management.

**Parameters:**
- `operation` (string, required) - "get", "set", "delete", "clear", "stats", "configure", "promote", "demote", "batch-get", "batch-set", "export", "import"
- `key` (string, optional) - Cache key (for get/set/delete/promote/demote operations)
- `value` (string, optional) - Value to store (for set operation)
- `ttl` (number, optional) - Time-to-live in milliseconds
- `tier` (string, optional) - Cache tier: "L1", "L2", "L3" (for set operation, default: "L1")
- `targetTier` (string, optional) - Target tier: "L1", "L2", "L3" (for promote/demote operations)
- `keys` (array, optional) - Array of keys (for batch-get operation)
- `values` (array, optional) - Array of key-value pairs (for batch-set operation)
- `evictionStrategy` (string, optional) - "LRU", "LFU", "FIFO", "TTL", "SIZE", "HYBRID" (for configure operation)
- `l1MaxSize` (number, optional) - Maximum L1 cache size (for configure operation)
- `l2MaxSize` (number, optional) - Maximum L2 cache size (for configure operation)
- `defaultTTL` (number, optional) - Default TTL in milliseconds (for configure operation)
- `writeMode` (string, optional) - "write-through", "write-back" (for configure operation)
- `exportDelta` (boolean, optional) - Export only changes since last snapshot (for export operation)
- `importData` (string, optional) - JSON data to import (for import operation)
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 90% through intelligent tier management

---

### cache_warmup

Intelligent cache pre-warming with 87%+ token reduction, schedule-based warming, pattern analysis, dependency resolution, and progressive warming strategies.

**Parameters:**
- `operation` (string, required) - "schedule", "immediate", "pattern-based", "dependency-based", "selective", "status", "cancel", "pause", "resume", "configure"
- `schedule` (string, optional) - Cron expression for scheduled warmup (e.g., '0 * * * *')
- `keys` (array, optional) - Keys to warm (for immediate/selective operations)
- `pattern` (string, optional) - Regex pattern for key matching
- `accessHistory` (array, optional) - Access history for pattern-based warmup
- `dependencies` (object, optional) - Dependency graph for dependency-based warmup
- `strategy` (string, optional) - "immediate", "progressive", "dependency", "pattern" (default: "progressive")
- `batchSize` (number, optional) - Batch size for warmup (default: 50)
- `delayBetweenBatches` (number, optional) - Delay between batches in ms
- `maxConcurrency` (number, optional) - Max concurrent warmup operations (default: 10)
- `warmupPercentage` (number, optional) - Percentage of cache to warm (default: 80)
- `hotKeyThreshold` (number, optional) - Minimum access count for hot keys
- `minAccessCount` (number, optional) - Minimum access count for hot keys (default: 5)
- `timeWindow` (number, optional) - Time window for pattern analysis in ms (default: 3600000)
- `scheduleId` (string, optional) - Schedule ID for cancel operation
- `categories` (array, optional) - Categories to warm (for selective operation)
- `priority` (string, optional) - "high", "normal", "low" (default: "normal")
- `dryRun` (boolean, optional) - Simulate warmup without executing (default: false)
- `reportProgress` (boolean, optional) - Enable progress reporting (default: true)
- `progressInterval` (number, optional) - Progress report interval in ms
- `timeout` (number, optional) - Timeout for warmup operations in ms (default: 30000)
- `maxRetries` (number, optional) - Maximum retry attempts (default: 3)
- `retryDelay` (number, optional) - Delay between retries in ms
- `enableRollback` (boolean, optional) - Enable rollback on failures (default: true)
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 87% through schedule-based warming

---

### cache_analytics

Comprehensive cache analytics with 88%+ token reduction. Real-time dashboards, trend analysis, alerting, heatmaps, bottleneck detection, and cost optimization.

**Parameters:**
- `operation` (string, required) - "dashboard", "metrics", "trends", "alerts", "heatmap", "bottlenecks", "cost-analysis", "export-data"
- `metricTypes` (array, optional) - Types of metrics: "performance", "usage", "efficiency", "cost", "health"
- `timeRange` (object, optional) - Time range for analysis
  - `start` (number) - Start timestamp in milliseconds
  - `end` (number) - End timestamp in milliseconds
- `granularity` (string, optional) - "second", "minute", "hour", "day"
- `aggregation` (string, optional) - "sum", "avg", "min", "max", "p95", "p99"
- `trendType` (string, optional) - "absolute", "percentage", "rate"
- `compareWith` (string, optional) - "previous-period", "last-week", "last-month"
- `alertType` (string, optional) - "threshold", "anomaly", "trend"
- `threshold` (number, optional) - Threshold value for alerts
- `heatmapType` (string, optional) - "temporal", "key-correlation", "memory"
- `resolution` (string, optional) - "low", "medium", "high"
- `format` (string, optional) - "json", "csv", "prometheus"
- `outputPath` (string, optional) - Path for exported file
- `useCache` (boolean, optional) - Enable caching of analytics results (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds

**Token Reduction:** 88% through intelligent caching

---

### cache_benchmark

Cache performance benchmarking with 89% token reduction through comprehensive testing and analysis.

**Parameters:**
- `operation` (string, required) - "run-benchmark", "compare", "load-test", "latency-test", "throughput-test", "report"
- `config` (object, optional) - Cache configuration for single benchmark
  - `name` (string) - Configuration name
  - `strategy` (string) - "LRU", "LFU", "FIFO", "TTL", "size", "hybrid"
  - `maxEntries` (number) - Maximum cache entries
  - `maxSize` (number) - Maximum cache size
  - `ttl` (number) - Time-to-live
- `configs` (array, optional) - Multiple cache configurations for comparison
- `workloadType` (string, optional) - "read-heavy", "write-heavy", "mixed", "custom", "realistic"
- `workloadRatio` (object, optional) - Custom read/write ratio
  - `read` (number) - Read percentage
  - `write` (number) - Write percentage
- `duration` (number, optional) - Benchmark duration in seconds (default: 60)
- `warmupDuration` (number, optional) - Warmup duration in seconds (default: 10)
- `concurrency` (number, optional) - Number of concurrent workers (default: 10)
- `maxConcurrency` (number, optional) - Maximum concurrency for load test (default: 100)
- `stepSize` (number, optional) - Concurrency step size for load test (default: 10)
- `rampUp` (number, optional) - Ramp-up time in seconds (for load-test)
- `targetTPS` (number, optional) - Target transactions per second
- `percentiles` (array, optional) - Percentiles to measure (default: [50, 90, 95, 99])
- `benchmarkId` (string, optional) - ID of benchmark results (for report operation)
- `format` (string, optional) - Report format: "markdown", "html", "json", "pdf" (default: "markdown")
- `outputPath` (string, optional) - Path to save report
- `includeCharts` (boolean, optional) - Include charts in report
- `useCache` (boolean, optional) - Cache benchmark results (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds

**Token Reduction:** 89% through result caching

---

### cache_compression

Advanced compression strategies with 89%+ token reduction. Supports 6 algorithms (gzip, brotli, lz4, zstd, snappy, custom), adaptive selection, dictionary-based compression, and delta compression.

**Parameters:**
- `operation` (string, required) - "compress", "decompress", "analyze", "optimize", "benchmark", "configure"
- `data` (any, required for compress/decompress/analyze) - Data to process
- `algorithm` (string, optional) - "gzip", "brotli", "lz4", "zstd", "snappy", "custom"
- `level` (number, optional) - Compression level 0-9 (default: varies by algorithm)
- `dataType` (string, optional) - "json", "text", "binary", "time-series", "structured", "auto"
- `autoSelect` (boolean, optional) - Enable auto-selection of algorithm
- `enableDelta` (boolean, optional) - Enable delta compression for time-series data
- `algorithms` (array, optional) - Algorithms to benchmark
- `iterations` (number, optional) - Number of benchmark iterations
- `targetRatio` (number, optional) - Target compression ratio 0-1 (for optimize operation)
- `maxLatency` (number, optional) - Maximum acceptable latency in milliseconds
- `workloadType` (string, optional) - "read-heavy", "write-heavy", "balanced"
- `defaultAlgorithm` (string, optional) - Default algorithm (for configure operation)
- `useCache` (boolean, optional) - Enable caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 3600)

**Token Reduction:** 89% through adaptive compression

---

### cache_invalidation

Comprehensive cache invalidation with 88%+ token reduction, dependency tracking, pattern matching, scheduled invalidation, and distributed coordination.

**Parameters:**
- `operation` (string, required) - "invalidate", "invalidate-pattern", "invalidate-tag", "invalidate-dependency", "schedule-invalidation", "cancel-scheduled", "audit-log", "set-dependency", "remove-dependency", "validate", "configure", "stats", "clear-audit"
- `key` (string, optional) - Cache key to invalidate
- `keys` (array, optional) - Array of cache keys to invalidate
- `pattern` (string, optional) - Pattern for matching keys (wildcards: * for any chars, ? for single char)
- `tag` (string, optional) - Tag to invalidate all associated keys
- `tags` (array, optional) - Array of tags to invalidate
- `parentKey` (string, optional) - Parent key for dependency relationship
- `childKey` (string, optional) - Child key for dependency relationship
- `childKeys` (array, optional) - Array of child keys for dependency relationship
- `cascadeDepth` (number, optional) - Maximum depth for dependency cascade (default: 10)
- `mode` (string, optional) - "eager", "lazy", "scheduled"
- `strategy` (string, optional) - "immediate", "lazy", "write-through", "ttl-based", "event-driven", "dependency-cascade"
- `cronExpression` (string, optional) - Cron expression for scheduled invalidation
- `executeAt` (number, optional) - Timestamp when to execute invalidation
- `repeatInterval` (number, optional) - Interval in ms for repeating scheduled invalidation
- `scheduleId` (string, optional) - ID of scheduled invalidation
- `revalidateOnInvalidate` (boolean, optional) - Trigger revalidation after invalidation
- `enableAudit` (boolean, optional) - Enable audit logging (default: true)
- `maxAuditEntries` (number, optional) - Maximum audit log entries (default: 10000)
- `skipExpired` (boolean, optional) - Skip expired entries during validation (default: true)
- `broadcastToNodes` (boolean, optional) - Broadcast invalidation to distributed nodes
- `nodeId` (string, optional) - Node ID for distributed coordination
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 88% through dependency tracking

---

### cache_optimizer

Advanced cache optimization with 89%+ token reduction. Analyzes performance, benchmarks strategies, provides ML-based recommendations, detects bottlenecks, and performs cost-benefit analysis.

**Parameters:**
- `operation` (string, required) - "analyze", "benchmark", "optimize", "recommend", "simulate", "tune", "detect-bottlenecks", "cost-benefit", "configure", "report"
- `workloadPattern` (string, optional) - "uniform", "skewed", "temporal", "burst", "predictable", "unknown"
- `objective` (string, optional) - "hit-rate", "latency", "memory", "throughput", "balanced" (default: "balanced")
- `strategies` (array, optional) - Eviction strategies to benchmark: "LRU", "LFU", "FIFO", "TTL", "SIZE", "HYBRID"
- `tuningMethod` (string, optional) - "grid-search", "gradient-descent", "bayesian", "evolutionary" (default: "bayesian")
- `epochs` (number, optional) - Number of training epochs for tuning (default: 50)
- `analysisWindow` (number, optional) - Time window in ms for analysis (default: 3600000)
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 89% through ML-based optimization

---

### cache_partition

Advanced cache partitioning and sharding with 87%+ token reduction through consistent hashing, automatic rebalancing, and partition isolation.

**Parameters:**
- `operation` (string, required) - "create-partition", "delete-partition", "list-partitions", "migrate", "rebalance", "configure-sharding", "stats"
- `partitionId` (string, optional) - Partition identifier (required for create/delete)
- `strategy` (string, optional) - "hash", "range", "category", "geographic", "custom" (default: "hash")
- `partitionFunction` (string, optional) - Custom partition function (JavaScript code)
- `shardingStrategy` (string, optional) - "consistent-hash", "range", "custom"
- `virtualNodes` (number, optional) - Number of virtual nodes per partition (default: 150)
- `sourcePartition` (string, optional) - Source partition for migration
- `targetPartition` (string, optional) - Target partition for migration
- `keyPattern` (string, optional) - Regex pattern for keys to migrate
- `maxMigrations` (number, optional) - Maximum migrations during rebalance (default: 1000)
- `targetDistribution` (string, optional) - "even", "weighted", "capacity-based" (default: "even")
- `includeKeyDistribution` (boolean, optional) - Include key distribution in stats (default: true)
- `includeMemoryUsage` (boolean, optional) - Include memory usage in stats (default: true)
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 87% through partition isolation

---

### cache_replication

Distributed cache replication with 88%+ token reduction. Supports primary-replica and multi-primary modes, strong/eventual consistency, automatic conflict resolution, failover, incremental sync, and health monitoring.

**Parameters:**
- `operation` (string, required) - "configure", "add-replica", "remove-replica", "promote-replica", "sync", "status", "health-check", "resolve-conflicts", "snapshot", "restore", "rebalance"
- `mode` (string, optional) - "primary-replica", "multi-primary", "master-slave", "peer-to-peer" (for configure)
- `consistency` (string, optional) - "eventual", "strong", "causal" (for configure)
- `syncInterval` (number, optional) - Sync interval in milliseconds (for configure)
- `heartbeatInterval` (number, optional) - Heartbeat interval in milliseconds (for configure)
- `readQuorum` (number, optional) - Number of replicas required for reads (for configure)
- `writeQuorum` (number, optional) - Number of replicas required for writes (for configure)
- `conflictResolution` (string, optional) - "last-write-wins", "first-write-wins", "merge", "custom", "vector-clock" (for configure)
- `nodeId` (string, optional) - Node ID (for add-replica/remove-replica)
- `endpoint` (string, optional) - Node endpoint URL (for add-replica)
- `region` (string, optional) - Region name (for add-replica)
- `weight` (number, optional) - Node weight for load balancing (for add-replica)
- `targetNodeId` (string, optional) - Target node ID (for promote-replica)
- `force` (boolean, optional) - Force sync even if up-to-date (for sync)
- `deltaOnly` (boolean, optional) - Sync only delta changes (for sync)
- `snapshotId` (string, optional) - Snapshot ID (for restore)
- `includeMetadata` (boolean, optional) - Include snapshot data in response (for snapshot)
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 88% through incremental sync

---

### predictive_cache

ML-based predictive caching with 91%+ token reduction using ARIMA, exponential smoothing, LSTM, and collaborative filtering.

**Parameters:**
- `operation` (string, required) - "train", "predict", "auto-warm", "evaluate", "retrain", "export-model", "import-model", "record-access", "get-patterns"
- `modelType` (string, optional) - "arima", "exponential", "lstm", "hybrid" (default: "hybrid")
- `trainData` (array, optional) - Training data (for train operation)
  - Each item: `{ key: string, timestamp: number, hitCount: number }`
- `horizon` (number, optional) - Prediction horizon in seconds (default: 60)
- `confidence` (number, optional) - Minimum confidence threshold (default: 0.7)
- `maxPredictions` (number, optional) - Maximum predictions to return (default: 100)
- `learningRate` (number, optional) - Learning rate for training (default: 0.01)
- `epochs` (number, optional) - Number of training epochs (default: 10)
- `warmStrategy` (string, optional) - "aggressive", "conservative", "adaptive" (default: "adaptive")
- `warmBatchSize` (number, optional) - Number of keys to warm (default: 50)
- `modelPath` (string, optional) - Path to model file (for export/import)
- `modelFormat` (string, optional) - "json", "binary" (default: "json")
- `compress` (boolean, optional) - Compress model export (default: true)
- `key` (string, optional) - Cache key (for record-access and get-patterns)
- `timestamp` (number, optional) - Access timestamp (for record-access)
- `useCache` (boolean, optional) - Enable result caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds (default: 300)

**Token Reduction:** 91% through predictive warming

---

## Monitoring & Dashboards

### alert_manager

Comprehensive alerting system with multi-channel notifications (email, Slack, webhook), intelligent routing, and 89% token reduction.

**Parameters:**
- `operation` (string, required) - "create-alert", "update-alert", "delete-alert", "list-alerts", "trigger", "get-history", "configure-channels", "silence"
- `alertName` (string, optional) - Alert name (required for create, optional for others)
- `alertId` (string, optional) - Alert identifier (required for update, delete, trigger, silence)
- `condition` (object, optional) - Alert condition configuration (required for create)
  - `metric` (string) - Metric to monitor
  - `aggregation` (string) - "avg", "sum", "min", "max", "count", "percentile"
  - `percentile` (number) - Percentile value if aggregation is "percentile"
  - `filters` (array) - Filter conditions
  - `groupBy` (array) - Group by fields
- `threshold` (object, optional) - Threshold configuration (required for create)
  - `type` (string) - "above", "below", "equals", "not-equals", "change", "anomaly"
  - `value` (number) - Threshold value
  - `timeWindow` (number) - Time window in seconds
  - `changePercent` (number) - Change percentage for "change" type
- `channels` (array, optional) - Notification channels: "email", "slack", "webhook", "sms", "pagerduty", "custom"
- `channelConfig` (object, optional) - Notification channel configuration
  - `email` - Email configuration
    - `to` (array) - Recipient email addresses
    - `subject` (string) - Email subject
    - `template` (string) - Email template
  - `slack` - Slack configuration
    - `webhook` (string) - Slack webhook URL
    - `channel` (string) - Slack channel
    - `mentionUsers` (array) - Users to mention
  - `webhook` - Webhook configuration
    - `url` (string) - Webhook URL
    - `method` (string) - HTTP method
    - `headers` (object) - HTTP headers
- `severity` (string, optional) - "info", "warning", "error", "critical"
- `timeRange` (object, optional) - Time range filter for history
  - `start` (number) - Start timestamp
  - `end` (number) - End timestamp
- `limit` (number, optional) - Maximum number of history events
- `silenceDuration` (number, optional) - Silence duration in seconds (required for silence)
- `silenceReason` (string, optional) - Reason for silencing
- `useCache` (boolean, optional) - Enable caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds

**Token Reduction:** 89% through intelligent caching

---

### metric_collector

Comprehensive metrics collection and aggregation with multi-source support, time-series compression, and 88% token reduction.

**Parameters:**
- `operation` (string, required) - "collect", "query", "aggregate", "export", "list-sources", "configure-source", "get-stats", "purge"
- `sourceId` (string, optional) - Source identifier
- `sourceName` (string, optional) - Source name
- `metrics` (array, optional) - Specific metrics to collect
- `tags` (object, optional) - Tag filters
- `query` (object, optional) - Query configuration
  - `metric` (string) - Metric name
  - `tags` (object) - Tag filters
  - `timeRange` (object) - Time range
    - `start` (number) - Start timestamp
    - `end` (number) - End timestamp
  - `downsample` (number) - Downsample interval
  - `limit` (number) - Maximum data points
- `aggregation` (object, optional) - Aggregation configuration
  - `function` (string) - "avg", "sum", "min", "max", "count", "rate", "percentile"
  - `window` (number) - Time window for aggregation
  - `groupBy` (array) - Group by tags
  - `percentile` (number) - Percentile value
- `format` (string, optional) - Export format: "json", "csv", "prometheus", "influxdb", "graphite"
- `destination` (string, optional) - Export destination (URL or file path)
- `compress` (boolean, optional) - Compress exported data
- `source` (object, optional) - Source configuration (for configure-source)
- `retentionPeriod` (number, optional) - Data retention period in seconds
- `useCache` (boolean, optional) - Enable caching (default: true)

**Token Reduction:** 88% through delta encoding

---

### monitoring_integration

External monitoring platform integration with 87% token reduction through data compression and intelligent caching.

**Parameters:**
- `operation` (string, required) - "connect", "disconnect", "list-connections", "sync-metrics", "sync-alerts", "push-data", "get-status", "configure-mapping"
- `connectionId` (string, optional) - Connection identifier
- `connectionName` (string, optional) - Connection name
- `connection` (object, optional) - Connection configuration
  - `platform` (string) - "prometheus", "grafana", "datadog", "newrelic", "splunk", "elastic"
  - `url` (string) - Platform URL
  - `apiKey` (string) - API key for authentication
- `useCache` (boolean, optional) - Enable caching (default: true)

**Token Reduction:** 87% through compression

---

### custom_widget

Create and manage custom dashboard widgets with 88% token reduction through template caching and configuration compression.

**Parameters:**
- `operation` (string, required) - "create", "update", "delete", "list", "render", "create-template", "validate", "get-schema"
- `widgetId` (string, optional) - Widget ID (required for update, delete, render)
- `widgetName` (string, optional) - Widget name (required for create)
- `type` (string, optional) - Widget type: "chart", "metric", "table", "gauge", "status", "timeline", "heatmap", "custom"
- `config` (object, optional) - Widget configuration
- `dataSource` (object, optional) - Data source configuration
- `renderFormat` (string, optional) - "html", "json", "react" (default: "html")
- `includeData` (boolean, optional) - Include data source in render output (default: false)
- `templateName` (string, optional) - Template name (for create-template)
- `templateDescription` (string, optional) - Template description (for create-template)
- `templateConfig` (object, optional) - Template configuration (for create-template)
- `useCache` (boolean, optional) - Enable caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds

**Token Reduction:** 88% through template caching

---

### data_visualizer

Create and manage interactive data visualizations with 92% token reduction through SVG/Canvas optimization and configuration caching.

**Parameters:**
- `operation` (string, required) - "create-chart", "update-chart", "delete-chart", "list-charts", "render", "export", "create-heatmap", "create-timeline", "create-network", "create-sankey", "create-animation"
- `chartId` (string, optional) - Chart ID (required for update, delete, render)
- `chartType` (string, optional) - "line", "bar", "pie", "scatter", "area", "radar", "bubble"
- `data` (object, optional) - Chart data with labels and datasets
- `chartConfig` (object, optional) - Chart configuration
- `renderFormat` (string, optional) - "svg", "canvas", "html", "json" (default: "svg")
- `exportFormat` (string, optional) - "svg", "png", "pdf", "json" (default: "svg")
- `exportWidth` (number, optional) - Export width in pixels
- `exportHeight` (number, optional) - Export height in pixels
- `heatmapConfig` (object, optional) - Heatmap configuration
- `timelineConfig` (object, optional) - Timeline configuration
- `networkConfig` (object, optional) - Network graph configuration
- `sankeyConfig` (object, optional) - Sankey diagram configuration
- `animationConfig` (object, optional) - Animation configuration
- `useCache` (boolean, optional) - Enable caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds

**Token Reduction:** 92% through SVG optimization

---

### health_monitor

Monitor system and application health with 91% token reduction through health state compression and metric aggregation.

**Parameters:**
- `operation` (string, required) - "register-endpoint", "unregister-endpoint", "check-health", "list-endpoints", "get-history", "set-threshold", "get-summary", "run-diagnostic"
- `endpointId` (string, optional) - Endpoint ID
- `endpointName` (string, optional) - Endpoint name
- `endpointType` (string, optional) - "http", "tcp", "database", "service", "custom"
- `config` (object, optional) - Endpoint configuration
- `interval` (number, optional) - Check interval in seconds
- `thresholds` (object, optional) - Health thresholds
- `timeRange` (object, optional) - Time range for history
- `diagnosticType` (string, optional) - "network", "disk", "memory", "cpu", "process"
- `useCache` (boolean, optional) - Enable caching (default: true)
- `cacheTTL` (number, optional) - Cache TTL in seconds

**Token Reduction:** 91% through state compression

---

### log_dashboard

Interactive log analysis dashboard with filtering, searching, pattern detection, and 90% token reduction.

**Parameters:**
- `operation` (string, required) - "create", "update", "query", "aggregate", "detect-anomalies", "create-filter", "export", "tail"
- `dashboardId` (string, optional) - Dashboard identifier
- `dashboardName` (string, optional) - Dashboard name (required for create)
- `logFiles` (array, optional) - Paths to log files to analyze
- `query` (object, optional) - Log query configuration
  - `level` (string/array) - Filter by log level(s)
  - `pattern` (string) - Search pattern
  - `timeRange` (object) - Time range filter
    - `start` (number) - Start timestamp
    - `end` (number) - End timestamp
  - `limit` (number) - Maximum entries
  - `offset` (number) - Skip first N entries
- `aggregation` (object, optional) - Aggregation configuration
  - `groupBy` (array) - Group by fields
  - `metrics` (array) - Metrics to aggregate
  - `timeWindow` (number) - Time window for aggregation
- `anomaly` (object, optional) - Anomaly detection configuration
  - `method` (string) - Detection method
  - `sensitivity` (number) - Sensitivity level
  - `baselinePeriod` (number) - Baseline period
- `filterName` (string, optional) - Name for saved filter
- `format` (string, optional) - Export format: "json", "csv", "txt"
- `outputPath` (string, optional) - Path for exported file
- `lines` (number, optional) - Number of lines to tail
- `follow` (boolean, optional) - Follow mode for tail operation
- `useCache` (boolean, optional) - Enable caching (default: true)

**Token Reduction:** 90% through intelligent caching

---

## System Operations

### smart_cron

Intelligent scheduled task management with smart caching (85%+ token reduction). Manage cron jobs (Linux/macOS) and Windows Task Scheduler with validation, history tracking, and next run predictions.

**Parameters:**
- `operation` (string, required) - "list", "add", "remove", "enable", "disable", "history", "predict-next", "validate"
- `taskName` (string, optional) - Name of the scheduled task
- `schedule` (string, optional) - Cron expression (e.g., "0 2 * * *") or Windows schedule
- `command` (string, optional) - Command to execute
- `description` (string, optional) - Task description
- `enabled` (boolean, optional) - Whether the task is enabled
- `user` (string, optional) - User to run the task as
- `workingDirectory` (string, optional) - Working directory for the command
- `schedulerType` (string, optional) - "cron", "windows-task", "auto" (auto-detected if not specified)
- `historyLimit` (number, optional) - Number of history entries to retrieve (default: 50)
- `predictCount` (number, optional) - Number of future runs to predict (default: 5)
- `useCache` (boolean, optional) - Use cached results (default: true)
- `ttl` (number, optional) - Cache TTL in seconds (default: varies by operation)

**Token Reduction:** 85% through smart caching

**Example:**
```typescript
// List all scheduled tasks
smart_cron({ operation: "list" })

// Add a new cron job
smart_cron({
  operation: "add",
  taskName: "daily-backup",
  schedule: "0 2 * * *",  // Daily at 2am
  command: "/path/to/backup.sh",
  description: "Daily backup job"
})

// Predict next 5 runs
smart_cron({
  operation: "predict-next",
  taskName: "daily-backup",
  predictCount: 5
})
```

---

### smart_user

Intelligent user and permission management with smart caching (86%+ token reduction). Manage users, groups, permissions, ACLs, and perform security audits across Windows, Linux, and macOS.

**Parameters:**
- `operation` (string, required) - "list-users", "list-groups", "check-permissions", "audit-security", "get-acl", "get-user-info", "get-group-info", "check-sudo"
- `username` (string, optional) - Username for user-specific operations
- `groupname` (string, optional) - Group name for group-specific operations
- `path` (string, optional) - File/directory path for permission checks and ACL operations
- `includeSystemUsers` (boolean, optional) - Include system users in listings (default: false)
- `includeSystemGroups` (boolean, optional) - Include system groups in listings (default: false)
- `useCache` (boolean, optional) - Use cached results (default: true)
- `ttl` (number, optional) - Cache TTL in seconds (default: varies by operation)

**Token Reduction:** 86% through smart caching

**Example:**
```typescript
// List all users (excluding system users)
smart_user({ operation: "list-users" })

// Get detailed user information
smart_user({
  operation: "get-user-info",
  username: "alice"
})

// Check file permissions
smart_user({
  operation: "check-permissions",
  path: "/etc/config.json"
})

// Perform security audit
smart_user({ operation: "audit-security" })
```

---

### smart_ast_grep

Structural code search with 83% token reduction through AST indexing and caching.

**Parameters:**
- `pattern` (string, required) - AST pattern to search for (e.g., "function $NAME($ARGS) { $BODY }")
- `projectPath` (string, required) - Root directory of the project
- `language` (string, optional) - Programming language: "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp" (auto-detected if not provided)
- `filePattern` (string, optional) - Specific directory or file pattern (e.g., "src/**/*.ts")
- `excludePatterns` (array, optional) - Patterns to exclude from search
- `contextLines` (number, optional) - Number of context lines around matches (default: 3)
- `maxMatches` (number, optional) - Maximum number of matches to return (default: 100)
- `enableCache` (boolean, optional) - Enable AST index and pattern caching (default: true)

**Token Reduction:** 83% through AST indexing

**Example:**
```typescript
// Find all function definitions
smart_ast_grep({
  pattern: "function $NAME($ARGS) { $BODY }",
  projectPath: "/path/to/project",
  language: "ts",
  filePattern: "src/**/*.ts"
})

// Find all class definitions with specific methods
smart_ast_grep({
  pattern: "class $CLASS { $METHODS }",
  projectPath: "/path/to/project",
  contextLines: 5
})
```

---

### get_session_stats

Get comprehensive session-level token usage statistics.

**Parameters:**
- `sessionId` (string, optional) - Optional session ID to query (uses current session if not provided)

**Returns:**
- Session-level breakdown of token usage by tool
- Operation counts and types
- Token savings and reduction percentages
- Cache hit rates
- Cost estimation

**Example:**
```typescript
// Get stats for current session
get_session_stats({})

// Get stats for specific session
get_session_stats({ sessionId: "session-123" })
```

---

### analyze_project_tokens

Analyze token usage and estimate costs across multiple sessions within a project. Aggregates data from all operations files, provides project-level statistics, identifies top contributing sessions and tools.

**Parameters:**
- `projectPath` (string, optional) - Path to project directory (uses hooks data directory if not provided)
- `startDate` (string, optional) - Optional start date filter (YYYY-MM-DD format)
- `endDate` (string, optional) - Optional end date filter (YYYY-MM-DD format)
- `costPerMillionTokens` (number, optional) - Cost per million tokens in USD (default: 30)

**Returns:**
- Project-wide token usage statistics
- Cost estimation
- Top contributing sessions
- Top contributing tools
- Optimization opportunities

**Example:**
```typescript
// Analyze entire project
analyze_project_tokens({
  projectPath: "/path/to/project"
})

// Analyze specific date range
analyze_project_tokens({
  projectPath: "/path/to/project",
  startDate: "2024-01-01",
  endDate: "2024-01-31",
  costPerMillionTokens: 25
})
```

---

### optimize_session

Compress large file operations from the current session to reduce future token usage. Analyzes operations in the current session, identifies large text blocks from file-based tools, compresses them, and stores them in cache.

**Parameters:**
- `sessionId` (string, optional) - Optional session ID to optimize (uses current session if not provided)
- `min_token_threshold` (number, optional) - Minimum token count for a file operation to be considered for compression (default: 30)

**Returns:**
- Number of operations optimized
- Total token savings
- Compression statistics
- List of compressed operations

**Example:**
```typescript
// Optimize current session
optimize_session({})

// Optimize with custom threshold
optimize_session({
  min_token_threshold: 50
})

// Optimize specific session
optimize_session({
  sessionId: "session-123",
  min_token_threshold: 100
})
```

---

## Usage Best Practices

### When to Use Each Tool Category

**Core Caching & Optimization**
- Use `optimize_text` for large content that will be referenced multiple times
- Use `analyze_optimization` before caching to determine if compression is worthwhile
- Use `get_cache_stats` to monitor cache performance

**Smart File Operations**
- Use `smart_read` instead of Read for all file operations (automatic 80% reduction)
- Use `smart_edit` for line-based changes (90% reduction through diff-only output)
- Use `smart_grep` when searching codebase (80% reduction through match-only output)

**API & Database**
- Use `smart_api_fetch` for all HTTP requests (95% reduction on cache hits)
- Use `smart_database` for database queries (83% reduction on cached results)
- Use `smart_cache_api` for API response caching with advanced strategies

**Build & Test**
- Use `smart_test` to run only changed tests (incremental test selection)
- Use `smart_lint` for incremental linting with auto-fix suggestions
- Use `smart_build` for TypeScript builds with diff-based change detection

**Advanced Caching**
- Use `smart_cache` for multi-tier caching with custom eviction strategies
- Use `predictive_cache` for ML-based cache warming
- Use `cache_analytics` to monitor cache performance and identify optimization opportunities

**Monitoring & Dashboards**
- Use `alert_manager` to set up alerting for critical metrics
- Use `metric_collector` to aggregate metrics from multiple sources
- Use `data_visualizer` to create interactive charts and visualizations

**System Operations**
- Use `smart_cron` to manage scheduled tasks
- Use `smart_user` for user and permission management
- Use `get_session_stats` and `analyze_project_tokens` to monitor token usage

### Performance Tips

1. **Enable Caching**: Most tools default to caching enabled - keep it enabled for best performance
2. **Use Smart Tools**: Always use smart_* variants instead of standard tools (60-90% reduction)
3. **Monitor Performance**: Use `get_session_stats` regularly to identify optimization opportunities
4. **Cache Large Content**: Use `optimize_text` for content >500 characters
5. **Use Batch Operations**: Many tools support batch operations for better performance

### Common Patterns

**File Reading Pattern**:
```typescript
// First read: full content
smart_read({ path: "/src/app.ts" })

// Subsequent reads: only changes (80% reduction)
smart_read({ path: "/src/app.ts" })
```

**API Caching Pattern**:
```typescript
// First request: fetch and cache
smart_api_fetch({
  method: "GET",
  url: "https://api.example.com/data",
  ttl: 300
})

// Subsequent requests: cached (95% reduction)
smart_api_fetch({
  method: "GET",
  url: "https://api.example.com/data"
})
```

**Session Monitoring Pattern**:
```typescript
// At the end of each session
const stats = await get_session_stats({});
console.log(`Saved ${stats.totalTokensSaved} tokens this session`);

// Periodic project analysis
const projectStats = await analyze_project_tokens({});
console.log(`Total project cost: $${projectStats.estimatedCost}`);
```

---

## Troubleshooting

### Common Issues

**Issue: Low cache hit rate**
- Solution: Use `cache_analytics` to identify cache misses and adjust TTL values

**Issue: Compression not providing expected savings**
- Solution: Use `analyze_optimization` to check if content is suitable for compression

**Issue: Tools returning stale data**
- Solution: Use `force: true` parameter to bypass cache and fetch fresh data

**Issue: Session stats not tracking operations**
- Solution: Ensure global hooks are installed and enabled

### Getting Help

For detailed troubleshooting and support:
- Check the main [README](../README.md) for installation and configuration
- Review [Installation Guide](./HOOKS-INSTALLATION.md) for platform-specific issues
- File an issue on GitHub with detailed error messages and reproduction steps

---

## Version Information

This documentation is for Token Optimizer MCP v2.0+

For updates and changelog, see [CHANGELOG.md](../CHANGELOG.md)
