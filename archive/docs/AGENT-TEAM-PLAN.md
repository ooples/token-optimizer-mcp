# AGENT TEAM PLAN - Systematic TypeScript Error Fixes
## Current State: 1025 Errors → Target: 0 Errors

**Created:** 2025-10-14
**Strategy:** Dependency-aware parallel execution with measurable goals per agent

---

## ERROR BREAKDOWN (Baseline: 1025 errors)

| Error Code | Count | Description | Severity |
|------------|-------|-------------|----------|
| TS6133 | 279 | Unused variables/imports | Low |
| TS2305 | 246 | Module has no exported member | High |
| TS2345 | 116 | Type argument mismatch | Medium |
| TS2322 | 61 | Type assignment mismatch | Medium |
| TS7006 | 55 | Implicit any type | Low |
| TS2554 | 53 | Wrong argument count | High |
| TS2362 | 43 | Arithmetic operand must be number | Medium |
| TS6192 | 37 | All imports unused | Low |
| TS2307 | 34 | Cannot find module | High |
| TS2363 | 33 | Left operand must be unique symbol | Medium |
| TS2339 | 25 | Property does not exist | High |
| Others | 43 | Various | Mixed |

---

## PHASE 1: FOUNDATION (Sequential) - 10 minutes

### Agent Alpha: Remove Unused Imports
**Goal:** Fix TS6133 (279) + TS6192 (37) = **316 errors → 0 errors**

**Why First:** Must run first because unused imports block understanding of what's actually needed

**Strategy:**
1. Scan all files in src/tools/ for TS6133 and TS6192 errors
2. Remove import statements that are marked as unused
3. Preserve imports that are used in constructors (dependency injection pattern)

**Verification Command:**
```bash
npm run build 2>&1 | grep -c "TS6133\|TS6192"
# Expected: 0
```

**Files to Process:** All 93 tool files in src/tools/

**Success Criteria:**
- TS6133 errors: 279 → 0
- TS6192 errors: 37 → 0
- Total errors: 1025 → 709 (reduction of 316)
- No new errors introduced

---

## PHASE 2: CORE FIXES (Parallel) - 20 minutes

Launch 3 agents in parallel after Phase 1 completes:

### Agent Beta: Fix Index Export Declarations
**Goal:** Fix TS2305 = **246 errors → 0 errors**

**Why Parallel:** Works on index.ts files which don't affect tool implementations

**Strategy:**
1. For each index.ts file with TS2305 errors
2. Check if the exported member actually exists in the source file
3. Remove export statements for non-existent members
4. Keep exports that exist

**Verification Command:**
```bash
npm run build 2>&1 | grep -c "TS2305"
# Expected: 0
```

**Files to Process:** All index.ts files in src/tools/ categories

**Success Criteria:**
- TS2305 errors: 246 → 0
- No exports removed that are actually needed

---

### Agent Gamma: Fix Type Mismatches
**Goal:** Fix TS2322 (61) + TS2345 (116) + TS2362 (43) = **220 errors → ~50 errors**

**Why Parallel:** Works on type conversions within tool implementations

**Strategy:**
1. **TS2322 (TokenCountResult):** Add `.tokens` to `tokenCounter.count()` calls
   - Pattern: `const x: number = tokenCounter.count(text)` → `const x: number = tokenCounter.count(text).tokens`
2. **TS2345 (Buffer→String):** Add `.toString('utf-8')` to Buffer arguments
   - Pattern: `function(buffer)` → `function(buffer.toString('utf-8'))`
3. **TS2362 (Arithmetic):** Ensure operands are numbers with type conversions

**Verification Command:**
```bash
npm run build 2>&1 | grep -c "TS2322\|TS2345\|TS2362"
# Expected: <50 (some may need manual review)
```

**Files to Process:**
- cache-partition.ts (multiple TS2322, TS2345)
- cache-benchmark.ts
- ~30 other tool files with type issues

**Success Criteria:**
- Combined errors: 220 → <50 (77% reduction)
- All TokenCountResult issues fixed
- All Buffer→String conversions applied

---

### Agent Delta: Fix Function Signatures and Imports
**Goal:** Fix TS2554 (53) + TS2307 (34) + TS7006 (55) = **142 errors → ~30 errors**

