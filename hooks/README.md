# Token Optimizer MCP - Hooks Directory

## Overview

This directory contains PowerShell hook handlers that integrate with the Claude Code hook system to provide real-time token optimization during AI assistant sessions.

## Hook Handlers

### read-cache-interceptor.ps1

**Purpose**: Implements intelligent caching for Read tool operations to dramatically reduce token usage by preventing redundant file reads.

**Token Savings**: 250-350K tokens per session through cache hits

**Architecture**: Two-tier caching strategy
- **Tier 1**: In-memory hashtable (`$global:ReadCache`) for instant lookups
- **Tier 2**: Persistent JSON file (`read-cache.json`) for cross-session persistence

#### How It Works

1. **PreToolUse Phase** (Cache Check):
   - Intercepts Read tool before execution
   - Canonicalizes file path for consistent cache keys
   - Checks if file exists in cache
   - Validates cache freshness using `LastWriteTime` comparison
   - **On Cache HIT**: Blocks Read tool (exit 2) and returns cached content via `hookSpecificOutput.cachedContent`
   - **On Cache MISS/STALE**: Allows Read tool to proceed (exit 0)

2. **PostToolUse Phase** (Cache Storage):
   - Captures successful Read tool results
   - Extracts file content from tool result
   - Stores in cache with metadata:
     - `Content`: Full file content
     - `LastWriteTime`: File modification timestamp
     - `Tokens`: Estimated token count (~4 chars per token)
     - `OriginalSize`: File size in bytes
     - `AccessCount`: Number of cache hits
     - `FirstAccessed`: Initial cache entry timestamp

#### Cache Invalidation

Cache entries are automatically invalidated when:
- File is modified (detected via `LastWriteTime` comparison)
- File is deleted (detected via `Test-Path`)

Stale entries are removed immediately upon detection.

#### Configuration

**File Locations**:
```powershell
$CACHE_FILE = "C:\Users\yolan\.claude-global\hooks\data\read-cache.json"
$CACHE_DIR = "C:\Users\yolan\.claude-global\hooks\data"
$LOG_FILE = "C:\Users\yolan\.claude-global\hooks\logs\read-cache.log"
```

**Exit Codes**:
- `0`: Allow Read tool to proceed (cache miss, stale, or error)
- `2`: Block Read tool and use cached content (cache hit)

#### Cache Statistics

Tracks comprehensive metrics:
- `Hits`: Number of successful cache lookups
- `Misses`: Number of cache misses (file not cached)
- `Stale`: Number of invalidated entries (file modified)
- `TokensSaved`: Cumulative tokens saved across all cache hits
- `HitRate`: Percentage of cache hits vs. total requests

**Statistics are returned in hookSpecificOutput**:
```json
{
  "cacheStats": {
    "hits": 42,
    "misses": 15,
    "stale": 3,
    "tokensSaved": 125000,
    "hitRate": 73.68
  }
}
```

#### Canonical Path Resolution

Uses `Get-CanonicalPath` function to normalize file paths:
- Resolves relative paths to absolute paths
- Handles symlinks via `Resolve-Path`
- Standardizes case (`.ToLower()`) for Windows compatibility
- Ensures consistent cache keys across different path formats

#### Persistence Strategy

**Automatic Save Triggers**:
- Every 20 cache hits (line 205-207)
- Every 20 new cache entries (line 260-262)

**Dirty Flag**: `$global:CacheDirty` tracks when in-memory cache differs from disk

**Save Process**:
1. Convert hashtable to array of key-value pairs
2. Serialize DateTime objects using `ToString("o")` (ISO 8601)
3. Write JSON to disk with UTF-8 encoding
4. Reset dirty flag

**Load Process**:
1. Read JSON file on first Read operation
2. Deserialize to PowerShell objects
3. Parse DateTime strings back to `[DateTime]` objects
4. Convert array to hashtable for fast lookups

## Integration with Claude Code

### Dispatcher Integration

The read-cache-interceptor.ps1 is invoked by the Claude Code hook dispatcher (`C:\Users\yolan\.claude-global\hooks\dispatcher.ps1`) at two points:

**PreToolUse Phase** (line 90-128):
```powershell
$READ_CACHE_HANDLER = "C:\Users\yolan\source\repos\token-optimizer-mcp\hooks\read-cache-interceptor.ps1"

if ($toolName -eq "Read") {
    $tempOut = [System.IO.Path]::GetTempFileName()
    $tempErr = [System.IO.Path]::GetTempFileName()

    try {
        $null = $input_json | & powershell -NoProfile -ExecutionPolicy Bypass -File $READ_CACHE_HANDLER -Phase "PreToolUse" 1>$tempOut 2>$tempErr
        $exitCode = $LASTEXITCODE

        if ($exitCode -eq 2) {
            # Cache HIT - Read cached content and block Read tool
            $stdOut = Get-Content $tempOut -Raw -ErrorAction SilentlyContinue

            if ($stdOut) {
                $response = $stdOut | ConvertFrom-Json
                if ($response.hookSpecificOutput.cachedContent) {
                    Write-Log "[CACHE HIT] Read tool blocked - using cached content"
                    Write-Output $stdOut
                    exit 2  # Block the Read tool
                }
            }
        }
    } finally {
        Remove-Item $tempOut -ErrorAction SilentlyContinue
        Remove-Item $tempErr -ErrorAction SilentlyContinue
    }
}
```

