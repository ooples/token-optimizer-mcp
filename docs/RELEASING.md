# Releasing

`token-optimizer-mcp` publishes **fully automatically** from `master` using
[semantic-release](https://semantic-release.gitbook.io/). You never bump the
version or edit `CHANGELOG.md` by hand — both are derived from the
[Conventional Commits](https://www.conventionalcommits.org/) history.

## How a release happens

1. PRs merge to `master` with conventional-commit messages
   (`feat:`, `fix:`, `perf:`, `refactor:`, `BREAKING CHANGE:` …).
2. The [`Release`](../.github/workflows/release.yml) workflow runs on the push:
   - installs deps, builds, runs the test suite with coverage;
   - runs `semantic-release`, which (per [`.releaserc.json`](../.releaserc.json)):
     - analyzes commits and computes the next semver version,
     - generates release notes + updates `CHANGELOG.md`,
     - publishes to npm (with **provenance**),
     - commits `package.json` / `package-lock.json` / `CHANGELOG.md` back to
       `master` as `chore(release): x.y.z [skip ci]`,
     - creates the GitHub Release and comments the resolved version on the
       PRs/issues included in the release.
3. The `notify` job fans the version info out to every configured channel.

### Version bump rules (`.releaserc.json`)

| Commit type | Release |
|-------------|---------|
| `fix:`, `perf:`, `refactor:`, `revert:` | patch |
| `feat:` | minor |
| `BREAKING CHANGE:` / `feat!:` etc. | major |
| `docs:`, `style:`, `chore:`, `test:`, `build:`, `ci:` | none |

## Version-info notifications

The pipeline announces each release through several channels. Each is optional
and **skipped silently when not configured**, so the core release never fails
because a channel is missing.

| Channel | Always on? | Configuration |
|---------|-----------|---------------|
| **npm publish email** | ✅ built-in | npm emails the package maintainer on every publish — no setup. |
| **GitHub Release** + watcher emails | ✅ built-in | Created by `@semantic-release/github`; GitHub emails repo watchers. |
| **PR/issue comments** | ✅ built-in | `@semantic-release/github` `successComment` + the `notify` job. |
| **Email** | optional | Set repo **variable** `RELEASE_EMAIL_TO` and the SMTP **secrets** below. |
| **Discord** | optional | Set repo **variable** `DISCORD_WEBHOOK_URL`. |
| **Slack** | optional | Set repo **variable** `SLACK_WEBHOOK_URL`. |

## Required / optional repository configuration

Set these under **Settings → Secrets and variables → Actions**.

### Secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| `NPM_TOKEN` | ✅ | npm automation token used to publish. |
| `GITHUB_TOKEN` | ✅ (auto) | Provided by Actions; used for the GitHub Release + comments. |
| `SMTP_HOST` | for email | SMTP server hostname. |
| `SMTP_PORT` | for email | SMTP port (e.g. 465 for TLS). |
| `SMTP_USERNAME` | for email | SMTP auth user (also the default `From`). |
| `SMTP_PASSWORD` | for email | SMTP auth password / app password. |
| `SMTP_FROM` | optional | Override the `From` address (defaults to `SMTP_USERNAME`). |

### Variables

| Variable | Purpose |
|----------|---------|
| `RELEASE_EMAIL_TO` | Recipient(s) for the release email. Enables the email step. |
| `DISCORD_WEBHOOK_URL` | Enables the Discord notification. |
| `SLACK_WEBHOOK_URL` | Enables the Slack notification. |

## Notes

- The workflow uses a `concurrency` group so a newer push to `master` cancels an
  in-flight release.
- npm **provenance** is enabled (`NPM_CONFIG_PROVENANCE: true` + `id-token: write`),
  attesting that the package was built by this workflow from this repo.
- Do **not** push manual version bumps or `CHANGELOG.md` edits — they conflict
  with the automated release commit. Contributors should only write
  conventional-commit messages.
