# Cache Error Analysis Report
**Date**: 2025-10-21
**Analyzer**: Agent 5 - Gemini CLI Troubleshooter

## Executive Summary

Analyzed the cache-engine.ts code to identify the root cause of **"Cannot read properties of undefined (reading 'run')"** error. Multiple potential issues identified with specific fixes recommended.

## Root Cause Analysis

### Issue 1: Database Connection Not Guaranteed After Constructor Failure (CRITICAL)

**Location**: `src/core/cache-engine.ts`, lines 50-110

**Problem**: The constructor has a try-catch block for database initialization, but if the database fails to initialize even after recovery attempt, `this.db` could remain undefined.

**Code Pattern**:
```typescript
constructor(dbPath?: string, maxMemoryItems: number = 1000) {
  try {
    this.db = new Database(fullDbPath);
    // ... initialization ...
  } catch {
    // Recovery attempt
    this.db = new Database(fullDbPath);
    // ... initialization ...
  }
}
```

**Why This Causes "reading 'run'" Error**:
- If `new Database(fullDbPath)` throws in the catch block, `this.db` remains undefined
- Later calls to `this.db.prepare()` return undefined
- Calling `.run()` on undefined causes: "Cannot read properties of undefined (reading 'run')"

**Affected Methods**: ALL methods that use `this.db.prepare().run()`:
- Line 172: `stmt.run(key, value, compressedSize, originalSize, key, key, now, now)`
- Line 184: `const result = stmt.run(key)`
- Line 257: `const result = this.db.prepare('DELETE FROM cache').run()`
- Line 269: `const result = stmt.run(...keysToKeep.map((k) => k.key))`
- Line 310: `stmt.run(Date.now(), key)`

**Recommended Fix**:
```typescript
constructor(dbPath?: string, maxMemoryItems: number = 1000) {
  // ... path setup ...

  let dbInitialized = false;
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      this.db = new Database(fullDbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(/* CREATE TABLE SQL */);
      dbInitialized = true;
      break;
    } catch (error) {
      console.error(`Database init attempt ${attempt + 1} failed:`, error);

      // Only try to delete and recreate on first failure
      if (attempt === 0 && fs.existsSync(fullDbPath)) {
        try {
          // Cleanup corrupted database
          this.cleanupDatabaseFiles(fullDbPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  if (!dbInitialized) {
    throw new Error(`Failed to initialize cache database after ${maxRetries} attempts`);
  }

  // ... memory cache init ...
}

private cleanupDatabaseFiles(dbPath: string): void {
  fs.unlinkSync(dbPath);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
}
```

### Issue 2: Cache Hit Rate Always Shows 0% (HIGH PRIORITY)

**Location**: `src/core/cache-engine.ts`, lines 201-232

**Problem**: The `getStats()` method uses **runtime stats** (`this.stats.hits` and `this.stats.misses`) instead of **persisted stats** from the database.

**Why This Causes 0% Hit Rate**:
- `this.stats.hits` and `this.stats.misses` are **in-memory only**
- They reset to 0 on every server restart
- Database stores `hit_count` per entry, but `getStats()` doesn't use it for hit rate calculation

**Current Code**:
```typescript
getStats(): CacheStats {
  const stmt = this.db.prepare(`
    SELECT
      COUNT(*) as total_entries,
      SUM(hit_count) as total_hits,  // ← Database has this
      SUM(compressed_size) as total_compressed,
      SUM(original_size) as total_original
    FROM cache
  `);

  const row = stmt.get() as { ... };

  // ❌ WRONG: Uses runtime stats instead of database stats
  const totalRequests = this.stats.hits + this.stats.misses;
  const hitRate = totalRequests > 0 ? this.stats.hits / totalRequests : 0;

  return {
    totalEntries: row.total_entries,
    totalHits: row.total_hits || 0,  // ← Database value (correct)
    totalMisses: this.stats.misses,  // ← Runtime value (resets on restart)
    hitRate,  // ← Calculated from runtime stats (wrong!)
    // ...
  };
}
```

