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
| Windsurf | `.windsurfrules` | `mcp_config.json` |
| Cline | `.clinerules/token-optimizer.md` | `cline_mcp_settings.json` |
| Roo Code | `.roo/rules/token-optimizer.md` | `mcp_settings.json` |
| Kilo Code | `.kilocode/rules/token-optimizer.md` | `mcp_settings.json` |
| Zed | `AGENTS.md` | `settings.json` (`context_servers`) |
| Amp | `AGENTS.md` | `settings.json` (`amp.mcpServers`) |
| Continue | `.continue/rules/token-optimizer.md` | `config.yaml` |
| Crush | `CRUSH.md` | `crush.json` |
| Droid (Factory) | `AGENTS.md` | `mcp.json` |
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

## Configuration, all clients

| Variable | Default | Effect |
|---|---|---|
| `TOKEN_OPTIMIZER_MODE` | `enforce` | `advise` = never refuse; `off` = disable |
| `TOKEN_OPTIMIZER_LARGE_READ_BYTES` | `25600` | Size at which a read stops being cheap |
| `TOKEN_OPTIMIZER_PRECOMPACT_TIMEOUT_MS` | `8000` | Cap on pre-compaction work |

An unrecognised `TOKEN_OPTIMIZER_MODE` falls back to `enforce`, so a typo cannot
quietly turn the product off.
