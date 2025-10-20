# Secrets and Variables Configuration

This document provides templates and instructions for configuring GitHub secrets and variables required for CI/CD automation.

## GitHub Secrets

Navigate to: `Settings` > `Secrets and variables` > `Actions` > `Secrets` tab

### Required Secrets

#### NPM_TOKEN

**Description**: npm authentication token for publishing packages

**How to obtain**:
1. Log in to https://www.npmjs.com/
2. Click on your profile picture → "Access Tokens"
3. Click "Generate New Token" → "Classic Token"
4. Select type: "Automation"
5. Copy the token (starts with `npm_`)

**Add to GitHub**:
```
Name: NPM_TOKEN
Value: npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Testing**:
```bash
# Test locally (optional)
echo "//registry.npmjs.org/:_authToken=npm_xxx..." > ~/.npmrc
npm publish --dry-run
```

**Security Notes**:
- Never commit tokens to repository
- Rotate tokens every 6-12 months
- Use "Automation" type for CI/CD
- Use "Publish" type only if needed for manual publishing

---

### Optional Secrets

#### CODECOV_TOKEN

**Description**: Codecov token for uploading code coverage reports

**How to obtain**:
1. Visit https://codecov.io/
2. Sign in with GitHub
3. Click "Add new repository"
4. Select `ooples/token-optimizer-mcp`
5. Copy the upload token from repository settings

**Add to GitHub**:
```
Name: CODECOV_TOKEN
Value: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Testing**:
```bash
# Test locally (optional)
npm run test:coverage
npx codecov -t YOUR_TOKEN
```

**Note**: If not using Codecov, remove the Codecov upload step from `.github/workflows/ci.yml`

---

#### SNYK_TOKEN

**Description**: Snyk token for advanced security vulnerability scanning

**How to obtain**:
1. Visit https://snyk.io/
2. Sign up or log in
3. Go to Account Settings → API Token
4. Copy your API token

