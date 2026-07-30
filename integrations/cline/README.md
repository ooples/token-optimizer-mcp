# Cline integration

Tier: **directive** -- Cline exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge `mcp.json` into your
   `mcp.json`.
2. Copy `token-optimizer.md` to `.clinerules/token-optimizer.md` in your project.

## Provenance

Verified against https://docs.cline.bot/mcp/configuring-mcp-servers
(mcpServers key confirmed; CLI reads ~/.cline/mcp.json, the VS Code extension reads cline_mcp_settings.json).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
