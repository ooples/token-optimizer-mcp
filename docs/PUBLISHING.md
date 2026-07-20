# Publishing token-optimizer to plugin marketplaces & registries

token-optimizer is fundamentally an **MCP server** (`@ooples/token-optimizer-mcp`
on npm) plus a **Claude Code plugin** (`./plugin`) and per-CLI integration
configs (`./integrations`). This guide covers getting it *listed* in each
ecosystem's discovery surface.

Legend: ✅ done in-repo · ⏳ requires a manual/interactive step you must run.

## 1. Official MCP Registry — covers Copilot CLI, Codex, OpenCode, and any MCP client

The [official MCP Registry](https://registry.modelcontextprotocol.io/) is the
shared metadata registry backed by Anthropic, GitHub, Microsoft, and PulseMCP.
Publishing here makes the server discoverable across every MCP-aware tool
(GitHub's registry mirrors from it). Codex and OpenCode have no separate
marketplace — they consume MCP servers via config, so the registry is their
discovery path.

- ✅ `package.json` carries the ownership marker `"mcpName": "io.github.ooples/token-optimizer-mcp"`.
- ✅ `server.json` (repo root) declares the scoped npm package, version, stdio
  transport, and the optional `TOKEN_OPTIMIZER_CACHE_DIR` env var.
- ✅ **PUBLISHED** — `io.github.ooples/token-optimizer-mcp v5.0.1` is live on
  <https://registry.modelcontextprotocol.io> (verify:
  `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=token-optimizer"`).
- **Re-publishing on each future npm release** (non-interactive; `gh` must be
  authenticated as `ooples`):
  ```bash
  # 0. server.json "version" must equal a PUBLISHED npm version carrying mcpName:
  npm view @ooples/token-optimizer-mcp@<ver> mcpName   # -> io.github.ooples/token-optimizer-mcp
  # 1. Get the publisher CLI (macOS/Linux: brew install mcp-publisher; Windows:
  #    download mcp-publisher_windows_amd64.tar.gz from the registry releases).
  # 2. Authenticate with the gh token (no browser needed):
  mcp-publisher login github --token "$(gh auth token)"
  # 3. Publish (reads ./server.json):
  mcp-publisher publish
  ```
  Notes learned in practice: `description` must be **≤ 100 chars** or the
  registry returns 422; keep `server.json` `version` in lockstep with npm.

## 2. Claude Code

The repo **is** a marketplace: `.claude-plugin/marketplace.json` lists the
`token-optimizer` plugin under `./plugin`. `claude plugin validate ./plugin`
passes.

- **Self-host (no approval):** once the plugin is on the default branch,
  ```
  /plugin marketplace add ooples/token-optimizer-mcp
  /plugin install token-optimizer@token-optimizer
  ```
- ⏳ **Community marketplace** (`claude-community`) — the realistic public listing:
  1. Run `claude plugin validate ./plugin` (the review pipeline runs the same check).
  2. Submit via the Console form: <https://platform.claude.com/plugins/submit>
     (individual authors), or the claude.ai form
     <https://claude.ai/admin-settings/directory/submissions/plugins/new>
     (needs a Team/Enterprise org + directory-management access).
  3. On approval it's pinned to a commit SHA in
     [`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community);
     the catalog syncs nightly.
- **Official marketplace** (`claude-plugins-official`): curated by Anthropic at
  its discretion. **No application process** — the submission form does not add
  here. If they list it, you can prompt users via
  [plugin hints](https://code.claude.com/docs/en/plugin-hints).
- ⏳ **Prerequisite:** merge the packaging PR so `plugin/` and
  `.claude-plugin/marketplace.json` land on `master` (the submission/self-host
  flows read the default branch).

## 3. Gemini CLI — auto-indexed gallery (no form)

The [Gemini extension gallery](https://www.geminicliextensions.com/browse)
crawls public GitHub repos daily; there is nothing to submit.

- ✅ Repo is public.
- ✅ GitHub topic `gemini-cli-extension` added (the crawler keys off this).
- ✅ `gemini-extension.json` + `GEMINI.md` placed at the **repo root** (the
  crawler requires the manifest at the absolute root or a release-archive root).
- ⏳ **Tag a release** so the crawler picks it up:
  ```bash
  git tag v5.0.2 && git push origin v5.0.2
  ```
  It appears in the gallery on the next daily crawl if validation passes.

## 4. GitHub Copilot CLI / Codex / OpenCode

No dedicated plugin store of their own — they load MCP servers from config
(`~/.copilot/mcp-config.json`, `~/.codex/config.toml`,
`opencode.json`; see `integrations/`). Discovery comes from **the MCP Registry
(step 1)**. Ready-to-copy configs live in `integrations/`.

## Quick status

| Target | In-repo prep | Manual step remaining |
| --- | --- | --- |
| MCP Registry | ✅ `server.json`, `mcpName` | ✅ **PUBLISHED (v5.0.1 live)** |
| Claude Code (self-host) | ✅ marketplace.json, validate passes | merge packaging PR to `master` |
| Claude Code (community) | ✅ validate passes | submit via Console form (needs your login) |
| Gemini gallery | ✅ topic + root manifest | `git tag` a release (after merge) |
| Copilot / Codex / OpenCode | ✅ `integrations/*` configs | ✅ (covered by the MCP Registry) |