**Add to GitHub**:
```
Name: SNYK_TOKEN
Value: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**Testing**:
```bash
# Test locally (optional)
npm install -g snyk
snyk auth YOUR_TOKEN
snyk test
```

**Note**: This is optional. Basic security scanning is done with `npm audit`

---

## GitHub Variables

Navigate to: `Settings` > `Secrets and variables` > `Actions` > `Variables` tab

### Optional Variables

#### DISCORD_WEBHOOK_URL

**Description**: Discord webhook URL for release notifications

**How to obtain**:
1. Open Discord and go to your server
2. Click Server Settings → Integrations
3. Click "Webhooks" → "New Webhook"
4. Configure webhook:
   - Name: "Token Optimizer Releases"
   - Channel: Choose appropriate channel
   - Copy Webhook URL
5. Click "Save"

**Add to GitHub**:
```
Name: DISCORD_WEBHOOK_URL
Value: https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz
```

**Testing**:
```bash
# Test locally
curl -X POST "YOUR_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"content": "Test release notification from CI/CD"}'
```

**Message Format**:
```
New release: token-optimizer-mcp v0.2.1
Release notes: https://github.com/ooples/token-optimizer-mcp/releases/tag/v0.2.1
npm: https://www.npmjs.com/package/token-optimizer-mcp/v/0.2.1
```

---

#### SLACK_WEBHOOK_URL

**Description**: Slack webhook URL for release notifications

**How to obtain**:
1. Go to https://api.slack.com/apps
2. Create a new app or select existing
3. Click "Incoming Webhooks"
4. Activate Incoming Webhooks
5. Click "Add New Webhook to Workspace"
6. Select channel (e.g., #releases)
7. Copy the Webhook URL

**Add to GitHub**:
```
Name: SLACK_WEBHOOK_URL
Value: https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX
```

**Testing**:
```bash
# Test locally
curl -X POST "YOUR_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text": "Test release notification from CI/CD"}'
```

**Message Format**:
```json
{
  "text": "New release: token-optimizer-mcp v0.2.1\nRelease notes: https://github.com/...\nnpm: https://www.npmjs.com/..."
}
```

---

## Verification Checklist

After adding secrets and variables:

### Secrets Verification

- [ ] NPM_TOKEN added and value correct
- [ ] CODECOV_TOKEN added (if using Codecov)
- [ ] SNYK_TOKEN added (if using Snyk)
- [ ] Secrets are marked with `***` (masked)
- [ ] No secrets committed to repository

### Variables Verification

- [ ] DISCORD_WEBHOOK_URL added (if using Discord)
- [ ] SLACK_WEBHOOK_URL added (if using Slack)
- [ ] Test webhooks manually
- [ ] Webhooks post to correct channels

### Workflow Verification

- [ ] Create test PR to trigger workflows
- [ ] Check workflow logs for secret usage
- [ ] Verify no secrets are exposed in logs
- [ ] Test release workflow (after merge)

## Security Best Practices

### Token Management

1. **Rotation Schedule**
   - npm tokens: Rotate every 6-12 months
   - Codecov tokens: Rotate annually
   - Webhook URLs: Update if compromised

2. **Access Control**
   - Limit repository access
   - Use principle of least privilege
   - Review access logs regularly

3. **Monitoring**
   - Monitor npm package downloads for anomalies
   - Track unauthorized access attempts
   - Set up alerts for failed authentications

### Secret Hygiene

1. **Never commit secrets**
   ```bash
   # Add to .gitignore
   .env
   .env.local
   *.pem
   *.key
   *-credentials.json
   ```

2. **Use environment variables locally**
   ```bash
   # Create .env file (gitignored)
   NPM_TOKEN=npm_xxx...
   CODECOV_TOKEN=xxx...

   # Load in terminal
   export $(cat .env | xargs)
   ```

3. **Scan for leaked secrets**
   ```bash
   # Use git-secrets or similar tools
   npm install -g git-secrets
   git secrets --scan
   ```

## Troubleshooting

### NPM Token Issues

**Problem**: npm publish fails with 401 Unauthorized

**Solutions**:
1. Verify token hasn't expired
2. Check token has "Automation" permissions
3. Regenerate token on npmjs.com
4. Update GitHub secret with new token
5. Trigger workflow again

**Problem**: Token works locally but not in CI

**Solutions**:
1. Ensure token is saved as GitHub secret (not variable)
2. Check secret name matches workflow file (`NPM_TOKEN`)
3. Verify workflow has access to secrets
4. Check organization settings allow secret access

### Codecov Token Issues

**Problem**: Coverage upload fails

**Solutions**:
1. Verify token is correct
2. Check repository is added to Codecov
3. Ensure workflow has internet access
4. Try regenerating token

**Problem**: Coverage not appearing on Codecov.io

**Solutions**:
1. Wait a few minutes for processing
2. Check Codecov dashboard for errors
3. Verify coverage files are generated (`coverage/`)
4. Check workflow logs for upload errors

### Webhook Issues

**Problem**: Discord/Slack notifications not received

**Solutions**:
1. Test webhook manually with curl
2. Check channel permissions
3. Verify webhook URL is correct
4. Check variable name matches workflow file
5. Ensure notification job runs (check workflow logs)

**Problem**: Webhook returns 404

**Solutions**:
1. Webhook may have been deleted - regenerate
2. Check URL is complete and correct
3. Verify channel still exists

## Emergency Procedures

### Compromised Token

If a token is compromised:

1. **Immediate Actions**
   ```
   1. Revoke token immediately on provider website
   2. Remove from GitHub secrets
   3. Generate new token
   4. Update GitHub secret
   5. Trigger test workflow to verify
   ```

2. **Investigation**
   ```
   1. Check recent npm publishes
   2. Review GitHub Actions logs
   3. Check for unauthorized repository access
   4. Review recent commits for suspicious activity
   ```

3. **Prevention**
   ```
   1. Enable 2FA on npm account
   2. Review repository access permissions
   3. Audit GitHub Actions permissions
   4. Set up monitoring alerts
   ```

### Leaked Secret in Commit

If a secret is accidentally committed:

1. **Remove from history**
   ```bash
   # Use BFG Repo-Cleaner or git-filter-repo
   git filter-repo --invert-paths --path path/to/secret/file

   # Force push (dangerous - coordinate with team)
   git push origin --force --all
   ```

2. **Invalidate the secret**
   ```
   1. Revoke token on provider
   2. Generate new token
   3. Update GitHub secret
   ```

3. **Prevent future leaks**
   ```bash
   # Add to .gitignore
   echo ".env" >> .gitignore
   echo "*.key" >> .gitignore

   # Install git-secrets
   npm install -g git-secrets
   git secrets --install
   git secrets --register-aws
   ```

## Additional Resources

- [GitHub Secrets Documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [npm Token Documentation](https://docs.npmjs.com/about-access-tokens)
- [Codecov Documentation](https://docs.codecov.com/docs)
- [Discord Webhooks Guide](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
- [Slack Webhooks Guide](https://api.slack.com/messaging/webhooks)
