# Release Automation Flow Diagram

This document visualizes the complete CI/CD pipeline from code change to production release.

## Overview

```
Developer → PR → CI Checks → Merge → Release → npm Publish → Notifications
```

## Detailed Flow

### 1. Development Phase

```
┌─────────────────────────────────────────────────────────────┐
│ Developer Workflow                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Create feature branch                                   │
│     git checkout -b feat/my-feature                         │
│                                                             │
│  2. Make changes and commit (conventional format)           │
│     git commit -m "feat(core): add new optimization"        │
│                                                             │
│  3. Push to GitHub                                          │
│     git push origin feat/my-feature                         │
│                                                             │
│  4. Create Pull Request                                     │
│     gh pr create --title "..." --body "..."                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2. Pull Request Phase

```
┌─────────────────────────────────────────────────────────────┐
│ Automated PR Checks (Parallel Execution)                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  CI Workflow (ci.yml)                                       │
│  ├── Lint & Format     (~2-3 min)                          │
│  ├── Build             (~2-3 min)                          │
│  ├── Test Matrix       (~5-8 min per Node version)         │
│  │   ├── Node 18                                           │
│  │   ├── Node 20                                           │
│  │   └── Node 22                                           │
│  ├── Performance       (~3-5 min)                          │
│  └── Integration       (~3-5 min)                          │
│                                                             │
│  Quality Gates (quality-gates.yml)                         │
│  ├── Bundle Size       (~2-3 min)                          │
│  ├── Security Audit    (~2-3 min)                          │
│  ├── License Check     (~2-3 min)                          │
│  ├── Vulnerabilities   (~2-3 min)                          │
│  └── Code Quality      (~1-2 min)                          │
│                                                             │
│  Commit Lint (commitlint.yml)                              │
│  └── Validate Commits  (~1-2 min)                          │
│                                                             │
│  ──────────────────────────────────────────────            │
│  Total Time: ~10-15 minutes (parallel)                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3. Review & Merge Phase

```
┌─────────────────────────────────────────────────────────────┐
│ Human Review Process                                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Required Actions:                                          │
│  ✓ All status checks passed                                 │
│  ✓ Code review approval (1 required)                        │
│  ✓ All conversations resolved                               │
│  ✓ Branch up to date with master                            │
│                                                             │
│  Merge Options:                                             │
│  • Squash and merge (recommended)                           │
│  • Rebase and merge                                         │
│  • Create merge commit (disabled by default)                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4. Release Phase (Automatic)

```
┌─────────────────────────────────────────────────────────────┐
│ Release Workflow (release.yml)                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Triggered by: Push to master (after PR merge)             │
│                                                             │
│  Step 1: Semantic Release Job                               │
│  ├── Checkout code                                          │
│  ├── Install dependencies                                   │
│  ├── Build project                                          │
│  ├── Run tests                                              │
│  └── Semantic Release                                       │
│      ├── Analyze commits (conventional format)              │
│      ├── Determine version bump                             │
│      │   • fix: → patch (0.0.X)                            │
│      │   • feat: → minor (0.X.0)                           │
│      │   • BREAKING CHANGE: → major (X.0.0)                │
│      ├── Generate CHANGELOG.md                              │
│      ├── Update package.json version                        │
│      ├── Create Git tag (e.g., v0.2.1)                     │
│      ├── Commit changes                                     │
│      └── Create GitHub Release                              │
│                                                             │
│  Step 2: Publish to npm Job (if release created)            │
│  ├── Checkout tagged version                                │
│  ├── Install dependencies                                   │
│  ├── Build for production                                   │
│  ├── Update package version                                 │
│  ├── npm publish --access public                            │
│  └── Verify publication                                     │
│                                                             │
│  Step 3: Notify Job (if published)                          │
│  ├── Get release notes                                      │
│  ├── Post to Discord (if configured)                        │
│  ├── Post to Slack (if configured)                          │
│  ├── Comment on related issues                              │
│  └── Update release summary                                 │
│                                                             │
│  ──────────────────────────────────────────────            │
│  Total Time: ~6-10 minutes                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5. Post-Release Phase

```
┌─────────────────────────────────────────────────────────────┐
│ Notifications & Updates                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  GitHub Release                                             │
│  ✓ Release notes generated                                  │
│  ✓ Tag created (e.g., v0.2.1)                              │
│  ✓ Assets uploaded (dist/, CHANGELOG.md)                   │
│  ✓ Related issues labeled "released"                        │
│  ✓ Comments added to closed issues                          │
│                                                             │
│  npm Registry                                               │
│  ✓ Package published                                        │
│  ✓ Version available: npm install token-optimizer-mcp      │
│  ✓ README displayed on npm                                  │
│                                                             │
│  Notifications (if configured)                              │
│  ✓ Discord webhook posted                                   │
│  ✓ Slack webhook posted                                     │
│                                                             │
│  Repository Updates                                         │
│  ✓ CHANGELOG.md updated                                     │
│  ✓ package.json version bumped                              │
│  ✓ package-lock.json updated                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Decision Tree: Version Determination

```
┌─────────────────────────────────────────────────────────────┐
│ Semantic Release Decision Tree                              │
└─────────────────────────────────────────────────────────────┘

