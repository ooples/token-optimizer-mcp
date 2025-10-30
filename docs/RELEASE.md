# Release Process

This document describes the release process for Token Optimizer MCP, including automated releases via semantic-release and manual procedures when needed.

## Table of Contents

- [Automated Release Process](#automated-release-process)
- [Manual Release Steps](#manual-release-steps)
- [Registry Publishing](#registry-publishing)
- [Post-Release Checklist](#post-release-checklist)
- [Rollback Procedures](#rollback-procedures)

## Automated Release Process

Token Optimizer MCP uses **semantic-release** to automate version management and package publishing.

### How It Works

1. **Commit Analysis**
   - On merge to `main` branch, semantic-release analyzes commits
   - Follows [Conventional Commits](https://www.conventionalcommits.org/) specification
   - Determines version bump based on commit messages

2. **Version Determination**

   | Commit Type | Version Bump | Example |
   |-------------|--------------|---------|
   | `fix:` | Patch (0.0.x) | `fix(cache): resolve memory leak` |
   | `feat:` | Minor (0.x.0) | `feat(tools): add smart compression` |
   | `BREAKING CHANGE:` | Major (x.0.0) | `feat!: redesign cache API` |
   | `perf:` | Patch (0.0.x) | `perf(token): optimize counting` |
   | `docs:`, `chore:` | No release | Documentation/maintenance only |

3. **Release Workflow**
   ```
   Commit to main
   → CI/CD triggered
   → semantic-release runs
   → Version calculated
   → CHANGELOG.md updated
   → package.json version bumped
   → Git tag created
   → npm package published
   → GitHub release created
   → Docker image built (optional)
   ```

### Commit Message Format

**Standard Format:**
```
<type>(<scope>): <short summary>

<body>

<footer>
```

**Examples:**

```bash
# Patch release (0.0.x)
fix(cache): prevent duplicate cache entries
docs(readme): fix installation instructions

# Minor release (0.x.0)
feat(tools): add sentiment analysis tool
feat(api): implement GraphQL optimization

# Major release (x.0.0)
feat(cache)!: redesign cache API

BREAKING CHANGE: Cache API now uses async/await instead of callbacks
```

**Breaking Changes:**
- Add `!` after type: `feat!:` or `fix!:`
- Include `BREAKING CHANGE:` in footer
- Clearly describe the breaking change

### Triggering a Release

1. **Merge PR to main**
   ```bash
   # After PR approval
   git checkout main
   git pull origin main
   ```

2. **CI/CD automatically**
   - Runs all tests
   - Checks code quality
   - Analyzes commits
   - Publishes if needed

3. **Monitor Release**
   - Check [GitHub Actions](https://github.com/ooples/token-optimizer-mcp/actions)
   - Verify npm publish succeeded
   - Review generated CHANGELOG

### Configuration Files

- **.releaserc.json** - semantic-release configuration
- **package.json** - Version and metadata
- **.github/workflows/release.yml** - CI/CD workflow

## Manual Release Steps

Use manual release only when automation fails or for special releases.

### Prerequisites

1. **Permissions**
   - Maintainer access to repository
   - npm publish rights for `@ooples` scope
   - GitHub release creation access

2. **Environment Setup**
   ```bash
   # Verify npm authentication
   npm whoami

   # Ensure clean working directory
   git status

   # On main branch, up to date
   git checkout main
   git pull origin main
   ```

### Manual Release Procedure

1. **Version Bump**
   ```bash
   # Patch release (0.0.x)
   npm version patch -m "chore(release): %s"

   # Minor release (0.x.0)
   npm version minor -m "chore(release): %s"

   # Major release (x.0.0)
   npm version major -m "chore(release): %s"
   ```

2. **Update CHANGELOG**
   ```bash
   # Manually edit CHANGELOG.md
   # Add version, date, and changes
   # Follow Keep a Changelog format
   ```

3. **Build Package**
   ```bash
   # Clean build
   npm run clean
   npm run build

   # Run all tests
   npm test

   # Check package contents
   npm pack --dry-run
   ```

4. **Publish to npm**
   ```bash
   # Publish to npm
   npm publish --access public

   # Verify publication
   npm view token-optimizer-mcp
   ```

5. **Push Git Tags**
   ```bash
   # Push version commit and tag
   git push origin main --follow-tags
   ```

6. **Create GitHub Release**
   ```bash
   # Using GitHub CLI
   gh release create v0.2.0 \
     --title "v0.2.0" \
     --notes-file CHANGELOG.md

   # Or manually via GitHub web interface
   ```

### Emergency Hotfix Release

For critical bug fixes:

1. **Create Hotfix Branch**
   ```bash
   git checkout -b hotfix/critical-bug main
   ```

2. **Make Fix**
   ```bash
   # Fix the bug
   # Add tests
   # Commit with fix: prefix
   git commit -m "fix: critical security vulnerability"
   ```

3. **Version Bump**
   ```bash
   npm version patch
   ```

4. **Publish**
   ```bash
   npm run build
   npm test
   npm publish
   ```

5. **Merge Back**
   ```bash
   git checkout main
   git merge hotfix/critical-bug
   git push origin main
   ```

## Registry Publishing

After npm publication, update MCP registries.

### Official MCP Registry

1. **Create Registry Entry**
   - Navigate to [MCP Registry](https://github.com/modelcontextprotocol/registry)
   - Fork the repository
   - Add entry in `registry/servers.json`

2. **Registry Format**
   ```json
   {
     "name": "token-optimizer-mcp",
     "version": "0.2.0",
     "repository": "https://github.com/ooples/token-optimizer-mcp",
     "npm": "token-optimizer-mcp",
     "description": "Intelligent token optimization achieving 95%+ reduction",
     "categories": ["optimization", "caching", "compression"]
   }
   ```

3. **Submit PR**
   - Create PR to MCP registry
   - Wait for review and merge

### Smithery

1. **Login to Smithery**
   - Visit [Smithery](https://smithery.ai)
   - Sign in with GitHub

2. **Submit Server**
   - Click "Add Server"
   - Fill form with package details
   - Upload screenshots/demo
   - Submit for review

### MCP Hub (Community)

1. **Create Listing**
   - Visit [MCP Hub](https://mcp-hub.com)
   - Submit new server listing
   - Include installation guide

2. **Update Documentation**
   - Link to GitHub repo
   - Add usage examples
   - Include configuration snippets

### Docker Hub (Optional)

If Docker images are published:

```bash
# Build image
docker build -t ooples/token-optimizer-mcp:0.2.0 .
docker build -t ooples/token-optimizer-mcp:latest .

# Push to Docker Hub
docker push ooples/token-optimizer-mcp:0.2.0
docker push ooples/token-optimizer-mcp:latest
```

## Post-Release Checklist

After publishing a release:

### Verification

- [ ] **npm package available**
  ```bash
  npm view token-optimizer-mcp
  npm install -g token-optimizer-mcp
  ```

- [ ] **Test installation**
  ```bash
  npx token-optimizer-mcp --version
  # Test basic functionality
  ```

- [ ] **GitHub release created**
  - Check [Releases page](https://github.com/ooples/token-optimizer-mcp/releases)
  - Verify release notes
  - Check attached assets

- [ ] **CHANGELOG updated**
  - Review CHANGELOG.md
  - Ensure all changes listed
  - Verify formatting

### Registry Updates

- [ ] **MCP Registry**
  - PR submitted or merged
  - Server listed on official registry

- [ ] **Smithery**
  - Server approved
  - Listing visible

- [ ] **Documentation Updated**
  - README.md reflects new version
  - Migration guide (if breaking changes)
  - API documentation current

### Communication

- [ ] **Announce Release**
  - GitHub Discussions (if used)
  - Social media (optional)
  - Relevant communities

- [ ] **Update Examples**
  - README examples work with new version
  - Code snippets updated
  - Configuration examples current

### Monitoring

- [ ] **Check npm downloads**
  - Monitor download stats
  - Watch for error reports

- [ ] **Monitor Issues**
  - Watch for bug reports
  - Respond to questions
  - Track feedback

## Rollback Procedures

If a release has critical issues:

### npm Deprecation

```bash
# Deprecate specific version
npm deprecate token-optimizer-mcp@0.2.0 "Critical bug - use 0.1.9 instead"

# Deprecate and redirect
npm deprecate token-optimizer-mcp@0.2.0 "Please upgrade to 0.2.1"
```

### Publish Patch Release

```bash
# Fix the issue
git checkout -b fix/critical-issue

# Make changes, test
npm version patch
npm publish

# Announce fix
gh release create v0.2.1 --notes "Hotfix for critical issue in 0.2.0"
```

### Unpublish (Last Resort)

**Warning**: Only use within 72 hours of publish, and only for severe security issues.

```bash
# Unpublish specific version (avoid if possible)
npm unpublish token-optimizer-mcp@0.2.0

# Note: This breaks existing installations
```

### Communication Template

```markdown
## Critical Issue in v0.2.0

We've identified a critical issue in version 0.2.0 that affects [describe impact].

**Action Required:**
- If using v0.2.0, upgrade to v0.2.1 immediately
- Run: `npm install token-optimizer-mcp@latest`

**Details:**
[Explain the issue and fix]

**Timeline:**
- v0.2.0 released: [date]
- Issue discovered: [date]
- v0.2.1 hotfix released: [date]

We apologize for any inconvenience.
```

## Versioning Strategy

We follow [Semantic Versioning 2.0.0](https://semver.org/):

- **Major (x.0.0)**: Breaking changes, API redesigns
- **Minor (0.x.0)**: New features, backward compatible
- **Patch (0.0.x)**: Bug fixes, backward compatible

### Pre-releases

For testing before stable release:

```bash
# Alpha release
npm version prerelease --preid=alpha
# Results in: 0.2.0-alpha.0

# Beta release
npm version prerelease --preid=beta
# Results in: 0.2.0-beta.0

# Publish with tag
npm publish --tag beta
```

### Version Lifecycle

- **Alpha**: Internal testing, unstable
- **Beta**: Public testing, feature complete
- **RC** (Release Candidate): Final testing before stable
- **Stable**: Production-ready release

## Additional Resources

- [semantic-release documentation](https://semantic-release.gitbook.io/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [npm Publishing Guide](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [Semantic Versioning](https://semver.org/)

## Support

For release-related questions:
- Open an issue: [GitHub Issues](https://github.com/ooples/token-optimizer-mcp/issues)
- Contact maintainers: See [CONTRIBUTING.md](./CONTRIBUTING.md)
