# Batch 2 Instructions - US-BF-001

**Batch**: 2 of 4
**Progress**: 34/60 items complete (56.7%)
**Your Target**: Complete 12 more items (will be 76.7% after this batch)

---

## Your Specific Assignment

Fix TS6133 errors ONLY in these 6 files:

### File 1: src/tools/code-analysis/smart-exports.ts
- Line 254: `_reductionPercentage` is declared but never read
- Line 449: `_fileDir` is declared but never read
- **Action**: Already prefixed with `_` but still showing error - verify they're truly unused

### File 2: src/tools/build-systems/smart-typecheck.ts
- Line 113: `tokenCounter` is declared but never read
- Line 114: `_metrics` is declared but never read
- **Action**: Prefix `tokenCounter` with `_`, verify `_metrics` is correct

### File 3: src/tools/build-systems/smart-test.ts
- Line 135: `tokenCounter` is declared but never read
- Line 136: `metrics` is declared but never read
- **Action**: Prefix both with `_`

### File 4: src/tools/build-systems/smart-network.ts
- Line 21: `_dnsResolve` is declared but never read
- Line 183: `projectRoot` is declared but never read
- **Action**: Verify `_dnsResolve` (already prefixed), prefix `projectRoot` with `_`

### File 5: src/tools/build-systems/smart-build.ts
- Line 120: `tokenCounter` is declared but never read
- Line 121: `metrics` is declared but never read
- **Action**: Prefix both with `_`

### File 6: src/tools/api-database/smart-database.ts
- Line 914: `query` is declared but never read
- Line 1405: `ttl` is declared but never read
- **Action**: Prefix both with `_` or remove if truly unused

---

## DO NOT Touch These Files

**Batch 1 (Already Complete)**:
- cache-optimizer.ts ✅
- smart-sql.ts ✅
- cache-analytics.ts ✅
- smart-refactor.ts ✅
- smart-processes.ts ✅
- smart-lint.ts ✅
- cache-warmup.ts ✅

**Batch 3 & 4 (Not Your Responsibility)**:
- All other files - will be handled by next agents

---

## Success Criteria

After completing your batch:
1. ✅ All 6 files in Batch 2 have 0 TS6133 errors
2. ✅ All 7 files from Batch 1 still have 0 errors (smoke test)
3. ✅ Exactly 12 items fixed in this batch
4. ✅ Progress manifest updated to show Batch 2 complete

---

## Verification Commands

```bash
# Check your 6 files have 0 errors
npm run build 2>&1 | grep -E "(smart-exports|smart-typecheck|smart-test|smart-network|smart-build|smart-database)" | grep "TS6133"
# Should show 0 lines

# Smoke test: Batch 1 files still clean
npm run build 2>&1 | grep -E "(cache-optimizer|smart-sql|cache-analytics|smart-refactor|smart-processes|smart-lint|cache-warmup)" | grep "TS6133"
# Should show 0 lines
```

---

## After Completion

1. Update progress-manifest.json:
   - Set batches[1].status = "complete"
   - Add session 3 details
2. Commit progress:
   ```bash
   git add .
   git commit --amend -m "WIP: US-BF-001 Batch 2 complete (76.7% done)"
   ```
3. Report completion percentage: 46/60 items = 76.7%
