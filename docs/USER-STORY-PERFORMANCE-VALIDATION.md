# User Story: Performance Optimization & Comprehensive Validation System

**Epic:** System Performance & Reliability
**Priority:** HIGH (Critical for production use)
**Story Points:** 21 (Complex, multiple subsystems affected)

## Story

**As a:** token-optimizer-mcp user
**I want:** Sub-10ms hook overhead and comprehensive argument validation
**So that:** Hooks don't slow down development AND bugs are caught early

## Current State (Problems)

### Critical Performance Issues
- **Hook Overhead:** 50-70ms per hook invocation (PreToolUse, PostToolUse)
- **Validation Coverage:** Only 11 of 67 tools have argument validation (84% unvalidated!)
- **Architecture:** All 67 tools loaded at startup, no lazy loading
- **File I/O:** Synchronous operations block event loop throughout

### Analysis Results from Gemini CLI (2M token context window)

#### PowerShell Hooks Bottlenecks:
1. **External Process Spawns** (10-50ms each)
   - `invoke-mcp.ps1` spawns new PowerShell process per call
   - `npx` invocation overhead for MCP server
2. **Frequent Disk I/O**
   - Session file read/write on every operation
   - Operation logs written individually (not batched)
3. **Verbose Logging**
   - DEBUG level logging to disk on hot path

#### TypeScript/Node.js Bottlenecks:
1. **Synchronous File I/O**
   - `readFileSync`, `statSync`, `existsSync` in smart-read.ts
   - Blocks event loop for large files
2. **No Caching**
   - Token counting: Same text tokenized multiple times
   - Embeddings: Regenerated for identical inputs
3. **Compression Overhead**
   - Synchronous Brotli compression (quality=11, slowest)
   - Blocks event loop for large data
4. **SQLite Updates**
   - Cache hit_count updated synchronously on every cache hit
5. **Session Analysis**
   - Multiple array iterations for aggregation (O(n²) in places)

#### Architectural Issues:
- 67 tools imported at startup (no lazy loading)
- Session state persisted synchronously
- No batch operations
- Compression quality hardcoded to maximum (slowest)

## Acceptance Criteria

### 1. Comprehensive Tool Argument Validation ✓
- [ ] All 67 tools have Zod schema validation
- [ ] Auto-validation before tool execution
- [ ] Clear error messages for validation failures
- [ ] Easily extensible for new tools
- [ ] Zero runtime validation errors in production

### 2. Sub-10ms PowerShell Hook Overhead ✓
- [ ] Average hook execution time < 10ms
- [ ] External process spawns eliminated where possible
- [ ] In-memory session state with batched async writes
- [ ] Configurable DEBUG logging (off by default)
- [ ] Batched operation log writes

### 3. Asynchronous File I/O Throughout ✓
- [ ] All `fs.*Sync` replaced with `fs.promises.*`
- [ ] No event loop blocking in hot paths
- [ ] Streaming for large file operations

### 4. Efficient Caching Mechanisms ✓
- [ ] Token counting cache (LRU, 1000 entries)
- [ ] Embedding cache (LRU, 500 entries)
- [ ] Cache hit rate > 80% for repeated operations

### 5. Optimized Session Management ✓
- [ ] In-memory session state
- [ ] Batched async log writes (every 5s or 100 operations)
- [ ] Single-pass aggregation in session-analyzer.ts

### 6. Lazy Loading for Tools ✓
- [ ] Dynamic imports for all tools
- [ ] Startup time reduced by 50%+
- [ ] Memory footprint reduced for unused tools

### 7. Integrated Performance Metrics ✓
- [ ] Hook execution times logged
- [ ] Cache hit/miss rates tracked
- [ ] I/O latencies measured
- [ ] Tool execution durations recorded
- [ ] Metrics exportable (JSON/CSV)

### 8. Environment Variable Opt-Outs ✓
- [ ] `TOKEN_OPTIMIZER_COMPRESSION_QUALITY` (default: 6, fast)
- [ ] `TOKEN_OPTIMIZER_DEBUG_LOGGING` (default: false)
- [ ] `TOKEN_OPTIMIZER_SEMANTIC_CACHE` (default: false, expensive)
- [ ] `TOKEN_OPTIMIZER_METRICS_ENABLED` (default: true)

## Technical Implementation

### Phase 1: Validation System (Week 1)

