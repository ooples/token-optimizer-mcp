# CI/CD Quick Start Guide

Get your CI/CD pipeline up and running in under 10 minutes.

## Prerequisites

- [x] Git repository initialized
- [x] Node.js 18+ installed
- [x] npm account created (https://www.npmjs.com/)
- [x] GitHub repository created (ooples/token-optimizer-mcp)

## Step 1: Install Dependencies (2 minutes)

```bash
cd C:\Users\cheat\source\repos\token-optimizer-mcp
npm install
```

This installs all CI/CD dependencies including:
- semantic-release
- commitlint
- conventional-changelog

## Step 2: Configure NPM Token (3 minutes)

1. **Get your npm token**:
   - Go to https://www.npmjs.com/settings/ooples/tokens
   - Click "Generate New Token" → "Classic Token"
   - Select type: **Automation**
   - Copy the token (starts with `npm_`)

2. **Add to GitHub**:
   - Go to https://github.com/ooples/token-optimizer-mcp/settings/secrets/actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Paste your token
   - Click "Add secret"

## Step 3: Run Verification Script (1 minute)

### Windows (PowerShell)
```powershell
.\.github\verify-setup.ps1
```

### Linux/Mac (Bash)
```bash
chmod +x .github/verify-setup.sh
./.github/verify-setup.sh
```

**Expected Output**: All checks should pass ✓

## Step 4: Create Test PR (2 minutes)

```bash
# Create test branch
git checkout -b test/ci-verification

# Make a small change
echo "# CI/CD Pipeline Active" >> .github/CI_VERIFIED.md

# Commit with conventional format
git add .
git commit -m "docs: verify CI/CD pipeline setup"

# Push
git push origin test/ci-verification
```

## Step 5: Create Pull Request (1 minute)

### Using GitHub CLI
```bash
gh pr create --title "docs: verify CI/CD pipeline" \
  --body "This PR verifies the CI/CD pipeline is working correctly."
```

### Using GitHub Web UI
1. Go to https://github.com/ooples/token-optimizer-mcp/pulls
2. Click "New pull request"
3. Base: master, Compare: test/ci-verification
4. Click "Create pull request"

## Step 6: Watch CI Run (10-15 minutes)

**What to expect**:
- ✅ CI workflow runs (~10-15 min)
- ✅ Quality gates workflow runs (~10 min)
- ✅ Commitlint workflow runs (~1 min)
- ✅ All checks should pass

**View progress**:
- Go to: https://github.com/ooples/token-optimizer-mcp/actions

## Step 7: Set Up Branch Protection (2 minutes)

1. Go to: https://github.com/ooples/token-optimizer-mcp/settings/branches
2. Click "Add rule"
3. Branch name pattern: `master`
4. Enable:
   - ✅ Require a pull request before merging (1 approval)
   - ✅ Require status checks to pass before merging
   - ✅ Require branches to be up to date
   - ✅ Require conversation resolution
   - ✅ Require linear history
   - ✅ Do not allow bypassing
   - ❌ Allow force pushes (DISABLED)
   - ❌ Allow deletions (DISABLED)
5. Select these required checks:
   - lint-and-format
   - build
   - test (18)
   - test (20)
   - test (22)
   - performance-benchmarks
   - integration-test
   - bundle-size
   - security-audit
   - license-compliance
   - commitlint
6. Click "Create" or "Save changes"

## Step 8: Merge and Test Release (10 minutes)

1. **Get PR approval**: Get a team member to review and approve
2. **Merge PR**: Click "Squash and merge" on GitHub
3. **Watch release**: Go to Actions tab, watch release workflow run
4. **Verify release**:
   - Check GitHub Releases: https://github.com/ooples/token-optimizer-mcp/releases
   - Check npm: `npm view token-optimizer-mcp`
   - Check CHANGELOG.md was updated

## Quick Troubleshooting

### Issue: CI checks not appearing

**Solution**: Wait for workflows to run at least once, then refresh branch protection settings.

### Issue: NPM publish fails

**Solution**:
1. Verify NPM_TOKEN is correct
2. Check token hasn't expired
3. Ensure token is "Automation" type

### Issue: No release created

**Solution**:
1. Ensure commits follow conventional format (`feat:`, `fix:`, etc.)
2. Check `.releaserc.json` is valid
3. Review workflow logs for errors

## Next Steps

### Immediate
- [x] CI/CD pipeline is active
- [x] First release published
- [ ] Create bundle size baseline: `npm run build && du -sb dist | cut -f1 > .github/bundle-size-baseline.txt`
- [ ] Add Codecov token (optional)
- [ ] Set up Discord/Slack notifications (optional)

### This Week
- [ ] Add more tests to reach 80% coverage
- [ ] Create integration tests
- [ ] Create benchmark tests
- [ ] Train team on conventional commits

### Ongoing
- [ ] Review Dependabot PRs weekly
- [ ] Monitor CI success rate
- [ ] Track bundle size trends
- [ ] Keep dependencies up to date

## Helpful Commands

```bash
# Run tests locally
npm test
npm run test:coverage

# Build locally
npm run build

# Lint locally
npm run lint
npm run format:check

# Commit with conventional format
git commit -m "feat(scope): description"
git commit -m "fix(scope): description"
git commit -m "docs: description"

# Create release manually (emergency)
npm version patch  # or minor, major
git push && git push --tags
npm publish
```

## Resources

- **Full Documentation**: [.github/README.md](.github/README.md)
- **Setup Guide**: [.github/setup-ci.md](.github/setup-ci.md)
- **Branch Protection**: [.github/BRANCH_PROTECTION.md](.github/BRANCH_PROTECTION.md)
- **Release Flow**: [.github/RELEASE_FLOW.md](.github/RELEASE_FLOW.md)
- **Secrets Template**: [.github/SECRETS_TEMPLATE.md](.github/SECRETS_TEMPLATE.md)

## Support

- **Issues**: https://github.com/ooples/token-optimizer-mcp/issues
- **Discussions**: https://github.com/ooples/token-optimizer-mcp/discussions

---

**Total Setup Time**: ~10 minutes (plus ~25 minutes waiting for CI/release)

**Ready to go!** Your CI/CD pipeline is now fully automated. 🎉
