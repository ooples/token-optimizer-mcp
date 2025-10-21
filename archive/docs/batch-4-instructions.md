# Batch 4 Instructions - US-BF-001 (FINAL BATCH)

**Batch**: 4 of 4 (FINAL)
**Progress**: 54/60 items complete (90%)
**Your Target**: Complete final 6 items (will be 100% complete!)

---

## Your Specific Assignment

Fix TS6133 errors ONLY in these 6 files (final cleanup):

### File 1: src/tools/api-database/smart-migration.ts
- Line 506: `ttl` parameter declared but never read
- **Action**: Prefix with `_` or remove from destructuring

### File 2: src/tools/api-database/smart-orm.ts
- Line 185: `relationships` declared but never read
- **Action**: Prefix with `_` or remove

### File 3: src/tools/build-systems/smart-system-metrics.ts
- Line 171: `projectRoot` declared but never read
- **Action**: Prefix with `_`

### File 4: src/tools/code-analysis/smart-ast-grep.ts
- Line 161: `_cachedResult` declared but never read
- **Action**: Already prefixed but still showing error - verify it's needed

### File 5: src/tools/code-analysis/smart-imports.ts
- Line 272: `_reductionPercentage` declared but never read
- **Action**: Already prefixed but still showing error - verify it's needed

### File 6: src/tools/code-analysis/smart-security.ts
- Line 554: `tokenCounter` declared but never read
- **Action**: Prefix with `_`

---

## DO NOT Touch These Files

**Batches 1, 2, & 3 (Already Complete)**:
- ALL 19 files from previous batches - DO NOT modify

---

## Success Criteria (FINAL)

After completing your batch:
1. ✅ All 6 files in Batch 4 have 0 TS6133 errors
2. ✅ All 19 files from previous batches still have 0 errors (smoke test)
3. ✅ Exactly 6 items fixed in this batch
4. ✅ **ALL 25 files in user story now have 0 TS6133 errors**
5. ✅ **User story is 100% COMPLETE**

---

## Verification Commands

```bash
# Check your 6 files have 0 errors
npm run build 2>&1 | grep -E "(smart-migration|smart-orm|smart-system-metrics|smart-ast-grep|smart-imports|smart-security)" | grep "TS6133"
# Should show 0 lines

# FINAL CHECK: All 25 user story files have 0 errors
npm run build 2>&1 | grep "TS6133" | grep -E "(cache-optimizer|smart-sql|cache-analytics|smart-refactor|smart-processes|smart-lint|cache-warmup|smart-exports|smart-typecheck|smart-test|smart-network|smart-build|smart-database|predictive-cache|cache-replication|cache-invalidation|cache-partition|cache-benchmark|smart-cache|smart-migration|smart-orm|smart-system-metrics|smart-ast-grep|smart-imports|smart-security)"
# Should show 0 lines
```

---

## After Completion (FINAL STEPS)

1. Update progress-manifest.json:
   - Set batches[3].status = "complete"
   - Add session 5 details
   - Mark entire user story as COMPLETE

2. Create FINAL commit (amend WIP):
   ```bash
   git add .
   git commit --amend -m "fix(US-BF-001): Remove 60 unused variables (TS6133)

Removed all unused variable declarations across 25 files.
Changes made ONLY to files specified in user story.

Files Modified (by batch):
Batch 1 (7 files, 34 items):
- src/tools/advanced-caching/cache-optimizer.ts
- src/tools/api-database/smart-sql.ts
- src/tools/advanced-caching/cache-analytics.ts
- src/tools/code-analysis/smart-refactor.ts
- src/tools/build-systems/smart-processes.ts
- src/tools/build-systems/smart-lint.ts
- src/tools/advanced-caching/cache-warmup.ts

Batch 2 (6 files, 12 items):
- src/tools/code-analysis/smart-exports.ts
- src/tools/build-systems/smart-typecheck.ts
- src/tools/build-systems/smart-test.ts
- src/tools/build-systems/smart-network.ts
- src/tools/build-systems/smart-build.ts
- src/tools/api-database/smart-database.ts

Batch 3 (6 files, 8 items):
- src/tools/advanced-caching/predictive-cache.ts
- src/tools/advanced-caching/cache-replication.ts
- src/tools/advanced-caching/cache-invalidation.ts
- src/tools/advanced-caching/cache-partition.ts
- src/tools/advanced-caching/cache-benchmark.ts
- src/tools/advanced-caching/smart-cache.ts

Batch 4 (6 files, 6 items):
- src/tools/api-database/smart-migration.ts
- src/tools/api-database/smart-orm.ts
- src/tools/build-systems/smart-system-metrics.ts
- src/tools/code-analysis/smart-ast-grep.ts
- src/tools/code-analysis/smart-imports.ts
- src/tools/code-analysis/smart-security.ts

Acceptance Criteria Met:
- All 60 TS6133 errors resolved ✅
- Build completes with 0 TypeScript errors for modified files ✅
- No functionality broken ✅

References: US-BF-001

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
   ```

3. Push to remote:
   ```bash
   git push -u origin fix/us-bf-001-remove-unused
   ```

4. Create Pull Request:
   ```bash
   gh pr create \
     --title "fix(US-BF-001): Remove 60 unused variables (TS6133)" \
     --body "[Use PR template from user story]" \
     --base master
   ```

5. Report SUCCESS:
   - 25/25 files complete (100%)
   - 60/60 items fixed (100%)
   - Commit SHA: [sha]
   - PR URL: [url]
