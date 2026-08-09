# Client support

Fifteen clients, in two tiers. **The tier is set by what the client's protocol
allows, not by how much work went in** — and it is stated plainly here because
the difference is one a user feels on their first large read.

## Enforcing tier

These clients expose a hook that runs **before** a tool executes and can refuse
it. Expensive built-in calls are denied and redirected; optimized tooling is the
default, not a suggestion.

| Client | Hook surface | Install |
|---|---|---|
| Claude Code | `SessionStart`, `PreToolUse`, `PreCompact` | `/plugin install token-optimizer@token-optimizer` |
| Codex | `SessionStart`, `PreToolUse` | [`integrations/codex`](../integrations/codex) |
| OpenCode | pre-tool | [`integrations/opencode`](../integrations/opencode) |

## Directive tier

These clients expose MCP but **no pre-execution veto**. The strongest available
lever is the client's always-applied rules file, which loads on every request.
That is meaningfully stronger than a skill — a skill is consulted only once the
model has already decided it is relevant, which on a normal coding session is
rarely — but it is guidance, and a model can read past guidance.

| Client | Rules file | MCP config |
|---|---|---|
| Cursor | `.cursor/rules/token-optimizer.mdc` (`alwaysApply: true`) | `.cursor/mcp.json` |
| Windsurf | `.windsurf/rules/token-optimizer.md` | `mcp_config.json` |
| Cline | `.clinerules/token-optimizer.md` | `~/.cline/mcp.json` (CLI) or `cline_mcp_settings.json` (VS Code) |
| Roo Code | `.roo/rules/token-optimizer.md` | `.roo/mcp.json` (project-level, takes precedence) |
| Kilo | `.kilo/rules/token-optimizer.md` | `.kilo/kilo.jsonc` (`mcp` key) |
| Zed | `AGENTS.md` | `settings.json` (`context_servers`) |
| Amp | `AGENTS.md` | `settings.json` (`amp.mcpServers`) |
| Continue | `.continue/rules/token-optimizer.md` | `config.yaml` |
| Crush | `AGENTS.md` | `crush.json` |
| Droid (Factory) | `AGENTS.md` | `~/.factory/mcp.json` |
| GitHub Copilot CLI | `.github/copilot-instructions.md` | `mcp-config.json` |
| Gemini CLI | extension `GEMINI.md` | `gemini-extension.json` |
| Qwen Code | extension context file | extension config |

Gemini and Qwen sit here despite having a hook API: their only tool hook is
`AfterTool`, which fires once the read has already been paid for. Refusing at
that point costs a turn and saves nothing on the call in question, so those
integrations advise about the next call rather than claiming a veto they do not
have.

## One decision engine

Every client above runs the same code. [`hooks-core/`](../hooks-core) holds the
policy, the decision function, and the universal adapter; per-client entry files
are four lines that name their client and event, and are **generated**.

This is deliberate. Before it, Claude Code, Codex and Gemini each carried their
own copy of the threshold constant and the guidance string, and they had already
drifted. Client integrations now differ only where the protocol differs.

```bash
npm run sync:hooks          # regenerate vendored copies, entries, and configs
npm run sync:hooks:check    # CI gate: fails if any copy has drifted
```

The core is vendored into each client directory rather than imported, because
each client executes hooks from a directory it controls (`~/.codex/hooks`, the
Gemini extension path, the Claude Code plugin root) and no shared location
resolves across all of them. `sync:hooks:check` is what keeps vendoring honest.

## How these were verified

Every config shape was checked against the client's own published documentation,
and the URL is recorded in each integration's README. That check found four real
errors, each of which would have failed **silently** -- the file installs, the
client reports nothing, and the server never loads:

| Client | Was | Should be |
|---|---|---|
| **Kilo** | `mcp_settings.json` / `mcpServers` | **wrong at the schema level.** Kilo rebranded; it reads `kilo.jsonc` under an `mcp` key, with `type: "local"`, `command` as an **array**, and `environment` rather than `env` |
| Zed | a `source` key | not in the current schema; removed |
| Windsurf | `.windsurfrules` | the legacy single-file form; now `.windsurf/rules/` |
| Crush | `CRUSH.md` | the per-user file; the project one is `AGENTS.md` |
| Cline | `cline_mcp_settings.json` | the VS Code filename; the CLI reads `~/.cline/mcp.json` |
| Roo | `mcp_settings.json` | the global path; project-level `.roo/mcp.json` takes precedence |

Kilo is the one worth dwelling on: **six of ten clients share the `mcpServers`
convention, and assuming the seventh did too would have shipped a config that
could never load.** Conventions are not schemas.

`npm run verify:clients` asserts these shapes on every run, including that
superseded paths stay deleted and that no directive-tier rules file claims the
enforcement its client cannot perform.

All ten directive-tier shapes are now confirmed against published documentation,
with the source URL recorded in each integration's README.

## Configuration, all clients

The MCP server advertises its 18 essential tools by default. Set
`TOKEN_OPTIMIZER_TOOL_PROFILE=full` in the server environment only when a client
needs the complete 98-tool specialist catalog.

| Variable | Default | Effect |
|---|---|---|
| `TOKEN_OPTIMIZER_MODE` | `enforce` | `advise` = never refuse; `off` = disable |
| `TOKEN_OPTIMIZER_LARGE_READ_BYTES` | `25600` | Size at which a read stops being cheap |
| `TOKEN_OPTIMIZER_PRECOMPACT_TIMEOUT_MS` | `8000` | Cap on pre-compaction work |

An unrecognised `TOKEN_OPTIMIZER_MODE` falls back to `enforce`, so a typo cannot
quietly turn the product off.
