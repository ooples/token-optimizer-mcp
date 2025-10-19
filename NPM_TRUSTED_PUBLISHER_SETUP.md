# NPM Trusted Publisher Setup Guide

This guide shows how to set up NPM Trusted Publisher with OpenID Connect (OIDC) for both MCP servers.

## Why Use Trusted Publisher?

**Benefits:**
- ✅ **No NPM tokens needed** - More secure, no tokens to manage or rotate
- ✅ **Automatic authentication** - GitHub Actions authenticates via OIDC
- ✅ **Provenance enabled** - Cryptographic proof of package origin
- ✅ **Audit trail** - Clear record of which workflow published each version
- ✅ **No secret management** - Removes NPM_TOKEN from GitHub secrets

## Prerequisites

- Repository must be on GitHub
- Package must be published to npm (or be ready for first publish)
- You must have publishing rights to the npm package
- Workflow file must exist in `.github/workflows/`

---

## Setup for `token-optimizer-mcp`

### Step 1: Configure on npm Website

1. Go to https://www.npmjs.com/package/token-optimizer-mcp/access
2. Scroll to **"Publishing access"** section
3. Click **"Trusted Publishers"** tab
4. Click **"Set up connection"** (or "Add a trusted publisher")
5. Fill in the form:
   ```
   Publisher: GitHub Actions
   Organization or user: ooples
   Repository: token-optimizer-mcp
   Workflow filename: release.yml
   Environment name: (leave empty, or use "production" for extra security)
   ```
6. Click **"Set up connection"**
7. You should see a confirmation that the trusted publisher is configured

### Step 2: Verify Workflow Configuration

The `.github/workflows/release.yml` has been updated with:

**Key changes:**
- Added `permissions.id-token: write` to the `publish` job
- Changed `npm publish` to use `--provenance` flag
- Removed `NODE_AUTH_TOKEN` environment variable (no longer needed)

The workflow now uses OIDC authentication automatically.

### Step 3: Remove NPM_TOKEN (Optional but Recommended)

Since we're using OIDC, the NPM_TOKEN secret is no longer needed for publishing:

```bash
# Remove the secret (optional - won't hurt to keep it)
gh secret delete NPM_TOKEN
```

**Note:** If you're still using semantic-release with npm plugin enabled, keep the token. Our setup has `npmPublish: false` in semantic-release config, so it's safe to remove.

### Step 4: Test the Setup

**Option A: Trigger a release by pushing a commit**
```bash
git commit --allow-empty -m "feat: test OIDC publishing setup"
git push origin master
```

**Option B: Manually trigger the workflow**
1. Go to https://github.com/ooples/token-optimizer-mcp/actions/workflows/release.yml
2. Click "Run workflow"
3. Select branch: `master`
4. Click "Run workflow"

### Step 5: Verify Publication

After the workflow completes:
1. Check the npm package page: https://www.npmjs.com/package/token-optimizer-mcp
2. Look for the **"Provenance"** badge on the package version
3. Click the badge to see the cryptographic attestation linking the package to the GitHub workflow

---

## Setup for `console-automation-mcp`

Follow the same steps for your other MCP server:

### Step 1: Configure on npm Website

1. Go to https://www.npmjs.com/package/console-automation-mcp/access
   *(Replace with actual package name if different)*
2. Scroll to **"Publishing access"** section
3. Click **"Trusted Publishers"** tab
4. Click **"Set up connection"**
5. Fill in the form:
   ```
   Publisher: GitHub Actions
   Organization or user: ooples
   Repository: console-automation-mcp
   Workflow filename: (check what your workflow is named - probably release.yml or publish.yml)
   Environment name: (leave empty)
   ```
6. Click **"Set up connection"**

### Step 2: Update the Workflow File

In the repository for `console-automation-mcp`, update the publish job in your workflow file:

**Before:**
```yaml
- name: Publish to npm
  run: npm publish --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**After:**
```yaml
publish:
  name: Publish to npm
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write  # Required for OIDC

  steps:
    # ... other steps ...

    - name: Publish to npm (OIDC)
      run: npm publish --provenance --access public
      # No NODE_AUTH_TOKEN needed!
```

### Step 3: Commit and Push

```bash
git add .github/workflows/your-workflow.yml
git commit -m "ci: Enable NPM Trusted Publisher with OIDC"
git push origin master
```

---

## Troubleshooting

### Error: "npm ERR! 401 Unauthorized"

**Cause:** Trusted publisher not configured correctly on npm.

**Fix:**
1. Verify the trusted publisher settings on npm match exactly:
   - Repository name (case-sensitive)
   - Workflow filename (exact match including .yml)
   - Organization/user name
2. Ensure `permissions.id-token: write` is set in the workflow
3. Ensure using `npm publish --provenance`

### Error: "npm ERR! need auth"

**Cause:** Missing `registry-url` in Setup Node action.

**Fix:**
```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '20'
    registry-url: 'https://registry.npmjs.org'  # Add this
```

### Error: "Provenance generation failed"

**Cause:** Missing `--provenance` flag or `id-token: write` permission.

**Fix:**
1. Add `permissions.id-token: write` to the job
2. Use `npm publish --provenance --access public`

### First-time Package Publication

For packages that have **never been published**:

1. You **cannot** set up Trusted Publisher before first publish
2. First publish must use traditional npm token:
   ```bash
   npm login
   npm publish --access public
   ```
3. After first publish, set up Trusted Publisher
4. All subsequent publishes use OIDC

---

## Verification Checklist

- [ ] Trusted Publisher configured on npm website
- [ ] Workflow has `permissions.id-token: write`
- [ ] Workflow uses `npm publish --provenance`
- [ ] No `NODE_AUTH_TOKEN` in publish step
- [ ] `registry-url` set in Setup Node action
- [ ] Test publish succeeds
- [ ] Provenance badge appears on npm package page
- [ ] (Optional) NPM_TOKEN secret removed from GitHub

---

## Security Notes

### Provenance Verification

Anyone can verify your package provenance:

```bash
# Install the package
npm install token-optimizer-mcp

# Verify provenance
npm audit signatures
```

This shows cryptographic proof that the package was built by your GitHub Actions workflow.

### Environment Protection (Optional)

For extra security, use GitHub Environments:

1. Create environment in GitHub: Settings → Environments → New environment
2. Name it `production`
3. Add protection rules:
   - Required reviewers (optional)
   - Deployment branches: Only `master`
4. Update npm Trusted Publisher config:
   ```
   Environment name: production
   ```
5. Update workflow:
   ```yaml
   publish:
     environment: production  # Add this
     permissions:
       contents: read
       id-token: write
   ```

This requires manual approval before publishing.

---

## Additional Resources

- [npm Trusted Publishers Documentation](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub OIDC Documentation](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [npm Provenance](https://github.blog/2023-04-19-introducing-npm-package-provenance/)

---

## Summary

| Feature | Old (npm token) | New (OIDC) |
|---------|----------------|------------|
| Authentication | NPM_TOKEN secret | Automatic via OIDC |
| Security | Token can leak | No secrets needed |
| Provenance | Not available | Cryptographic proof |
| Rotation | Manual token rotation | Automatic |
| Audit | Limited | Full GitHub workflow trail |
| Setup | Easy | Slightly more complex initially |
| Ongoing | Token management needed | Zero maintenance |

**Recommendation:** Use Trusted Publisher with OIDC for all new packages and migrate existing packages when convenient.
