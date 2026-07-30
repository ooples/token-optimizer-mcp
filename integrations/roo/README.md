# Roo Code integration

Tier: **directive** -- Roo Code exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge `mcp.json` into your
   `.roo/mcp.json`.
2. Copy `token-optimizer.md` to `.roo/rules/token-optimizer.md` in your project.

## Provenance

Verified against https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo
(mcpServers key and project-level .roo/mcp.json precedence confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
