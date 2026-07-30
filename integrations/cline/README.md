# Cline integration

Tier: **directive** -- Cline exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `mcp.json`
   (in this directory) into your `mcp.json`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.clinerules/token-optimizer.md` in your project.

Both destinations are the paths Cline's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://docs.cline.bot/mcp/configuring-mcp-servers
(mcpServers key confirmed; CLI reads ~/.cline/mcp.json, the VS Code extension reads cline_mcp_settings.json).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