**PostToolUse Phase** (line 317-320):
```powershell
if ($toolName -eq "Read") {
    $input_json | & powershell -ExecutionPolicy Bypass -File $READ_CACHE_HANDLER -Phase "PostToolUse"
}
```

### Hook Event JSON Structure

**Input** (stdin):
```json
{
  "tool_name": "Read",
  "tool_input": {
    "file_path": "C:\\Users\\yolan\\source\\repos\\file.txt"
  },
  "tool_result": {
    "content": [
      {
        "type": "text",
        "text": "File content here..."
      }
    ]
  }
}
```

**Output** (stdout, on cache hit):
```json
{
  "continue": false,
  "stopReason": "CACHE_HIT: Using cached content for C:\\path\\file.txt (saved 1250 tokens)",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "File content available in cache",
    "handlerName": "ReadCacheInterceptor",
    "cachedContent": "File content from cache...",
    "cacheStats": {
      "hits": 42,
      "misses": 15,
      "stale": 3,
      "tokensSaved": 125000,
      "hitRate": 73.68
    }
  }
}
```

## Performance Impact

### Token Savings Example

**Without Caching**:
- Session with 100 Read operations
- Average file size: 3,000 tokens
- Total tokens: 300,000

**With Caching** (70% hit rate):
- 30 Read operations (cache misses)
- 70 cached responses (cache hits)
- Total tokens: 90,000 (30 × 3,000)
- **Saved: 210,000 tokens (70%)**

### Cache Hit Rate Optimization

Factors affecting hit rate:
- **High hit rate** (>80%): Repeatedly reading same configuration files, repeated debugging of same code files
- **Medium hit rate** (50-80%): Mixed workflow with some file modifications
- **Low hit rate** (<50%): Rapid development with frequent file changes

### Memory Footprint

**In-Memory Cache**:
- Hashtable overhead: ~48 bytes per entry
- Content storage: Actual file size
- Metadata: ~200 bytes per entry (timestamps, counters)

**Example**: 100 cached files averaging 5KB each
- Content: 500KB
- Metadata: ~25KB
- Total: ~525KB

**Disk Storage**:
- JSON file size: ~1.2× in-memory size due to JSON serialization overhead
- Example: ~630KB for 100 files

## Error Handling

**All errors result in exit 0** (allow Read tool to proceed):
- JSON parsing failures
- File access errors
- Cache corruption
- Serialization errors

**Philosophy**: Never block legitimate Read operations due to cache errors. Fail-safe behavior ensures system reliability.

## Logging

**Log Location**: `C:\Users\yolan\.claude-global\hooks\logs\read-cache.log`

**Log Levels**:
- `INFO`: Normal operations (cache hits, misses, stale entries, cache saves)
- `WARN`: Non-critical issues (cache file load failures, missing file paths)
- `ERROR`: Critical failures (JSON parsing errors, cache operation failures)

**Log Format**:
```
[2025-10-13 09:30:15] [INFO] CACHE HIT: c:\users\yolan\source\repos\file.txt (saved 1250 tokens, access count: 5)
[2025-10-13 09:30:20] [INFO] CACHE MISS: c:\users\yolan\source\repos\newfile.txt (total misses: 16)
[2025-10-13 09:30:25] [INFO] CACHED: c:\users\yolan\source\repos\newfile.txt (1250 tokens, 5000 bytes)
[2025-10-13 09:30:30] [INFO] CACHE STALE: c:\users\yolan\source\repos\file.txt (file modified at 10/13/2025 09:30:28, cache from 10/13/2025 09:00:00)
```

## Future Enhancements

### Planned Features
1. **TTL-based expiration**: Optional time-to-live for cache entries
2. **Size-based eviction**: LRU eviction when cache exceeds size threshold
3. **Compression**: Compress large files in cache (>10KB)
4. **Cache warming**: Pre-populate cache with frequently accessed files
5. **Multi-session statistics**: Aggregate stats across all sessions
6. **Cache metrics dashboard**: Web UI for visualizing cache performance

### Configuration Options (Future)
```powershell
$CACHE_CONFIG = @{
    MaxSizeBytes = 100MB           # Maximum cache size
    MaxEntries = 1000              # Maximum number of entries
    TTLMinutes = 60                # Cache entry lifetime
    EnableCompression = $true      # Compress large files
    CompressionThreshold = 10KB    # Minimum size for compression
    EvictionPolicy = "LRU"         # LRU, LFU, or FIFO
}
```

## Contributing

When modifying read-cache-interceptor.ps1:
1. Maintain backward compatibility with existing cache files
2. Update cache version number for breaking changes
3. Test with both empty and populated caches
4. Verify cache invalidation logic with file modifications
5. Ensure error handling always results in safe fallback (exit 0)
6. Update this README with any configuration changes

## Version History

- **v1.0** (2025-10-13): Initial implementation with two-tier caching
  - In-memory hashtable for speed
  - Persistent JSON for cross-session cache
  - LastWriteTime-based invalidation
  - Comprehensive statistics tracking
