# Batch 3 Instructions - US-BF-001

**Batch**: 3 of 4
**Progress**: 46/60 items complete (76.7%)
**Your Target**: Complete 8 more items (will be 90% after this batch)

---

## Your Specific Assignment

Fix TS6133 errors ONLY in these 6 files (Advanced Caching module):

### File 1: src/tools/advanced-caching/predictive-cache.ts
- Line 174: `cacheTTL` parameter declared but never read
- Line 986: `pattern` declared but never read
- **Action**: Remove `cacheTTL` from destructuring, prefix `pattern` with `_`

### File 2: src/tools/advanced-caching/cache-replication.ts
- Line 681: `force` parameter declared but never read
- Line 1297: `nodeId` parameter declared but never read
- **Action**: Prefix both with `_` or remove from destructuring

### File 3: src/tools/advanced-caching/cache-invalidation.ts
- Line 226: `cacheTTL` parameter declared but never read
- **Action**: Remove from destructuring

### File 4: src/tools/advanced-caching/cache-partition.ts
- Line 1466: `_coAccessPatterns` declared but never read
- **Action**: Already prefixed but still showing error - verify it's needed for interface

### File 5: src/tools/advanced-caching/cache-benchmark.ts
- Line 403: `config` declared but never read
- **Action**: Prefix with `_` or remove

### File 6: src/tools/advanced-caching/smart-cache.ts
- Line 221: `cacheTTL` parameter declared but never read
- **Action**: Remove from destructuring

---

## DO NOT Touch These Files

**Batch 1 & 2 (Already Complete)**:
- All files from batches 1 and 2 - DO NOT modify

**Batch 4 (Not Your Responsibility)**:
- smart-migration.ts
- smart-orm.ts
- smart-system-metrics.ts
- smart-ast-grep.ts
- smart-imports.ts
- smart-security.ts

---

## Success Criteria

After completing your batch:
1. ✅ All 6 files in Batch 3 have 0 TS6133 errors
2. ✅ All 13 files from Batches 1 & 2 still have 0 errors (smoke test)
3. ✅ Exactly 8 items fixed in this batch
4. ✅ Progress manifest updated to show Batch 3 complete

---

## Verification Commands

```bash
# Check your 6 files have 0 errors
npm run build 2>&1 | grep -E "(predictive-cache|cache-replication|cache-invalidation|cache-partition|cache-benchmark|smart-cache)" | grep "TS6133"
# Should show 0 lines

# Smoke test: Previous batches still clean
npm run build 2>&1 | grep -E "(cache-optimizer|smart-sql|cache-analytics|smart-refactor|smart-processes|smart-lint|cache-warmup|smart-exports|smart-typecheck|smart-test|smart-network|smart-build|smart-database)" | grep "TS6133"
# Should show 0 lines
```

---

## After Completion

1. Update progress-manifest.json:
   - Set batches[2].status = "complete"
   - Add session 4 details
2. Commit progress:
   ```bash
   git add .
   git commit --amend -m "WIP: US-BF-001 Batch 3 complete (90% done)"
   ```
3. Report completion percentage: 54/60 items = 90%
