# Pipeline Fixes - Permanent Solutions

## Executive Summary

This document outlines the root causes and permanent fixes for all pipeline issues in the token-optimizer-mcp repository.

## Issues Fixed

### 1. Release Pipeline Automation ✅

**Root Cause**:
- `.releaserc.json` had `npmPublish: false`, preventing semantic-release from publishing to npm
- Separate `publish` job in `release.yml` was meant to handle npm publishing
- However, the publish job depended on `needs.release.outputs.new_release_published == 'true'`
- This output variable wasn't being set correctly when npmPublish was false
- Created a circular dependency and redundant workflow logic

**Solution**:
1. Changed `.releaserc.json`: `npmPublish: false` → `npmPublish: true`
2. Removed redundant `publish` job from `release.yml`
3. Updated `notify` job to only depend on `release` job
4. Added `draftRelease: false` to prevent draft GitHub releases

**Impact**:
- ✅ Fully automated npm publishing via semantic-release
- ✅ GitHub releases published immediately (not drafts)
- ✅ Simplified workflow - single source of truth (semantic-release)
- ✅ Proper output variables set for downstream jobs

### 2. Codex Auto-Fix Workflow ✅

**Root Cause**:
- Workflow is actually working as designed
- Only triggers on `conclusion == 'failure'` (not success or cancelled)
- Skips master branch to avoid branch protection conflicts
- Recent workflows either succeeded or ran on master
- No actual failures on feature branches to fix

**Current State**:
- ✅ Workflow configuration is correct
- ✅ OPENAI_API_KEY secret is configured
- ✅ Will trigger on next real failure on non-master branch

**No changes needed** - workflow is functioning correctly.

### 3. Version 2.4.1 Publishing

**Root Cause**:
- All recent commits used `ci:` type
- Per `.releaserc.json`, `ci:` commits don't trigger releases
- Only `feat:`, `fix:`, `refactor:`, `perf:` trigger releases

**Solution**:
- This PR uses `fix:` type to trigger a patch release
- Will automatically publish version 2.4.1 when merged to master

**Release Types**:
```
feat: → minor version bump (2.4.0 → 2.5.0)
fix: → patch version bump (2.4.0 → 2.4.1) ← THIS PR
refactor: → patch version bump
perf: → patch version bump
ci:, chore:, docs: → NO release
BREAKING CHANGE → major version bump (2.4.0 → 3.0.0)
```

## Files Modified

### `.releaserc.json`
```diff
[
  "@semantic-release/npm",
  {
-   "npmPublish": false
+   "npmPublish": true
  }
],
[
  "@semantic-release/github",
  {
    "assets": [
      { "path": "dist/**", "label": "Distribution files" }
    ],
+   "draftRelease": false,
    "successComment": "...",
    ...
  }
]
```

### `.github/workflows/release.yml`
```diff
- Removed entire `publish` job (lines 63-114)
- Updated `notify` job:
-   needs: [release, publish]
+   needs: release
```

## Verification Steps

After this PR is merged:

1. **Verify Release Creation**:
   ```bash
   gh release view v2.4.1
   # Should show published release (not draft)
   ```

2. **Verify npm Publication**:
   ```bash
   npm view token-optimizer-mcp version
   # Should show 2.4.1
   ```

3. **Verify GitHub Release**:
   - Visit https://github.com/ooples/token-optimizer-mcp/releases
   - v2.4.1 should be published (not draft)
   - Should include dist/** assets

4. **Test Codex Auto-Fix** (optional):
   - Create feature branch
   - Introduce a linting error
   - Push to trigger CI failure
   - Codex should create PR with fix

## Future Release Process

### Automated (Recommended)
1. Make changes on feature branch
2. Create PR with conventional commit type:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `refactor:` for code improvements
   - `ci:` or `chore:` for non-release changes
3. Merge to master
4. Semantic-release automatically:
   - Analyzes commits
   - Bumps version
   - Updates package.json
   - Creates GitHub release
   - Publishes to npm
   - Posts notifications

### Manual (Emergency Only)
If you need to force a release:
```bash
# Set NPM_TOKEN environment variable
export NPM_TOKEN=your-token

# Run semantic-release locally
npx semantic-release --no-ci
```

## Maintenance

### To Skip CI on a Commit
Add `[skip ci]` to commit message:
```bash
git commit -m "chore: update docs [skip ci]"
```

### To Force a Specific Release Type
Use conventional commit footers:
```bash
git commit -m "fix: critical bug

BREAKING CHANGE: API signature changed"
# This creates a major release despite being a "fix" type
```

### To Update Baseline Versions
Edit `.releaserc.json` release rules if you need different semver behavior.

## Breaking Changes

None - all changes are backwards compatible.

## Rollback Plan

If issues occur:
1. Revert this PR
2. Previous workflow will be restored
3. Manual npm publishing will be required

## Testing

- ✅ Local semantic-release dry-run
- ✅ Workflow syntax validation
- ✅ Secret verification
- ⏳ End-to-end test (will occur on merge)

## Questions?

Contact: @ooples
