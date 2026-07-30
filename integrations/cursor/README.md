# Cursor integration

Tier: **directive** -- Cursor exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge `mcp.json` into your
   `.cursor/mcp.json`.
2. Copy `token-optimizer.mdc` to `.cursor/rules/token-optimizer.mdc` in your project.

## Provenance

Verified against https://cursor.com/docs/context/rules
(rules path, .mdc extension and alwaysApply frontmatter confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
