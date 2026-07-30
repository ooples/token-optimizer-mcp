# Kilo Code integration

Tier: **directive** -- Kilo Code exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge `mcp_settings.json` into your
   `mcp_settings.json`.
2. Copy `token-optimizer.md` to `.kilocode/rules/token-optimizer.md` in your project.

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
