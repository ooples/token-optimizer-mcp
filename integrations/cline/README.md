# Cline integration

Tier: **native hook + rules** -- Cline's native lifecycle bridge routes expensive calls, captures structural graph evidence, and injects applicable findings. The rules require the active model to perform semantic wiki_write harvesting.

## Install

1. **MCP server** -- merge the contents of `mcp.json`
   (in this directory) into your `mcp.json`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.clinerules/token-optimizer.md` in your project.
3. **Hooks** -- copy the contents of `hooks/` to `.clinerules/hooks/`; on macOS/Linux mark the extensionless wrappers executable and enable them.


Both destinations are the paths Cline's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://docs.cline.bot/mcp/configuring-mcp-servers
(mcpServers key confirmed; CLI reads ~/.cline/mcp.json; project hooks use .clinerules/hooks with OS-specific wrappers).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
