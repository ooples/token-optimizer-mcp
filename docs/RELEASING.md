# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please)
(this replaced the previous semantic-release setup) and published to npm with
**OIDC trusted publishing** (with an `NPM_TOKEN` fallback). You never bump the
version or edit `CHANGELOG.md` by hand — both are derived from the
[Conventional Commits](https://www.conventionalcommits.org/) history.

## How a release happens

1. PRs merge to `master` with conventional-commit messages
   (`feat:`, `fix:`, `perf:`, `feat!:` / `BREAKING CHANGE:` …). commitlint
   enforces this.
2. On each push to `master`, the [`Release`](../.github/workflows/release.yml)
   workflow runs **release-please**, which opens/updates a single **release PR**
   (e.g. _"chore(master): release 5.1.0"_) with the version bump in
   `package.json` + `.release-please-manifest.json` and the generated
   `CHANGELOG.md`.
3. **You merge the release PR** when you want to ship. release-please then cuts
   the git tag (`vX.Y.Z`) and the GitHub Release.
4. The release triggers the **`publish-npm`** job, which builds and runs
   `npm publish --provenance --access public`.
5. The **`notify`** job fans the version info out to every configured channel.

### Version bump rules

| Commit type | Release |
|-------------|---------|
| `fix:`, `perf:`, `revert:` | patch |
| `feat:` | minor |
| `feat!:` / `BREAKING CHANGE:` | major |
| `docs:`, `refactor:`, `style:`, `chore:`, `test:`, `build:`, `ci:` | none |

The baseline is pinned in `.release-please-manifest.json` (currently `5.0.1`,
the last published version); the first release PR bumps from there.

### Config files

| File | Purpose |
| --- | --- |
| `.github/workflows/release.yml` | The `Release` workflow (release-please + publish + notify) |
| `release-please-config.json` | release-please config (`release-type: node`, changelog sections) |
| `.release-please-manifest.json` | Current released version per package (source of truth) |

## npm authentication

The `publish-npm` job is **OIDC-first with a token fallback**. It has
`id-token: write` and passes `NODE_AUTH_TOKEN` from `NPM_TOKEN`, so it works in
either mode:

### Option A — OIDC trusted publishing (recommended, no long-lived secret)

This removes the class of failure that broke releases (an expired token).

1. Sign in at npmjs.com and open the package:
   <https://www.npmjs.com/package/@ooples/token-optimizer-mcp>
2. **Settings → Trusted Publisher → Add a GitHub Actions publisher**:
   - Organization or user: `ooples`
   - Repository: `token-optimizer-mcp`
   - Workflow filename: `release.yml`
   - Environment: _(leave blank)_
3. Save. From then on the workflow authenticates via OIDC — you can **delete the
   `NPM_TOKEN` secret** and publishing (with provenance) keeps working.

Requires npm ≥ 11.5.1 in CI; the workflow upgrades npm before publishing.

### Option B — `NPM_TOKEN` secret (interim / fallback)

Use this to get releases working immediately, before configuring OIDC.

1. npmjs.com → **Access Tokens → Generate New Token → Granular Access Token**
   - Packages and scopes: **Read and write** on `@ooples/token-optimizer-mcp`
   - Set an expiration you will renew (an expired token is what broke the
     pipeline).
2. Store it as the repo secret (run it yourself so the value never lands in a log
   or chat):
   ```bash
   gh secret set NPM_TOKEN --repo ooples/token-optimizer-mcp
   ```

## Version-info notifications

Each channel is optional and **skipped silently when not configured**, so the
core release never fails because a channel is missing. Set these under
**Settings → Secrets and variables → Actions**.

| Channel | Configuration |
|---------|---------------|
| **GitHub Release** + watcher emails | Built-in (release-please creates the Release). |
| **npm publish email** | Built-in (npm emails the maintainer on publish). |
| **PR/issue comments** | Built-in (`notify` job comments resolved issues). |
| **Email** | Repo **variable** `RELEASE_EMAIL_TO` + SMTP **secrets** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, optional `SMTP_FROM`). |
| **Discord** | Repo **variable** `DISCORD_WEBHOOK_URL`. |
| **Slack** | Repo **variable** `SLACK_WEBHOOK_URL`. |

## Notes

- Do **not** push manual version bumps or `CHANGELOG.md` edits — release-please
  manages both. Contributors only write conventional-commit messages.
- The old `.releaserc.json` was removed. The `semantic-release` dev dependencies
  are now unused and can be pruned from `package.json` in a follow-up (left in
  place here to avoid an unrelated lockfile churn).
