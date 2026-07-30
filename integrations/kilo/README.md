# Kilo integration

Tier: **directive** -- Kilo exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `kilo.jsonc`
   (in this directory) into your `.kilo/kilo.jsonc`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.kilo/rules/token-optimizer.md` in your project.

Both destinations are the paths Kilo's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code
(kilo.jsonc with mcp key, type local, command ARRAY and environment -- confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
