# Native CLI integrations

Token Optimizer runs the same MCP server in every client:

```text
npx -y @ooples/token-optimizer-mcp@latest
```

What differs is how each CLI loads instructions and lifecycle hooks. This
directory contains ready-made, client-native configurations; Claude Code's
seven-phase PowerShell hook system is documented separately and is not copied
unchanged into clients with different event contracts.

| Client             | MCP configuration                   | Guidance                    | Native lifecycle integration                     |
| ------------------ | ----------------------------------- | --------------------------- | ------------------------------------------------ |
| Codex              | `codex/config.toml` or Codex plugin | `AGENTS.md` or plugin skill | `codex/hooks/` or plugin `hooks/hooks.json`      |
| Claude Code        | `../plugin/.mcp.json`               | Plugin skill                | Plugin large-read hook; optional global pipeline |
| GitHub Copilot CLI | `copilot/mcp-config.json`           | `AGENTS.md`                 | `copilot/.github/hooks/`                         |
| Gemini CLI         | `gemini/gemini-extension.json`      | `gemini/GEMINI.md`          | `gemini/hooks/`                                  |
| OpenCode           | `opencode/opencode.json`            | `AGENTS.md`                 | `opencode/.opencode/plugins/`                    |

Prerequisite: Node.js 18 or newer so `npx` can launch the server. The first
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
`codex/hooks/token-optimizer-advisor.mjs` to `~/.codex/hooks/` and merge
`codex/hooks/hooks.json` into `~/.codex/hooks.json`; do not overwrite unrelated
hooks already present. Review and trust the new definition with `/hooks`.

The hooks inject guidance at `SessionStart` and advise on first-class large read
tools. Codex exposes shell reads such as `cat` or `Get-Content` as `Bash`, so the
adapter deliberately does not parse and rewrite arbitrary shell commands.

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

The hooks inject session guidance, advise after a large `view`, and provide an
opt-in `preToolUse` redirect. Repository hooks are easier to install safely than
overwriting user hooks.

## Gemini CLI

Recommended: install the extension, which bundles MCP, `GEMINI.md`, and native
`SessionStart`/`AfterTool` hooks.

```bash
gemini extensions install https://github.com/ooples/token-optimizer-mcp --auto-update
```

The standalone files under `gemini/` have the same structure if you want to
package the integration separately. Direct MCP setup is also available:

```bash
gemini mcp add --scope user token-optimizer npx -y @ooples/token-optimizer-mcp@latest
```

By default, the `AfterTool` hook suggests `smart_read` after a large full-file
read. Run `gemini extensions config token-optimizer` and set **Automatic
large-read routing** to `true` to use Gemini's native `tailToolCallRequest`; the
`smart_read` result then replaces the built-in result before it reaches the
model.

## OpenCode

Copy or merge the MCP configuration and instructions into a project:

```bash
cp opencode/opencode.json /path/to/project/
cp AGENTS.md /path/to/project/
mkdir -p /path/to/project/.opencode/plugins
cp opencode/.opencode/plugins/token-optimizer.js /path/to/project/.opencode/plugins/
```

The local plugin preserves Token Optimizer guidance during context compaction.
Its strict large-read redirect is opt-in because OpenCode's before-hook blocks
the original tool rather than transparently replacing its result.

## Hook behavior and controls

All adapters are fail-open for malformed payloads, missing files, small files,
and partial reads. The default threshold is 25,600 bytes.

- `TOKEN_OPTIMIZER_REDIRECT_LARGE_READS=true` enables strict native routing.
- `TOKEN_OPTIMIZER_LARGE_READ_BYTES=<bytes>` changes the threshold.
- Codex and Copilot deny the large built-in read so the agent retries with
  `smart_read`.
- Gemini replaces the result with an MCP tail call.
- OpenCode rejects the built-in read with a `smart_read` instruction.

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
