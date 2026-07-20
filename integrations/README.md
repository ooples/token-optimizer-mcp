# Using token-optimizer across AI agents

The token-optimizer MCP server works with any MCP-capable agent. This folder has
ready-to-use config for the major CLIs. The MCP **server** is identical
everywhere (`npx -y @ooples/token-optimizer-mcp@latest`); what differs per tool is
the config file and how each one loads instructions ("skills").

| Agent | MCP config | Instructions ("skill") |
| --- | --- | --- |
| **Claude Code** | `../plugin` (full plugin: MCP + skill + hooks) | `skills/token-optimization/SKILL.md` |
| **Gemini CLI** | `gemini/gemini-extension.json` | `gemini/GEMINI.md` |
| **OpenAI Codex** | `codex/config.toml` | `AGENTS.md` |
| **OpenCode** | `opencode/opencode.json` | `AGENTS.md` |
| **GitHub Copilot CLI** | `copilot/mcp-config.json` | `AGENTS.md` |

Prereq for all: Node.js (so `npx` can run the server). First run downloads
`@ooples/token-optimizer-mcp`; subsequent runs are cached.

> Getting token-optimizer **listed** in each ecosystem's marketplace/registry
> (MCP Registry, Claude Code community marketplace, Gemini extension gallery)?
> See [`../docs/PUBLISHING.md`](../docs/PUBLISHING.md).

## Claude Code (native plugin — richest)

The repo root is a plugin marketplace; the plugin lives in `../plugin` (MCP +
the `token-optimization` skill + a cross-platform large-read hook).

```bash
# Try it locally:
claude --plugin-dir ./plugin

# Or install via the marketplace:
/plugin marketplace add ooples/token-optimizer-mcp
/plugin install token-optimizer@token-optimizer
```

Optional hook env vars: `TOKEN_OPTIMIZER_REDIRECT_LARGE_READS=true` (deny large
built-in Reads and steer to `smart_read`), `TOKEN_OPTIMIZER_LARGE_READ_BYTES`
(threshold, default 25600).

## Gemini CLI

```bash
# Install as a Gemini extension:
mkdir -p ~/.gemini/extensions/token-optimizer
cp gemini/gemini-extension.json gemini/GEMINI.md ~/.gemini/extensions/token-optimizer/
# Restart the Gemini CLI; verify the server with: /mcp
```

Alternatively add the `mcpServers` block from `gemini-extension.json` to
`~/.gemini/settings.json`.

> **Gemini hooks caveat:** if you also wire up hooks in `~/.gemini/settings.json`,
> Gemini CLI uses its **own** event names — `BeforeTool` / `AfterTool`, *not*
> Claude Code's `PreToolUse` / `PostToolUse`. An unknown event name is silently
> dropped (`Hook registry initialized with 0 hook entries`) and the MCP tools
> keep working, but the hook never fires. MCP tool names match as
> `mcp_<server>_<tool>` in a hook `matcher`.

## OpenAI Codex

**Native plugin (richest — bundles the MCP server + skill via Codex's plugin system):**

```bash
# Add this repo as a Codex plugin marketplace, then install:
codex plugin marketplace add ooples/token-optimizer-mcp
codex plugin install token-optimizer@token-optimizer
```

The plugin lives in `codex/plugin/` (`.codex-plugin/plugin.json` + `.mcp.json` +
the `token-optimization` skill); the repo-root `.agents/plugins/marketplace.json`
makes the repo an installable Codex marketplace.

**Or just the MCP server + guidance (no plugin system):**

```bash
# 1) Merge the MCP server into your Codex config:
cat codex/config.toml >> ~/.codex/config.toml
# 2) Add the guidance so Codex knows when to use the tools:
cat AGENTS.md >> ~/.codex/AGENTS.md   # or your project's AGENTS.md
```

## OpenCode

```bash
# Drop both files into your project (or ~/.config/opencode/):
cp opencode/opencode.json AGENTS.md ./
# opencode.json references ./AGENTS.md via "instructions".
```

## GitHub Copilot CLI

```bash
# Add the MCP server to your global Copilot config:
cp copilot/mcp-config.json ~/.copilot/mcp-config.json
# Or, for a single session without touching the global config:
copilot --additional-mcp-config @copilot/mcp-config.json
# Guidance: append AGENTS.md so Copilot knows when to use the tools:
cat AGENTS.md >> AGENTS.md   # in your project root
```

Verify: the Copilot log (`~/.copilot/logs/`) shows
`MCP client for token-optimizer connected`.

## Notes

- **Compression is model-invoked.** No agent can transparently rewrite a built-in
  read's output (see anthropics/claude-code#32105), so the agent must *call*
  `smart_read`/`smart_glob`/etc. The skill/AGENTS.md/GEMINI.md files teach it when.
- **`compress_text` is at-rest only** — its base64 output usually has more tokens
  than the input; use `optimize_text` (by key) to stash content out of context.
- Pin a version by replacing `@latest` with a specific version in any config.
