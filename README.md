# Token Optimizer MCP

> Give Codex, Claude, Cursor, and other MCP clients more room to think with cached context, compact diffs, smart tools, and visible token-savings reports.

[![npm version](https://img.shields.io/npm/v/%40ooples%2Ftoken-optimizer-mcp?logo=npm)](https://www.npmjs.com/package/@ooples/token-optimizer-mcp)
[![CI](https://github.com/ooples/token-optimizer-mcp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ooples/token-optimizer-mcp/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Token Optimizer is a local [Model Context Protocol](https://modelcontextprotocol.io/) server. It reduces the text sent back into an agent's context by caching large payloads, returning diffs on repeated reads, filtering noisy command output, and recording the result of every measurable optimization.

- **74 MCP tools** in the current release
- **No hosted service required** for core caching and compression
- **SQLite-backed persistence** across conversations
- **Brotli compression** with token-aware keep-or-skip decisions
- **Built-in savings reports** by tool, hook phase, and MCP server

## See it in action

![Token Optimizer savings report showing 117,915 tokens saved and a 53 percent reduction across three operations](./docs/assets/token-savings-report.png)

_Real `get_optimization_report` output from an MCP smoke run over this repository's tool reference, server source, and dependency lockfile. Savings vary with content and workflow._

## Install in Codex

### 1. Add the MCP server

```bash
codex mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest
```

On Windows, if PowerShell blocks the `codex.ps1` shim, use the command launcher directly:

```powershell
codex.cmd mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest
```

This writes the server to `~/.codex/config.toml`. Codex CLI, the Codex IDE extension, and the Codex app on the same host share that configuration.

### 2. Verify the installation

```bash
codex mcp get token-optimizer
codex mcp list
```

![Codex MCP list showing token-optimizer installed and enabled](./docs/assets/codex-mcp-installed.png)

Start a new Codex conversation after installation so the new tools are discovered. In an interactive CLI session, `/mcp` shows the tools available to the conversation.

### 3. Tell Codex when to use it

MCP registration makes the tools available; it does not transparently replace Codex's built-in file tools. Add the guidance from [`integrations/AGENTS.md`](./integrations/AGENTS.md) to your project `AGENTS.md`, or start with this smaller rule:

```markdown
## Token optimization

Use the token-optimizer MCP for large or repeated reads:

- `smart_read` for files over roughly 400 lines and for files already read once.
- `smart_glob`/`smart_grep` for large search results.
- `optimize_text` to store bulky text outside the model context.
- `get_optimization_report` when the user asks for token or compression stats.

Use normal tools for small, one-off operations.
```

### Equivalent manual Codex configuration

If you prefer to edit `~/.codex/config.toml` yourself:

```toml
[mcp_servers.token-optimizer]
command = "npx"
args = ["-y", "@ooples/token-optimizer-mcp@latest"]

# Optional: keep the cache in a custom location.
# env = { TOKEN_OPTIMIZER_CACHE_DIR = "/absolute/path/to/cache" }
```

## Use it

You normally use Token Optimizer by asking your agent in plain language:

```text
Use token-optimizer smart_read for the large server file, then use it again
after the edit so only the diff comes back.
```

```text
Cache this API response with optimize_text under the key customer-schema,
then retrieve it only if we need the full payload again.
```

```text
Show my token savings with get_optimization_report.
```

For clients that expose direct MCP tool calls, the core inputs are small JSON objects:

```json
{
  "tool": "smart_read",
  "arguments": {
    "path": "/absolute/path/to/large-file.ts"
  }
}
```

```json
{
  "tool": "optimize_text",
  "arguments": {
    "text": "A large response, log, document, or generated artifact...",
    "key": "stable-reference-key",
    "quality": 11
  }
}
```

```json
{
  "tool": "get_optimization_report",
  "arguments": {
    "topN": 10
  }
}
```

## Understand the compression stats

`optimize_text` returns measurements with every call. This example uses a deliberately repetitive payload to make every field easy to see; it is not a benchmark:

```json
{
  "success": true,
  "key": "customer-schema",
  "originalTokens": 4180,
  "compressedTokens": 72,
  "tokensSaved": 4108,
  "percentSaved": 99.55,
  "cached": true,
  "compressionUsed": true
}
```

`get_optimization_report` aggregates recorded operations into:

- original, optimized, and saved token totals;
- overall reduction percentage;
- operations tracked;
- breakdowns by action/tool, hook phase, and MCP server;
- optional date-range and session filters.

Two tools sound similar but serve different purposes:

| Tool            | Use it for                                                  | Context-window effect                                     |
| --------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `optimize_text` | Store bulky text under a key and return a compact reference | Reduces text kept in the active context                   |
| `compress_text` | Produce Brotli/base64 data for storage or transport         | May use **more** model tokens if pasted back into context |

If your goal is a smaller prompt, prefer `optimize_text`. Use `compress_text` only when you specifically need byte compression.

## What is included

| Capability              | Representative tools                                                                                | What gets smaller or faster              |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Context and compression | `optimize_text`, `get_cached`, `count_tokens`, `analyze_optimization`, `context_delta`              | Large payloads and repeated context      |
| File and Git operations | `smart_read`, `smart_write`, `smart_edit`, `smart_grep`, `smart_glob`, `smart_diff`, `smart_status` | File contents, search results, and diffs |
| Caching                 | `smart_cache`, `cache_warmup`, `cache_invalidation`, `cache_compression`, `predictive_cache`        | Repeated computation and retrieval       |
| APIs and databases      | `smart_api_fetch`, `smart_sql`, `smart_graphql`, `smart_rest`, `smart_schema`                       | Responses, schemas, and query analysis   |
| Build and system tasks  | `smart_build`, `smart_test`, `smart_lint`, `smart_logs`, `smart_processes`                          | Build logs and diagnostic output         |
| Intelligence            | `smart-summarization`, `pattern-recognition`, `natural-language-query`, `recommendation-engine`     | Analysis and summaries                   |
| Analytics               | `get_optimization_report`, `get_action_analytics`, `get_hook_analytics`, `export_analytics`         | Token-savings visibility                 |

See [`docs/TOOLS.md`](./docs/TOOLS.md) for detailed tool inputs and examples.

## Install in other CLI clients

Every client launches the same stdio server—`npx -y @ooples/token-optimizer-mcp@latest`—but stores its MCP configuration and agent instructions differently.

| Client             | Fastest setup                                                                                                | Verify                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Codex              | `codex mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest`                                 | `codex mcp get token-optimizer`   |
| Claude Code        | `claude mcp add --transport stdio --scope user token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest` | `claude mcp get token-optimizer`  |
| GitHub Copilot CLI | `copilot mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest`                               | `copilot mcp get token-optimizer` |
| Gemini CLI         | `gemini mcp add token-optimizer npx -y @ooples/token-optimizer-mcp@latest --scope user`                      | `gemini mcp list`                 |
| OpenCode           | Add the `mcp` block below to `opencode.json`                                                                 | `opencode mcp list`               |

### Claude Code

Add Token Optimizer for your user so it is available in every project:

```bash
claude mcp add --transport stdio --scope user token-optimizer -- \
  npx -y @ooples/token-optimizer-mcp@latest

claude mcp get token-optimizer
claude mcp list
```

Inside Claude Code, `/mcp` shows the live connection and tools. Add the recommendations from [`integrations/AGENTS.md`](./integrations/AGENTS.md) to your project's `CLAUDE.md` so Claude knows when the smart tools are preferable.

For the richest Claude Code integration, install the repository's plugin instead. It bundles the MCP server, optimization skill, and large-read hook. Run these commands **inside Claude Code**:

```text
/plugin marketplace add ooples/token-optimizer-mcp
/plugin install token-optimizer@token-optimizer
/reload-plugins
```

The optional standalone hook installer is also available through an interactive global npm install:

```bash
npm install -g @ooples/token-optimizer-mcp@latest
```

CI and local dependency installs skip automatic hook setup. See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) and this project's [hook installation guide](./docs/HOOKS-INSTALLATION.md).

### GitHub Copilot CLI

On current Copilot CLI releases, add the server to the user-level `~/.copilot/mcp-config.json` through the CLI:

```bash
copilot mcp add token-optimizer -- npx -y @ooples/token-optimizer-mcp@latest
copilot mcp get token-optimizer
copilot mcp list
```

Copilot can use the tools immediately after they connect. Put the guidance from [`integrations/AGENTS.md`](./integrations/AGENTS.md) in your repository `AGENTS.md`, or adapt it to `.github/copilot-instructions.md`.

If your Copilot CLI does not yet expose the `copilot mcp` command, use manual configuration:

```json
{
  "mcpServers": {
    "token-optimizer": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@ooples/token-optimizer-mcp@latest"],
      "tools": ["*"]
    }
  }
}
```

Save that as `~/.copilot/mcp-config.json` for all projects or `.github/mcp.json` for one repository. A ready-made copy is in [`integrations/copilot/mcp-config.json`](./integrations/copilot/mcp-config.json). See [GitHub's Copilot CLI MCP guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

### Gemini CLI

Add a user-scoped stdio server and verify it:

```bash
gemini mcp add token-optimizer npx -y @ooples/token-optimizer-mcp@latest --scope user
gemini mcp list
```

Run `/mcp` inside Gemini CLI to inspect the connection. For tool-selection guidance, copy [`GEMINI.md`](./GEMINI.md) into your project or add the equivalent instructions to your existing file.

You can also install this repository as a Gemini extension, which packages the MCP configuration and `GEMINI.md` together:

```bash
gemini extensions install https://github.com/ooples/token-optimizer-mcp --auto-update
gemini extensions list
```

Restart Gemini CLI after installing or updating an extension. See the official [Gemini MCP guide](https://geminicli.com/docs/tools/mcp-server/) and [extension guide](https://geminicli.com/docs/extensions/reference/).

### OpenCode

Create or update `opencode.json` in your project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "token-optimizer": {
      "type": "local",
      "command": ["npx", "-y", "@ooples/token-optimizer-mcp@latest"],
      "enabled": true
    }
  },
  "instructions": ["./AGENTS.md"]
}
```

Copy [`integrations/AGENTS.md`](./integrations/AGENTS.md) to the project as `AGENTS.md`, then verify the connection:

```bash
opencode mcp list
```

For a global installation, merge the same `mcp` entry into `~/.config/opencode/opencode.json`. OpenCode also provides an interactive `opencode mcp add` wizard. See the [OpenCode MCP guide](https://opencode.ai/docs/mcp-servers/).

### Generic MCP configuration

Any stdio-capable MCP client can launch Token Optimizer with:

```json
{
  "mcpServers": {
    "token-optimizer": {
      "command": "npx",
      "args": ["-y", "@ooples/token-optimizer-mcp@latest"]
    }
  }
}
```

Additional ready-made integration files are available for [Claude Desktop](./examples/claude_desktop_config.json), [Codex](./integrations/codex/config.toml), [Gemini CLI](./integrations/gemini/), [OpenCode](./integrations/opencode/), and [GitHub Copilot](./integrations/copilot/mcp-config.json).

## How it works

1. Your MCP client calls a smart tool instead of returning the largest raw result.
2. Token Optimizer counts the original content and chooses whether compression or caching is worthwhile.
3. Large content is kept in a local SQLite cache and represented by a compact result or key.
4. Repeated reads can return a diff instead of the entire file.
5. Measurable operations are recorded for `get_optimization_report`.

Core caching and compression run locally. Tools that explicitly access an API, database, or system command only do so when invoked.

## Requirements and data

- Node.js 18 or newer
- npm 9 or newer
- An MCP client with stdio transport support

Default local data locations include:

- cache: `~/.token-optimizer-cache/`
- analytics: `~/.token-optimizer-mcp/analytics.db`
- sessions and configuration: `~/.token-optimizer/`

Set `TOKEN_OPTIMIZER_CACHE_DIR` to override the cache location.

## Troubleshooting

### The tools do not appear in Codex

1. Run `codex mcp get token-optimizer`.
2. Confirm the entry is enabled with `codex mcp list`.
3. Start a new Codex conversation.
4. Run `/mcp` in the interactive CLI and inspect the server status.

### `codex` is blocked on Windows

PowerShell may reject the `codex.ps1` shim under a restrictive execution policy. Use `codex.cmd` for the installation and verification commands, or review your user-scoped PowerShell execution policy.

### The first call is slower

The first `npx` launch may download the npm package, and the first operation has no warm cache. Later launches and repeated operations should be faster.

### Savings are lower than the examples

This is normal for short, unique, or already-compressed content. The largest gains come from repetitive logs, large generated files, API payloads, and repeated reads. Token Optimizer skips compression when it would not help.

### Remove it from Codex

```bash
codex mcp remove token-optimizer
```

This removes the Codex registration; it does not delete your local cache or analytics database.

## Development

```bash
git clone https://github.com/ooples/token-optimizer-mcp.git
cd token-optimizer-mcp
npm ci
npm run build
npm test
node scripts/mcp-smoke.mjs
```

To make Codex use your local build while developing:

```bash
codex mcp add token-optimizer-local -- node /absolute/path/to/token-optimizer-mcp/dist/server/index.js
```

## Documentation

- [Quick start](./docs/QUICK_START_GUIDE.md)
- [Tool reference](./docs/TOOLS.md)
- [Codex and agent guidance](./integrations/AGENTS.md)
- [Hook installation](./docs/HOOKS-INSTALLATION.md)
- [Testing](./docs/TESTING_INSTRUCTIONS.md)
- [Contributing](./docs/CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Changelog](./CHANGELOG.md)

## License

[MIT](./LICENSE) © ooples
