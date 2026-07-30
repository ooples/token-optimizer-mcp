# Crush integration

Tier: **directive** -- Crush exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge `crush.json` into your
   `crush.json`.
2. Copy `AGENTS.md` to `AGENTS.md` in your project.

## Provenance

Verified against https://github.com/charmbracelet/crush
(mcp key with type:stdio confirmed; AGENTS.md is the project default).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