**Why Parallel:** Works on function calls and imports, independent of type fixes

**Strategy:**
1. **TS2554 (Argument count):** Check function signatures and fix call sites
2. **TS2307 (Module not found):** Fix import paths (likely .js extension issues)
3. **TS7006 (Implicit any):** Add explicit type annotations

**Verification Command:**
```bash
npm run build 2>&1 | grep -c "TS2554\|TS2307\|TS7006"
# Expected: <30 (some may need manual review)
```

**Files to Process:**
- cache-benchmark.ts (TS2554)
- Files with .js imports
- Files with implicit any types

**Success Criteria:**
- Combined errors: 142 → <30 (79% reduction)
- All import paths corrected
- Function signatures aligned

---

## PHASE 3: FINAL CLEANUP (Sequential) - 15 minutes

### Agent Epsilon: Remaining Errors
**Goal:** Fix remaining errors = **~80 errors → 0 errors**

**Why Last:** Handles complex cases that previous agents couldn't fully resolve

**Strategy:**
1. Run build and collect all remaining errors
2. Analyze each error case-by-case
3. Apply appropriate fixes (manual review)

**Verification Command:**
```bash
npm run build 2>&1 | grep -c "error TS"
# Expected: 0
```

**Success Criteria:**
- All errors resolved
- Build passes with 0 errors
- No regressions introduced

---

## EXECUTION TIMELINE

| Phase | Agent | Duration | Errors Fixed | Cumulative Remaining |
|-------|-------|----------|--------------|---------------------|
| Baseline | - | - | - | 1025 |
| 1 | Alpha | 10 min | 316 | 709 |
| 2 | Beta | 20 min | 246 | 463 |
| 2 | Gamma | 20 min | 170 | 293 |
| 2 | Delta | 20 min | 112 | 181 |
| 3 | Epsilon | 15 min | 181 | **0** |

**Total Time:** 45 minutes (Phase 2 agents run in parallel)
**Success Rate:** 100% (all 1025 errors fixed)

---

## VERIFICATION CHECKLIST

**After Phase 1:**
- [ ] TS6133 count: 279 → 0
- [ ] TS6192 count: 37 → 0
- [ ] Total errors: 1025 → 709
- [ ] No new errors introduced

**After Phase 2:**
- [ ] TS2305 count: 246 → 0 (Agent Beta)
- [ ] TS2322+TS2345+TS2362 count: 220 → <50 (Agent Gamma)
- [ ] TS2554+TS2307+TS7006 count: 142 → <30 (Agent Delta)
- [ ] Total errors: 709 → ~80
- [ ] All agents met their goals

**After Phase 3:**
- [ ] All error counts: → 0
- [ ] Build passes: `npm run build` succeeds
- [ ] TypeCheck passes: `npm run typecheck` succeeds
- [ ] No compilation errors remain

---

## ROLLBACK PLAN

**Before starting each phase:**
```bash
git add .
git commit -m "chore: checkpoint before Phase X"
```

**If phase fails or makes things worse:**
```bash
git reset --hard HEAD~1  # Rollback last commit
# Analyze what went wrong
# Revise agent strategy
# Try again
```

---

## SUCCESS METRICS

**Primary Goals:**
- ✅ All 1025 errors fixed (100% success rate)
- ✅ 0 new errors introduced
- ✅ Build passes without errors

**Secondary Goals:**
- ⏱️ Completed within 60 minutes
- 📊 Each agent meets their reduction goal (±10%)
- 🔧 <20% of errors require manual review in Phase 3

---

## NOTES

**Key Insights:**
- Most errors (316) are unused imports - safe to remove
- Index files export things that don't exist (246) - just remove exports
- Type mismatches follow patterns (TokenCountResult, Buffer→String)
- Dependency injection pattern means tools don't need to import resources

**Lessons Learned:**
- Don't make bulk changes without comprehensive analysis
- Verify error count after each major change
- Use measurable goals to track progress
- Parallel execution is safe when agents work on independent code

**Created by:** Sequential Thinking MCP analysis
**Last Updated:** 2025-10-14 14:45 UTC
