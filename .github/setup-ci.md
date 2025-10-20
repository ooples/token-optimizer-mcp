# CI/CD Setup Guide

This guide walks you through setting up the complete CI/CD pipeline for token-optimizer-mcp.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

This will install all required dependencies including:
- semantic-release
- commitlint
- conventional-changelog

### 2. Configure GitHub Secrets

#### NPM_TOKEN (Required)

1. Go to https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Click "Generate New Token" → "Classic Token"
3. Select "Automation" type
4. Copy the token
5. Go to GitHub: Settings > Secrets and variables > Actions
6. Click "New repository secret"
7. Name: `NPM_TOKEN`
8. Value: Paste your token
9. Click "Add secret"

#### CODECOV_TOKEN (Optional but Recommended)

1. Go to https://codecov.io/
2. Sign in with GitHub
3. Click "Add repository"
4. Find `ooples/token-optimizer-mcp`
5. Copy the upload token
6. Add to GitHub Secrets as `CODECOV_TOKEN`

### 3. Configure GitHub Variables (Optional)

For release notifications:

#### Discord Webhook

```bash
# In GitHub: Settings > Secrets and variables > Actions > Variables tab
Name: DISCORD_WEBHOOK_URL
Value: https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

#### Slack Webhook

```bash
# In GitHub: Settings > Secrets and variables > Actions > Variables tab
Name: SLACK_WEBHOOK_URL
Value: https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### 4. Set Up Branch Protection

Follow the detailed instructions in [BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md)

**Quick Checklist**:
- [ ] Navigate to Settings > Branches
- [ ] Add rule for `master` branch
- [ ] Require 1 pull request approval
- [ ] Require status checks to pass
- [ ] Require branches to be up to date
- [ ] Require conversation resolution
- [ ] Enforce linear history
- [ ] Disable force push
- [ ] Disable deletion

### 5. Create Initial Baselines

#### Performance Baseline

The performance baseline already exists at `.github/performance-baseline.json` with placeholder values. It will be automatically updated after the first benchmark run.

To manually update after running benchmarks locally:

```bash
npm run test:benchmark > benchmark-results.txt
# Parse results and update .github/performance-baseline.json
git add .github/performance-baseline.json
git commit -m "chore: update performance baseline"
git push
```

#### Bundle Size Baseline

After first successful build:

```bash
npm run build
du -sb dist | cut -f1 > .github/bundle-size-baseline.txt
git add .github/bundle-size-baseline.txt
git commit -m "chore: add bundle size baseline"
git push
```

### 6. Test the CI Pipeline

Create a test pull request:

```bash
# Create a test branch
git checkout -b test/ci-pipeline

# Make a small change
echo "# Test" >> TEST.md

# Commit with conventional format
git add TEST.md
git commit -m "test: verify CI pipeline"

# Push
git push origin test/ci-pipeline
```

Create a PR on GitHub and verify:
- [ ] CI workflow runs
- [ ] Quality gates workflow runs
- [ ] Commitlint workflow runs
- [ ] All checks pass

### 7. Test the Release Pipeline

After merging your first PR with a `feat:` or `fix:` commit:

1. Watch the release workflow run
2. Verify GitHub release is created
3. Verify npm package is published
4. Check CHANGELOG.md was updated

## Verification Checklist

### GitHub Actions

- [ ] All workflow files are in `.github/workflows/`
- [ ] Workflows appear in Actions tab
- [ ] Secrets are configured
- [ ] Variables are configured (if using notifications)

### Branch Protection

- [ ] Cannot push directly to master
- [ ] Cannot merge PR without approval
- [ ] Cannot merge PR with failing checks
- [ ] All required status checks are listed

### Release Automation

- [ ] Semantic-release is configured
- [ ] NPM token is valid
- [ ] First release was created successfully
- [ ] Package appears on npm

### Dependency Management

- [ ] Dependabot is enabled
- [ ] First dependency PR created (wait 1 week or trigger manually)
- [ ] Dependabot PRs are labeled correctly

## Common Issues and Solutions

### Issue: NPM publish fails with 403

**Solution**:
- Verify NPM_TOKEN is correct
- Check token hasn't expired
- Ensure token has "Automation" type permissions
- Verify package name isn't taken on npm

### Issue: Semantic-release doesn't create a release

**Solution**:
- Ensure commits follow conventional commit format
- Check that you have at least one `feat:` or `fix:` commit since last release
- Verify `.releaserc.json` is valid JSON

### Issue: Coverage threshold not met

**Solution**:
- Run `npm run test:coverage` locally
- Check `coverage/index.html` for uncovered lines
- Add more tests to reach 80% coverage

### Issue: Codecov upload fails

**Solution**:
- Verify CODECOV_TOKEN is correct
- Check that repository is added to Codecov
- This is optional - remove from workflow if not using

### Issue: Status checks not appearing in branch protection

**Solution**:
- Workflows must run at least once for checks to appear
- Create a test PR to trigger all workflows
- Wait a few minutes for GitHub to register the checks
- Refresh the branch protection settings page

## Advanced Configuration

### Customize Release Rules

Edit `.releaserc.json` to customize version bumping:

```json
{
  "releaseRules": [
    { "type": "feat", "release": "minor" },
    { "type": "fix", "release": "patch" },
    { "type": "perf", "release": "patch" },
    { "breaking": true, "release": "major" }
  ]
}
```

### Customize Commit Lint Rules

Edit `.commitlintrc.json`:

```json
{
  "rules": {
    "type-enum": [2, "always", ["feat", "fix", "docs", "chore"]],
    "header-max-length": [2, "always", 100]
  }
}
```

### Customize Dependabot Schedule

Edit `.github/dependabot.yml`:

```yaml
schedule:
  interval: "daily"  # or "weekly", "monthly"
  time: "09:00"
  timezone: "America/New_York"
```

## Monitoring and Maintenance

### Weekly Tasks

- [ ] Review Dependabot PRs
- [ ] Check for security vulnerabilities
- [ ] Monitor bundle size trends
- [ ] Review code coverage metrics

### Monthly Tasks

- [ ] Review and update performance baselines
- [ ] Audit npm dependencies
- [ ] Check for outdated GitHub Actions
- [ ] Review and optimize workflow run times

### Quarterly Tasks

- [ ] Rotate secrets (NPM_TOKEN, etc.)
- [ ] Review branch protection rules
- [ ] Update CI/CD documentation
- [ ] Evaluate new quality tools

## Getting Help

- **Documentation**: [GitHub Actions README](./.github/README.md)
- **Issues**: https://github.com/ooples/token-optimizer-mcp/issues
- **Discussions**: https://github.com/ooples/token-optimizer-mcp/discussions

## Next Steps

After completing this setup:

1. Read the full [GitHub Actions README](./README.md)
2. Review [Branch Protection Rules](./BRANCH_PROTECTION.md)
3. Learn about [Conventional Commits](https://www.conventionalcommits.org/)
4. Explore [Semantic Release docs](https://semantic-release.gitbook.io/)