#### New Files:
```typescript
// src/validation/schemas.ts
import { z } from 'zod';

export const toolSchemas = {
  'smart_read': z.object({
    path: z.string().min(1, 'Path cannot be empty'),
    options: z.record(z.any()).optional(),
  }),
  'get_cached': z.object({
    key: z.string().min(1, 'Cache key cannot be empty'),
  }),
  // ... 65 more schemas
};

export function validateToolArgs(toolName: string, args: any) {
  const schema = toolSchemas[toolName];
  if (!schema) {
    throw new Error(`No validation schema found for tool: ${toolName}`);
  }
  try {
    return schema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments for tool "${toolName}": ${error.errors.map(e => `${e.path}: ${e.message}`).join(', ')}`
      );
    }
    throw error;
  }
}
```

#### Modified Files:
```typescript
// src/server/index.ts (line ~1800)
import { validateToolArgs } from '../validation/schemas.js';

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // VALIDATE BEFORE EXECUTION
  try {
    validateToolArgs(name, args || {});
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Validation Error: ${error.message}`,
      }],
      isError: true,
    };
  }

  // ... rest of tool execution
});
```

### Phase 2: PowerShell Hook Optimization (Week 2)

#### Modified Files:
```powershell
# hooks/handlers/token-optimizer-orchestrator.ps1

# Add script-scope variable for in-memory session
$script:CurrentSession = $null
$script:OperationLogBuffer = @()
$script:FlushTimer = $null

function Update-SessionOperation {
    param(
        [int]$TokensDelta = 0,
        [switch]$Persist = $false
    )

    $session = Get-SessionInfo
    if (-not $session) {
        $session = Initialize-Session
    }

    $session.totalOperations++
    $session.totalTokens += $TokensDelta

    # Only persist to disk if explicitly requested
    if ($Persist) {
        $session | ConvertTo-Json | Out-File $SESSION_FILE -Encoding UTF8
    }

    return $session
}

function Log-Operation {
    param([object]$Entry)

    # Buffer in memory
    $script:OperationLogBuffer += $Entry

    # Schedule flush if not already scheduled
    if (-not $script:FlushTimer) {
        $script:FlushTimer = [System.Timers.Timer]::new(5000) # 5 seconds
        $script:FlushTimer.AutoReset = $false
        Register-ObjectEvent $script:FlushTimer Elapsed -Action {
            Flush-OperationLogs
        }
        $script:FlushTimer.Start()
    }
}

function Flush-OperationLogs {
    if ($script:OperationLogBuffer.Count -gt 0) {
        $csvFile = "$OPERATIONS_DIR\operations-$($script:CurrentSession.sessionId).csv"
        $script:OperationLogBuffer | Export-Csv $csvFile -Append -NoTypeInformation
        $script:OperationLogBuffer = @()
    }
    $script:FlushTimer = $null
}
```

### Phase 3: Async File I/O (Week 3)

#### Modified Files:
```typescript
// src/tools/core/smart-read.ts
import { promises as fs } from 'fs';

export class SmartRead {
  async read(path: string, options?: ReadOptions): Promise<ReadResult> {
    // BEFORE: const stats = statSync(path);
    // AFTER:
    const stats = await fs.stat(path);

    // BEFORE: const content = readFileSync(path, 'utf-8');
    // AFTER:
    const content = await fs.readFile(path, 'utf-8');

    // BEFORE: const exists = existsSync(path);
    // AFTER:
    try {
      await fs.access(path);
      const exists = true;
    } catch {
      const exists = false;
    }

    // ... rest of logic
  }
}
```

### Phase 4: Caching Optimization (Week 3-4)

#### New Files:
```typescript
// src/cache/token-cache.ts
import { LRUCache } from 'lru-cache';

export class TokenCache {
  private cache: LRUCache<string, TokenCountResult>;

  constructor(maxItems: number = 1000) {
    this.cache = new LRUCache({
      max: maxItems,
      ttl: 1000 * 60 * 5, // 5 minutes
    });
  }

  get(text: string): TokenCountResult | undefined {
    return this.cache.get(text);
  }

  set(text: string, result: TokenCountResult): void {
    this.cache.set(text, result);
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hitRate: this.cache.calculatedHitRate,
    };
  }
}
```

#### Modified Files:
```typescript
// src/utils/token-counter.ts
import { TokenCache } from '../cache/token-cache.js';

export class TokenCounter {
  private cache: TokenCache;

  constructor() {
    this.encoder = encoding_for_model('gpt-4');
    this.cache = new TokenCache(1000);
  }

  count(text: string): TokenCountResult {
    // Check cache first
    const cached = this.cache.get(text);
    if (cached) {
      return cached;
    }

    // Calculate
    const tokens = this.encoder.encode(text);
    const result = {
      tokens: tokens.length,
      characters: text.length,
    };

    // Cache result
    this.cache.set(text, result);

    return result;
  }
}
```

### Phase 5: Lazy Loading (Week 4)

#### New Files:
```typescript
// src/core/tool-loader.ts
export class ToolLoader {
  private tools = new Map<string, any>();

  async loadTool(name: string): Promise<any> {
    if (this.tools.has(name)) {
      return this.tools.get(name);
    }

    const module = await import(`../tools/${name}.js`);
    this.tools.set(name, module);
    return module;
  }
}
```

#### Modified Files:
```typescript
// src/server/index.ts
import { ToolLoader } from '../core/tool-loader.js';

const toolLoader = new ToolLoader();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Lazy load tool
  const tool = await toolLoader.loadTool(name);

  // ... execute tool
});
```

### Phase 6: Performance Metrics (Week 4)

#### New Files:
```typescript
// src/core/performance-metrics.ts
export class PerformanceMetrics {
  private metrics = new Map<string, number[]>();

  startTimer(name: string): () => void {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.record(name, duration);
    };
  }

  record(name: string, value: number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(value);
  }

  getStats(name: string) {
    const values = this.metrics.get(name) || [];
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    return {
      count: values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: values.reduce((a, b) => a + b) / values.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }
}
```

## Testing Strategy

### 1. Performance Benchmarks

#### Before/After Comparison:
```typescript
// tests/benchmarks/hooks.bench.ts
describe('Hook Performance', () => {
  it('PreToolUse should execute in <10ms', async () => {
    const iterations = 1000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      await executeHook('PreToolUse', sampleData);
    }

    const duration = performance.now() - start;
    const avgPerHook = duration / iterations;

    expect(avgPerHook).toBeLessThan(10); // <10ms target
  });
});
```

#### Expected Results:
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Hook Overhead | 50-70ms | <10ms | **7x faster** |
| Token Count (uncached) | 5ms | 5ms | Same |
| Token Count (cached) | 5ms | <0.1ms | **50x faster** |
| File Read (sync) | 10-20ms | - | N/A |
| File Read (async) | - | 5-15ms | Non-blocking |
| Startup Time | 500ms | 250ms | **2x faster** |
| Memory (all tools) | 150MB | 50MB | **3x reduction** |

### 2. Load Testing

```bash
# Simulate 100 concurrent tool invocations
k6 run tests/load/concurrent-tools.js

# Expected: <10ms p95 latency, no timeouts
```

### 3. Validation Test Coverage

```typescript
// tests/validation/schemas.test.ts
describe('Tool Validation', () => {
  it('should validate all 67 tools', () => {
    const toolNames = Object.keys(toolSchemas);
    expect(toolNames.length).toBe(67);
  });

  it('should reject invalid arguments for smart_read', () => {
    expect(() => validateToolArgs('smart_read', {}))
      .toThrow('Path cannot be empty');
  });

  it('should accept valid arguments for smart_read', () => {
    const result = validateToolArgs('smart_read', {
      path: '/path/to/file.ts',
    });
    expect(result).toHaveProperty('path');
  });
});
```

## Migration Strategy

### Backward Compatibility:
- Environment variables default to current behavior
- Gradual rollout: validation warnings → errors
- Feature flags for each optimization

### Rollout Plan:
1. **Week 1:** Validation system (non-breaking, warnings only)
2. **Week 2:** PowerShell hooks optimization (backward compatible)
3. **Week 3:** Async file I/O (non-breaking, internal change)
4. **Week 4:** Caching + lazy loading (performance gains visible)
5. **Week 5:** Full metrics, final testing, release

### Monitoring:
- Track validation error rates
- Monitor performance metrics in production
- Gather user feedback on perceived performance

## Success Metrics

### Primary KPIs:
- ✅ Hook overhead: 50-70ms → <10ms (7x improvement)
- ✅ Validation coverage: 16% → 100% (67/67 tools)
- ✅ Cache hit rate: 0% → >80%
- ✅ Startup time: 500ms → 250ms (2x improvement)

### Secondary KPIs:
- Memory usage reduced by 66%
- File I/O non-blocking (event loop health)
- Error rate reduced by 90% (early validation)
- User-reported slowdowns: eliminated

## Dependencies

- `zod` (validation)
- `lru-cache` (token/embedding cache)
- Existing: `tiktoken`, `better-sqlite3`, Node.js `fs.promises`

## Risks & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Breaking changes for users | High | Low | Extensive testing, backward compat |
| Async bugs | Medium | Medium | Comprehensive async tests |
| Cache memory leaks | Medium | Low | LRU eviction, monitoring |
| PowerShell compatibility | Low | Low | Test on PowerShell 5.1 + 7+ |

## Notes from Gemini Analysis

All findings in this user story are based on comprehensive analysis using **Google Gemini CLI** with its **2 million token context window**, which allowed simultaneous analysis of:
- 138 TypeScript files
- 7 PowerShell files
- Full MCP server architecture
- All 67 tool implementations
- Hook execution flow
- Session management system
- Cache and compression engines

This depth of analysis would not be possible with traditional code review approaches.
