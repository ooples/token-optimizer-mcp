# Kilo integration

Tier: **directive** -- Kilo exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge `kilo.jsonc` into your
   `.kilo/kilo.jsonc`.
2. Copy `token-optimizer.md` to `.kilo/rules/token-optimizer.md` in your project.

## Provenance

Verified against https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code
(kilo.jsonc with mcp key, type local, command ARRAY and environment -- confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