**Recommended Fix**:
```typescript
getStats(): CacheStats {
  const stmt = this.db.prepare(`
    SELECT
      COUNT(*) as total_entries,
      SUM(hit_count) as total_hits,
      SUM(compressed_size) as total_compressed,
      SUM(original_size) as total_original
    FROM cache
  `);

  const row = stmt.get() as { ... };

  // ✅ CORRECT: Use database stats + runtime stats
  const totalHitsFromDb = row.total_hits || 0;
  const totalHitsSinceRestart = this.stats.hits;
  const totalMissesSinceRestart = this.stats.misses;

  const totalRequests = totalHitsSinceRestart + totalMissesSinceRestart;
  const hitRate = totalRequests > 0
    ? totalHitsSinceRestart / totalRequests
    : 0;

  return {
    totalEntries: row.total_entries,
    totalHits: totalHitsFromDb,  // ← Database value (cumulative)
    totalMisses: totalMissesSinceRestart,  // ← Runtime value (since restart)
    hitRate,  // ← Calculated from runtime (since restart)
    totalCompressedSize: row.total_compressed || 0,
    totalOriginalSize: row.total_original || 0,
    compressionRatio: row.total_original > 0
      ? row.total_compressed / row.total_original
      : 0,
  };
}
```

**Alternative Fix (Store Misses in Database)**:
Add a `cache_stats` table to persist misses:
```typescript
CREATE TABLE IF NOT EXISTS cache_stats (
  total_misses INTEGER DEFAULT 0
);

// Update on cache miss
private recordMiss(): void {
  this.stats.misses++;
  this.db.prepare('UPDATE cache_stats SET total_misses = total_misses + 1').run();
}
```

### Issue 3: Potential Race Condition in Concurrent Access (MEDIUM)

**Location**: Multiple methods accessing `this.db.prepare().run()`

**Problem**: SQLite WAL mode provides concurrency, but multiple simultaneous calls to `prepare()` and `run()` from different async operations could cause timing issues.

**Recommended Fix**: Add connection pool or mutex:
```typescript
import { Mutex } from 'async-mutex';

export class CacheEngine {
  private db: Database.Database;
  private mutex = new Mutex();

  async set(key: string, value: string, originalSize: number, compressedSize: number): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const stmt = this.db.prepare(/* SQL */);
      stmt.run(/* params */);
      this.memoryCache.set(key, value);
    } finally {
      release();
    }
  }
}
```

### Issue 4: Missing Error Handling in updateHitCount (MEDIUM)

**Location**: `src/core/cache-engine.ts`, line 304-311

**Problem**: If `updateHitCount()` fails (e.g., database locked), it silently fails and doesn't log errors.

**Recommended Fix**:
```typescript
private updateHitCount(key: string): void {
  try {
    const stmt = this.db.prepare(`
      UPDATE cache
      SET hit_count = hit_count + 1, last_accessed_at = ?
      WHERE key = ?
    `);
    stmt.run(Date.now(), key);
  } catch (error) {
    console.error('Failed to update hit count for key:', key, error);
    // Continue execution - don't block cache reads on stats update failure
  }
}
```

## Top 5 Critical Issues Summary

### 1. Database Undefined After Constructor Failure
- **Severity**: CRITICAL
- **Location**: `src/core/cache-engine.ts:50-110`
- **Problem**: If database initialization fails twice, `this.db` is undefined
- **Impact**: All cache operations fail with "Cannot read properties of undefined"
- **Fix**: Add retry logic + throw error if all attempts fail

### 2. Cache Hit Rate Always 0% After Restart
- **Severity**: HIGH
- **Location**: `src/core/cache-engine.ts:201-232`
- **Problem**: Uses runtime stats instead of database stats
- **Impact**: Misleading cache performance metrics
- **Fix**: Use database stats or persist misses in database

### 3. Missing Error Handling in Critical Paths
- **Severity**: HIGH
- **Location**: Multiple methods calling `.run()`
- **Problem**: No try-catch around database operations
- **Impact**: Unhandled promise rejections, server crashes
- **Fix**: Add try-catch to all database operations

### 4. Potential Race Conditions in Concurrent Access
- **Severity**: MEDIUM
- **Location**: All methods using `this.db.prepare().run()`
- **Problem**: Multiple async operations could conflict
- **Impact**: Data corruption, lost updates
- **Fix**: Add mutex or connection pooling

