# Native CLI integrations

Token Optimizer runs the same MCP server in every client:

```text
npx -y @ooples/token-optimizer-mcp@latest
```

What differs is how each CLI loads instructions and lifecycle hooks. This
directory contains ready-made, client-native configurations; Claude Code's
seven-phase PowerShell hook system is documented separately and is not copied
unchanged into clients with different event contracts.

| Client             | MCP configuration                   | Guidance                    | Native lifecycle integration               |
| ------------------ | ----------------------------------- | --------------------------- | ------------------------------------------ |
| Codex              | `codex/config.toml` or Codex plugin | `AGENTS.md` or plugin skill | route + capture + active-model `Stop`      |
| Claude Code        | `../plugin/.mcp.json`               | Plugin skill                | route + capture + active-model `Stop`      |
| GitHub Copilot CLI | `copilot/mcp-config.json`           | `AGENTS.md`                 | route + capture + `agentStop`              |
| Gemini CLI         | `gemini/gemini-extension.json`      | `gemini/GEMINI.md`          | `BeforeTool`/`AfterTool`/`AfterAgent`      |
| Qwen Code          | Qwen settings                       | extension context           | `PreToolUse`/`PostToolUse`/`Stop`          |
| Cursor             | `cursor/mcp.json`                   | always-on `.mdc` rule       | pre/post tool + `stop`                     |
| Cline              | `cline/mcp.json`                    | `.clinerules`               | task start + pre/post tool                 |
| Windsurf           | `windsurf/mcp_config.json`          | Cascade rule                | pre read/write/command + post write        |
| OpenCode           | `opencode/opencode.json`            | `AGENTS.md`                 | shared-engine plugin bridge                |
| Kilo               | `kilo/kilo.jsonc`                   | Kilo rule                   | shared-engine plugin bridge                |

Prerequisite: Node.js 22 or newer so `npx` can launch the server. The first
launch downloads the package; later launches use the local npm cache.

## Codex

Recommended: install the native plugin, which bundles MCP, the optimization
skill, session guidance, and large-read hooks.

```bash
codex plugin marketplace add ooples/token-optimizer-mcp
codex plugin add token-optimizer@token-optimizer
```

Review and trust the plugin hooks with `/hooks`, then start a new conversation.
The marketplace points to `integrations/codex/plugin/`.

For an MCP-only installation:

```bash
codex mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest
```

Add `AGENTS.md` at project scope or append its contents once to
`~/.codex/AGENTS.md`. If you also want lifecycle hooks, copy
`codex/hooks/session-start.mjs`, `codex/hooks/pre-tool.mjs`,
`codex/hooks/post-tool.mjs`, `codex/hooks/stop.mjs`, and the generated
`codex/hooks/lib/` directory to `~/.codex/hooks/`, then merge
`codex/hooks/hooks.json` into `~/.codex/hooks.json`; do not overwrite unrelated
hooks already present. Review and trust the new definition with `/hooks`.

The hooks inject guidance at `SessionStart`, route first-class large reads,
track completed edits at `PostToolUse`, and give the active Codex model one
non-looping semantic-harvest continuation at `Stop`. Codex exposes shell reads
such as `cat` or `Get-Content` as `Bash`, so the adapter deliberately does not
parse and rewrite arbitrary shell commands.

## Claude Code

The repository root is a Claude plugin marketplace. The plugin bundles the MCP
server, optimization skill, and cross-platform large-read hook.

```text
/plugin marketplace add ooples/token-optimizer-mcp
/plugin install token-optimizer@token-optimizer
/reload-plugins
```

For local development, run `claude --plugin-dir ./plugin`. The separate global
installer and complete seven-phase hook architecture remain documented in
[`../docs/HOOKS-INSTALLATION.md`](../docs/HOOKS-INSTALLATION.md) and the main
README.

## GitHub Copilot CLI

Add the MCP server:

```bash
copilot mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest
```

If that command is unavailable in an older release, merge the server from
`copilot/mcp-config.json` into `~/.copilot/mcp-config.json`.

Add `AGENTS.md` to the repository, then copy the native repository hooks:

```bash
mkdir -p /path/to/project/.github/hooks
cp copilot/.github/hooks/token-optimizer* /path/to/project/.github/hooks/
```

The hooks inject session guidance, enforce expensive-call routing, deliver and
capture graph context, and give the active model one guarded `agentStop`
continuation for semantic harvesting.

## Gemini CLI

Recommended: install the extension, which bundles MCP, `GEMINI.md`, and native
`SessionStart`/`BeforeTool`/`AfterTool`/`AfterAgent` hooks.

```bash
gemini extensions install https://github.com/ooples/token-optimizer-mcp --auto-update
```

The standalone files under `gemini/` have the same structure if you want to
package the integration separately. Direct MCP setup is also available:

```bash
gemini mcp add --scope user token-optimizer npx -y @ooples/token-optimizer-mcp@latest
```

`BeforeTool` redirects expensive operations before their output enters context,
`AfterTool` captures completed edits, and `AfterAgent` gives the same active
Gemini model one guarded retry to call `wiki_write` when it learned something
durable.

## OpenCode

Copy or merge the MCP configuration and instructions into a project:

```bash
cp opencode/opencode.json /path/to/project/
cp AGENTS.md /path/to/project/
mkdir -p /path/to/project/.opencode/plugins
cp opencode/.opencode/plugins/token-optimizer.js /path/to/project/.opencode/plugins/
mkdir -p /path/to/project/.opencode/hooks/token-optimizer
cp -R opencode/hooks/* /path/to/project/.opencode/hooks/token-optimizer/
```

The local plugin invokes the generated shared-engine entries, preserves guidance
during compaction, and appends applicable graph findings to tool results.

## Hook behavior and controls

All adapters are fail-open for malformed payloads, missing files, small files,
and partial reads. The default threshold is 25,600 bytes.

- `TOKEN_OPTIMIZER_MODE=advise` disables native vetoes while keeping guidance.
- `TOKEN_OPTIMIZER_LARGE_READ_BYTES=<bytes>` changes the threshold.
- Codex and Copilot deny the large built-in read so the agent retries with
  `smart_read`.
- Gemini and Qwen deny before the built-in call runs and tell the active model
  to retry with the optimized MCP tool.
- OpenCode and Kilo reject through their native before-hook plugin bridge.

The environment variables are optional. Default mode injects guidance without
blocking normal operations.

## Notes

- `smart_read` is most useful for large files and repeat reads because cached
  re-reads return diffs.
- `optimize_text` stores bulky content outside context. `compress_text` is
  byte-oriented Brotli/base64 storage and can increase LLM token count if its
  encoded output is put back into context.
- Pin a version by replacing `@latest` in any configuration.
- Marketplace and registry publishing steps are in
  [`../docs/PUBLISHING.md`](../docs/PUBLISHING.md).