Has BREAKING CHANGE in commit?
├── YES → Major Version Bump (X.0.0)
│         Example: 0.2.0 → 1.0.0
└── NO
    │
    Has feat: commit?
    ├── YES → Minor Version Bump (0.X.0)
    │         Example: 0.2.0 → 0.3.0
    └── NO
        │
        Has fix: commit?
        ├── YES → Patch Version Bump (0.0.X)
        │         Example: 0.2.0 → 0.2.1
        └── NO
            │
            Only chore:/docs:/style: commits?
            └── YES → No Release Created
                      (No version bump)
```

## Commit Type Examples

```
┌────────────────────┬──────────────────┬────────────────────┐
│ Commit Type        │ Version Impact   │ Example            │
├────────────────────┼──────────────────┼────────────────────┤
│ feat:              │ Minor (0.X.0)    │ feat: add OAuth    │
│ fix:               │ Patch (0.0.X)    │ fix: resolve leak  │
│ perf:              │ Patch (0.0.X)    │ perf: optimize     │
│ refactor:          │ Patch (0.0.X)    │ refactor: simplify │
│ docs:              │ None             │ docs: update README│
│ style:             │ None             │ style: format code │
│ test:              │ None             │ test: add coverage │
│ chore:             │ None             │ chore: update deps │
│ ci:                │ None             │ ci: fix workflow   │
│ BREAKING CHANGE:   │ Major (X.0.0)    │ See below          │
└────────────────────┴──────────────────┴────────────────────┘

Breaking Change Examples:

1. With footer:
   feat: remove deprecated API

   BREAKING CHANGE: Old API endpoints no longer supported

2. With ! syntax:
   feat!: redesign authentication flow

   This changes the auth interface completely
```

## Status Check Dependencies

```
┌─────────────────────────────────────────────────────────────┐
│ PR Merge Requirements                                       │
└─────────────────────────────────────────────────────────────┘

All of the following must be GREEN:

 ✓ lint-and-format          (CI)
 ✓ build                    (CI)
 ✓ test (Node 18)           (CI)
 ✓ test (Node 20)           (CI)
 ✓ test (Node 22)           (CI)
 ✓ performance-benchmarks   (CI)
 ✓ integration-test         (CI)
 ✓ bundle-size              (Quality Gates)
 ✓ security-audit           (Quality Gates)
 ✓ license-compliance       (Quality Gates)
 ✓ dependency-vulnerabilities (Quality Gates)
 ✓ code-quality             (Quality Gates)
 ✓ commitlint               (Commit Lint)

Plus:

 ✓ 1 approval from reviewer
 ✓ All conversations resolved
 ✓ Branch up to date with master
```

## Timeline Example

```
Day 1: Monday
09:00 - Developer creates feature branch
10:00 - Makes changes, commits with conventional format
10:30 - Pushes and creates PR
10:35 - CI/CD checks start running (parallel)
10:50 - All checks pass (15 minutes)
11:00 - Code review by team member
14:00 - Reviewer approves PR
14:05 - Developer merges PR
14:10 - Release workflow triggers
14:20 - New version released to npm (10 minutes)
14:25 - Notifications sent
14:30 - Package available: npm install token-optimizer-mcp
```

## Rollback Procedure

If a release needs to be rolled back:

```
1. Identify the problem
   - Check GitHub releases
   - Check npm package versions

2. Unpublish from npm (within 72 hours)
   npm unpublish token-optimizer-mcp@0.2.1

   Or deprecate:
   npm deprecate token-optimizer-mcp@0.2.1 "Critical bug, use 0.2.0"

3. Revert changes in Git
   git revert <commit-hash>
   git push origin master

4. Create hotfix PR
   - Fix the issue
   - Follow normal PR process
   - Merge and release

5. Communicate
   - Update GitHub release notes
   - Post announcement
   - Update documentation
```

## Monitoring Dashboard

Track release health:

```
Key Metrics:
├── CI Success Rate: Target >95%
├── Average CI Time: Target <15 min
├── Release Frequency: ~Weekly
├── Test Coverage: Target >80%
├── Bundle Size: Monitor trends
├── Security Vulnerabilities: 0 critical
└── Dependency Freshness: <6 months old
```

## Emergency Hotfix Flow

```
Critical bug in production:

1. Create hotfix branch from master
   git checkout master
   git pull
   git checkout -b hotfix/critical-bug

2. Fix the bug
   git commit -m "fix: resolve critical security issue"

3. Fast-track PR
   - Create PR
   - Get immediate review
   - Override checks if necessary (admin only)

4. Merge and release
   - Merge to master
   - Release workflow runs
   - Patch version bumped automatically

5. Backport if needed
   - Cherry-pick to maintenance branches
```

## Related Documentation

- [Setup Guide](./setup-ci.md)
- [GitHub Actions README](./README.md)
- [Branch Protection Rules](./BRANCH_PROTECTION.md)
