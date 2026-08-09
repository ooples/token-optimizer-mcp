# Kilo integration

Tier: **native hook + rules** -- Kilo's native lifecycle bridge routes expensive calls, captures structural graph evidence, and injects applicable findings. The rules require the active model to perform semantic wiki_write harvesting.

## Install

1. **MCP server** -- merge the contents of `kilo.jsonc`
   (in this directory) into your `.kilo/kilo.jsonc`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.kilo/rules/token-optimizer.md` in your project.
3. **Hooks** -- copy `.kilo/plugin/token-optimizer.js` to the same project path, and copy `hooks/` to `.kilo/hooks/token-optimizer/`.


Both destinations are the paths Kilo's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code
(kilo.jsonc MCP schema confirmed; Kilo plugin tool before/after and system-transform hooks verified).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