### 5. Eviction Logic May Delete All Cache
- **Severity**: MEDIUM
- **Location**: `src/core/cache-engine.ts:255-261`
- **Problem**: If no keys fit in limit, deletes ALL cache
- **Impact**: Complete cache loss, performance degradation
- **Fix**: Keep at least the most recent N entries

## Architecture Recommendations

### 1. Separate Concerns: Stats vs Cache Storage
**Current**: Stats are mixed between runtime memory and database
**Recommended**:
- Store ALL stats in database (including misses)
- OR store ALL stats in memory (log at shutdown)
- NEVER mix the two approaches

### 2. Add Cache Health Monitoring
**Recommended**:
```typescript
export class CacheEngine {
  getHealth(): CacheHealth {
    return {
      databaseConnected: this.db !== undefined,
      memoryCacheSize: this.memoryCache.size,
      lastError: this.lastError,
      errorCount: this.errorCount,
    };
  }
}
```

### 3. Implement Graceful Degradation
**Recommended**: If database fails, continue with memory-only cache:
```typescript
get(key: string): string | null {
  // Always check memory first
  const memValue = this.memoryCache.get(key);
  if (memValue !== undefined) {
    return memValue;
  }

  // Only check database if connected
  if (this.db) {
    try {
      // ... database logic ...
    } catch (error) {
      console.error('Database error, continuing with memory cache:', error);
      this.dbHealthy = false;
    }
  }

  return null;
}
```

## Performance Optimization Opportunities

### 1. Batch Updates for Hit Counts
Instead of updating on every hit, batch updates every N seconds:
```typescript
private pendingHitUpdates = new Map<string, number>();

private updateHitCount(key: string): void {
  this.pendingHitUpdates.set(key, (this.pendingHitUpdates.get(key) || 0) + 1);
}

private async flushHitUpdates(): Promise<void> {
  if (this.pendingHitUpdates.size === 0) return;

  const updates = Array.from(this.pendingHitUpdates.entries());
  this.pendingHitUpdates.clear();

  const tx = this.db.transaction((updates) => {
    for (const [key, count] of updates) {
      this.db.prepare('UPDATE cache SET hit_count = hit_count + ? WHERE key = ?')
        .run(count, key);
    }
  });

  tx(updates);
}
```

### 2. Use Prepared Statement Cache
Reuse prepared statements instead of creating new ones:
```typescript
private stmtCache = {
  get: this.db.prepare('SELECT value, hit_count FROM cache WHERE key = ?'),
  set: this.db.prepare('INSERT OR REPLACE INTO cache ...'),
  updateHit: this.db.prepare('UPDATE cache SET hit_count = hit_count + 1 WHERE key = ?'),
};
```

### 3. Add Cache Warmup on Startup
Load most frequently used entries into memory cache:
```typescript
private warmupMemoryCache(): void {
  const hotEntries = this.db.prepare(`
    SELECT key, value
    FROM cache
    ORDER BY hit_count DESC, last_accessed_at DESC
    LIMIT ?
  `).all(this.memoryCache.max * 0.5) as { key: string; value: string }[];

  for (const entry of hotEntries) {
    this.memoryCache.set(entry.key, entry.value);
  }
}
```

## Next Steps

1. **Immediate** (Critical): Fix constructor to prevent undefined database
2. **Short-term** (High): Fix cache hit rate calculation
3. **Medium-term** (Medium): Add error handling to all database operations
4. **Long-term** (Medium): Implement batch updates and prepared statement caching

## Testing Recommendations

### Unit Tests Needed
1. Test database initialization failure scenarios
2. Test cache operations after server restart
3. Test concurrent cache access
4. Test cache eviction edge cases
5. Test stats persistence across restarts

### Integration Tests Needed
1. Test long-running cache operations (memory leaks)
2. Test cache behavior under high load
3. Test database corruption recovery
4. Test cache warmup performance

## Conclusion

The **"Cannot read properties of undefined (reading 'run')"** error is caused by database initialization failures in the constructor. The cache hit rate showing 0% is due to mixing runtime and database stats.

**Priority Fixes**:
1. Add retry logic + error throwing in constructor
2. Fix hit rate calculation to use database stats
3. Add comprehensive error handling

These fixes will resolve both reported issues and improve overall cache reliability.
