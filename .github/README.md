# GitHub Actions CI/CD Documentation

This repository uses GitHub Actions for automated CI/CD with comprehensive quality gates, automated releases, and dependency management.

## Table of Contents

- [Overview](#overview)
- [Workflows](#workflows)
- [Setup Instructions](#setup-instructions)
- [Status Checks](#status-checks)
- [Release Process](#release-process)
- [Secrets and Variables](#secrets-and-variables)
- [Troubleshooting](#troubleshooting)

## Overview

Our CI/CD pipeline includes:
- **Continuous Integration**: Automated testing, linting, and quality checks on every PR
- **Quality Gates**: Bundle size tracking, security audits, license compliance
- **Automated Releases**: Semantic versioning and npm publishing
- **Dependency Management**: Automated dependency updates via Dependabot

## Workflows

### 1. CI Workflow (`.github/workflows/ci.yml`)

**Triggers**: Pull requests and pushes to `master`

**Jobs**:

#### `lint-and-format`
- Runs ESLint on TypeScript files
- Checks Prettier formatting
- Validates package.json
- **Runtime**: ~2-3 minutes
- **Node Version**: 20

#### `build`
- Compiles TypeScript to JavaScript
- Verifies build artifacts (dist/)
- Uploads build artifacts for use in other jobs
- **Runtime**: ~2-3 minutes
- **Node Version**: 20

#### `test`
- Runs unit tests across multiple Node versions (18, 20, 22)
- Generates code coverage reports
- Uploads coverage to Codecov
- Enforces 80% coverage threshold
- **Runtime**: ~5-8 minutes per Node version
- **Matrix Strategy**: Parallel execution across Node versions

#### `performance-benchmarks`
- Runs performance benchmark suite
- Compares results against baseline
- Fails if performance regression >10%
- Posts results as PR comment
- **Runtime**: ~3-5 minutes
- **Node Version**: 20

#### `integration-test`
- Starts MCP server
- Runs integration tests against live server
- Uploads logs on failure
- **Runtime**: ~3-5 minutes
- **Node Version**: 20
- **Depends On**: `build` job

#### `status-check`
- Aggregates all job results
- Final gate before PR can be merged
- **Runtime**: <1 minute
- **Depends On**: All other jobs

**Total CI Runtime**: ~10-15 minutes (with parallelization)

### 2. Release Workflow (`.github/workflows/release.yml`)

**Triggers**: Push to `master` (after PR merge)

**Jobs**:

#### `release`
- Analyzes commits using conventional commit format
- Determines version bump (major/minor/patch)
- Generates CHANGELOG.md
- Creates Git tag
- Creates GitHub Release
- **Runtime**: ~3-5 minutes
- **Node Version**: 20

#### `publish`
- Publishes package to npm
- Verifies publication
- Only runs if new release was created
- **Runtime**: ~2-3 minutes
- **Node Version**: 20
- **Depends On**: `release` job

#### `notify`
- Posts release announcement (Discord/Slack if configured)
- Comments on related issues
- Updates release summary
- **Runtime**: ~1-2 minutes
- **Depends On**: `release`, `publish` jobs

**Total Release Runtime**: ~6-10 minutes

### 3. Quality Gates Workflow (`.github/workflows/quality-gates.yml`)

**Triggers**: Pull requests and pushes to `master`

**Jobs**:

#### `bundle-size`
- Analyzes compiled bundle size
- Compares against baseline
- Fails if size increases >5%
- Posts size comparison as PR comment
- **Runtime**: ~2-3 minutes

#### `security-audit`
- Runs `npm audit`
- Fails on critical vulnerabilities
- Warns on high vulnerabilities
- Posts audit results as PR comment
- **Runtime**: ~2-3 minutes

#### `license-compliance`
- Checks all dependency licenses
- Warns about copyleft licenses (GPL, AGPL, LGPL)
- Generates license report
- **Runtime**: ~2-3 minutes

#### `dependency-vulnerabilities`
- Runs Snyk scan (if configured)
- Checks for outdated dependencies
- Generates vulnerability report
- **Runtime**: ~2-3 minutes

#### `code-quality`
- Analyzes code complexity
- Counts lines of code
- Identifies TODO/FIXME comments
- **Runtime**: ~1-2 minutes

**Total Quality Gates Runtime**: ~9-14 minutes (parallel execution)

### 4. Commit Lint Workflow (`.github/workflows/commitlint.yml`)

**Triggers**: Pull requests

**Jobs**:

#### `commitlint`
- Validates all PR commits follow Conventional Commits format
- Posts format guide as PR comment on failure
- **Runtime**: ~1-2 minutes

### 5. Dependabot Configuration (`.github/dependabot.yml`)

**Schedule**: Weekly (Monday 9:00 AM UTC)

**Features**:
- Groups minor/patch updates for dev dependencies
- Groups patch updates for production dependencies
- Separate PRs for major version updates
- Auto-assigns to @ooples
- Labels: `dependencies`, `automated`

## Setup Instructions

### 1. Initial Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/ooples/token-optimizer-mcp.git
   cd token-optimizer-mcp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Install semantic-release and commitlint globally** (optional)
   ```bash
   npm install -g semantic-release @commitlint/cli
   ```

### 2. Configure GitHub Secrets

Navigate to: `Settings` > `Secrets and variables` > `Actions` > `New repository secret`

Add the following secrets:

#### Required Secrets

| Secret Name | Description | How to Get |
|------------|-------------|------------|
| `NPM_TOKEN` | npm authentication token | https://www.npmjs.com/settings/YOUR_USERNAME/tokens |
| `CODECOV_TOKEN` | Codecov upload token (optional) | https://codecov.io/ |

#### Optional Secrets

| Secret Name | Description | Use Case |
|------------|-------------|----------|
| `SNYK_TOKEN` | Snyk authentication token | Advanced security scanning |

### 3. Configure GitHub Variables (Optional)

Navigate to: `Settings` > `Secrets and variables` > `Actions` > `Variables` tab

| Variable Name | Description | Example |
|--------------|-------------|---------|
| `DISCORD_WEBHOOK_URL` | Discord webhook for release notifications | https://discord.com/api/webhooks/... |
| `SLACK_WEBHOOK_URL` | Slack webhook for release notifications | https://hooks.slack.com/services/... |

### 4. Set Up Branch Protection

Follow instructions in [BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md)

### 5. Initialize Performance Baseline

After first successful CI run:

1. Download the benchmark results artifact
2. Copy to `.github/performance-baseline.json`
3. Commit and push:
   ```bash
   git add .github/performance-baseline.json
   git commit -m "chore: add performance baseline"
   git push
   ```

### 6. Initialize Bundle Size Baseline

After first successful build:

1. Run: `du -sb dist | cut -f1 > .github/bundle-size-baseline.txt`
2. Commit and push:
   ```bash
   git add .github/bundle-size-baseline.txt
   git commit -m "chore: add bundle size baseline"
   git push
   ```

## Status Checks

All PRs must pass the following status checks before merging:

### Critical Checks (Must Pass)
- ✅ `lint-and-format` - Code style and linting
- ✅ `build` - TypeScript compilation
- ✅ `test (18)` - Tests on Node 18
- ✅ `test (20)` - Tests on Node 20
- ✅ `test (22)` - Tests on Node 22
- ✅ `commitlint` - Commit message format

### Quality Checks (Must Pass)
- ✅ `bundle-size` - Bundle size within limits
- ✅ `security-audit` - No critical vulnerabilities
- ✅ `license-compliance` - License compatibility

### Optional Checks (Can Warn)
- ⚠️ `performance-benchmarks` - Performance metrics
- ⚠️ `integration-test` - Integration test suite
- ⚠️ `code-quality` - Code metrics and analysis

## Release Process

### Automated Release Flow

1. **Developer creates PR with conventional commits**
   - Format: `type(scope): description`
   - Examples: `feat(auth): add OAuth`, `fix(api): resolve race condition`

2. **CI runs on PR**
   - All status checks must pass
   - Code review required
   - Conversations must be resolved

3. **PR is merged to master**
   - Release workflow triggers automatically
   - Semantic-release analyzes commits

4. **Version determination**
   - `fix:` commits → Patch version (0.0.X)
   - `feat:` commits → Minor version (0.X.0)
   - `BREAKING CHANGE:` → Major version (X.0.0)

5. **Automatic actions**
   - CHANGELOG.md updated
   - Version bumped in package.json
   - Git tag created (e.g., v0.2.1)
   - GitHub Release created
   - npm package published
   - Related issues commented

### Manual Release (Emergency)

If automated release fails:

```bash
# Ensure you're on master with latest changes
git checkout master
git pull

# Create version and tag
npm version patch -m "chore(release): %s"  # or minor/major

# Push changes and tags
git push && git push --tags

# Publish to npm
npm publish

# Create GitHub release manually
gh release create v0.2.1 --generate-notes
```

## Secrets and Variables

### Getting NPM Token

1. Log in to npm: https://www.npmjs.com/
2. Click your profile → "Access Tokens"
3. Click "Generate New Token" → "Classic Token"
4. Select "Automation" type
5. Copy token and add to GitHub Secrets as `NPM_TOKEN`

### Getting Codecov Token (Optional)

1. Visit https://codecov.io/
2. Sign in with GitHub
3. Add your repository
4. Copy the upload token
5. Add to GitHub Secrets as `CODECOV_TOKEN`

### Setting Up Notifications

#### Discord
1. Go to your Discord server settings
2. Navigate to "Integrations" → "Webhooks"
3. Create a new webhook
4. Copy the webhook URL
5. Add to GitHub Variables as `DISCORD_WEBHOOK_URL`

#### Slack
1. Go to https://api.slack.com/apps
2. Create a new app or select existing
3. Enable "Incoming Webhooks"
4. Add webhook to workspace
5. Copy the webhook URL
6. Add to GitHub Variables as `SLACK_WEBHOOK_URL`

## Troubleshooting

### CI Fails: "Coverage threshold not met"

**Solution**: Add more unit tests to reach 80% coverage

```bash
npm run test:coverage
# Check coverage/index.html for uncovered lines
```

### CI Fails: "Bundle size increased by >5%"

**Solution**: Optimize bundle or update baseline

```bash
# Check what's causing size increase
npm run build
du -h dist/

# If increase is justified, update baseline:
du -sb dist | cut -f1 > .github/bundle-size-baseline.txt
git add .github/bundle-size-baseline.txt
git commit -m "chore: update bundle size baseline"
```

### Release Fails: "No release published"

**Cause**: No conventional commits since last release

**Solution**: Ensure commits follow format:
- `feat:` for features
- `fix:` for bug fixes
- `BREAKING CHANGE:` for breaking changes

### NPM Publish Fails: "Authentication failed"

**Solution**: Verify NPM_TOKEN secret

1. Check token is still valid: https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Regenerate token if needed
3. Update GitHub secret

### Dependabot PRs Failing

**Solution**: Review and fix issues

```bash
# Checkout Dependabot branch
git fetch origin
git checkout dependabot/npm_and_yarn/...

# Fix any breaking changes
npm install
npm test

# Commit fixes
git commit -am "fix: resolve dependency conflicts"
git push
```

### Performance Benchmarks Failing

**Solution**: Investigate performance regression

1. Download benchmark artifacts from failed run
2. Compare with baseline
3. Profile the code to find bottleneck
4. Optimize or update baseline if acceptable

## Best Practices

### Commit Messages

✅ **Good**
```
feat(api): add token refresh endpoint
fix(cache): resolve memory leak in LRU cache
docs(readme): update installation instructions
refactor(core): simplify optimization logic
```

❌ **Bad**
```
Update code
Fix bug
WIP
changes
```

### PR Workflow

1. Create feature branch: `git checkout -b feat/my-feature`
2. Make changes with conventional commits
3. Push and create PR
4. Wait for all checks to pass
5. Get code review approval
6. Squash and merge (if needed)

### Testing Strategy

- Write unit tests for all new features
- Maintain 80%+ coverage
- Add integration tests for critical flows
- Update benchmarks for performance-sensitive code

### Dependency Updates

- Review Dependabot PRs weekly
- Test major version updates thoroughly
- Group minor/patch updates when possible
- Keep dependencies up to date for security

## Related Documentation

- [Branch Protection Rules](./BRANCH_PROTECTION.md)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Semantic Release](https://semantic-release.gitbook.io/)
- [GitHub Actions](https://docs.github.com/en/actions)

## Support

For issues with CI/CD:
1. Check GitHub Actions logs
2. Review this documentation
3. Open an issue: https://github.com/ooples/token-optimizer-mcp/issues
