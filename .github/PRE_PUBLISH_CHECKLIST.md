# Pre-Publish Checklist

Complete this checklist before publishing `token-optimizer-mcp` to npm.

## Version & Documentation

- [ ] **Version bumped** in `package.json`
  - Current version: `0.2.0`
  - Follow [Semantic Versioning](https://semver.org/)
  - MAJOR.MINOR.PATCH (e.g., 1.0.0)

- [ ] **CHANGELOG.md updated**
  - Added entry for new version
  - Listed all changes under proper categories (Added/Changed/Fixed/Removed)
  - Included date in format: YYYY-MM-DD
  - Added comparison link at bottom

- [ ] **README.md up to date**
  - Installation instructions accurate
  - All features documented
  - Examples work with current version
  - Badges/shields updated (if applicable)

- [ ] **LICENSE file present**
  - License type matches package.json (`MIT`)
  - Copyright year and author correct

## Code Quality

- [ ] **All tests passing**
  ```bash
  npm test
  ```

- [ ] **Test coverage >= 80%**
  ```bash
  npm run test:coverage
  ```
  - Check coverage report in `coverage/` directory

- [ ] **Linting passes**
  ```bash
  npm run lint
  ```

- [ ] **Code formatted**
  ```bash
  npm run format:check
  ```

- [ ] **Build successful**
  ```bash
  npm run build
  ```
  - Verify `dist/` directory exists
  - Check `dist/server/index.js` exists
  - Verify TypeScript declarations generated (`*.d.ts` files)

## Package Configuration

- [ ] **package.json fields complete**
  - [x] `name`: token-optimizer-mcp
  - [x] `version`: 0.2.0
  - [x] `description`: Meaningful description
  - [x] `main`: dist/server/index.js
  - [x] `types`: dist/server/index.d.ts
  - [x] `bin`: CLI entry point configured
  - [x] `files`: Specifies what to include
  - [x] `keywords`: npm search optimization
  - [x] `author`: ooples
  - [x] `license`: MIT
  - [x] `repository`: GitHub URL
  - [x] `engines`: Node.js >= 18.0.0

- [ ] **.npmignore configured**
  - Excludes source files (`src/`)
  - Excludes development files (tests, configs)
  - Excludes sensitive files (.env, secrets)
  - Includes only `dist/`, README, LICENSE, CHANGELOG

- [ ] **Entry point has shebang**
  - `dist/server/index.js` starts with: `#!/usr/bin/env node`

## Security & Privacy

- [ ] **No sensitive files in package**
  - No `.env` files
  - No API keys or tokens
  - No credentials or secrets
  - No database files
  - Run: `npm pack --dry-run` and review file list

- [ ] **Dependencies audited**
  ```bash
  npm audit
  ```
  - Fix all HIGH and CRITICAL vulnerabilities
  - Document any acceptable risks

- [ ] **No unnecessary files**
  - No `.git/` directory
  - No `node_modules/`
  - No development scripts or tooling
  - No temporary files

## Package Validation

- [ ] **Package size < 10MB**
  ```bash
  npm pack --dry-run
  ```
  - Review tarball contents
  - Check estimated size
  - Optimize if needed

- [ ] **Validation script passes**
  ```bash
  npm run validate
  ```
  - All required files present
  - No errors reported
  - Address any warnings

- [ ] **Dry-run publish successful**
  ```bash
  npm publish --dry-run
  ```
  - No errors in output
  - Review what will be published

- [ ] **Test local installation** (optional but recommended)
  ```bash
  bash scripts/test-install.sh
  ```
  - Package installs successfully
  - CLI entry point works
  - All dependencies included

## GitHub & CI/CD

- [ ] **All changes committed**
  ```bash
  git status
  ```
  - No uncommitted changes
  - Working directory clean

- [ ] **Branch up to date**
  ```bash
  git pull origin main
  ```

- [ ] **All CI/CD checks passing**
  - GitHub Actions green
  - All tests pass in CI
  - Build succeeds in CI

- [ ] **NPM_TOKEN configured**
  - Set as GitHub secret (for automated publishing)
  - Or available in local environment (for manual publishing)

## Final Steps

- [ ] **Create git tag**
  ```bash
  git tag -a v0.2.0 -m "Release version 0.2.0"
  git push origin v0.2.0
  ```

- [ ] **Publish to npm**
  ```bash
  npm publish
  ```

- [ ] **Verify published package**
  - Visit: https://www.npmjs.com/package/token-optimizer-mcp
  - Check version number
  - Verify README displays correctly
  - Test installation: `npm install token-optimizer-mcp`

- [ ] **Create GitHub Release**
  - Go to: https://github.com/ooples/token-optimizer-mcp/releases
  - Create new release for tag v0.2.0
  - Copy CHANGELOG entry to release notes
  - Publish release

## Post-Publish

- [ ] **Test global installation**
  ```bash
  npm install -g token-optimizer-mcp
  token-optimizer-mcp --version
  ```

- [ ] **Update documentation** (if needed)
  - Update any external docs
  - Update references in other projects

- [ ] **Announce release** (optional)
  - Social media
  - Discord/Slack communities
  - Project website

---

## Emergency Unpublish

If you need to unpublish (within 72 hours):

```bash
npm unpublish token-optimizer-mcp@0.2.0
```

**WARNING**: Unpublishing is permanent and discouraged. Use deprecation instead:

```bash
npm deprecate token-optimizer-mcp@0.2.0 "Reason for deprecation"
```

---

## Notes

- Publishing is **permanent** - you cannot overwrite an existing version
- Once published, a version cannot be deleted after 72 hours
- Always test thoroughly before publishing
- Consider publishing a pre-release version first (e.g., 0.2.0-beta.1)

**Pre-release workflow** (recommended for first publish):

```bash
# Update version to pre-release
npm version 0.2.0-beta.1

# Publish with beta tag
npm publish --tag beta

# Test the beta version
npm install token-optimizer-mcp@beta

# If everything works, publish stable version
npm version 0.2.0
npm publish
```
