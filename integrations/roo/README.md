# Roo Code integration

Tier: **directive** -- Roo Code exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `mcp.json`
   (in this directory) into your `.roo/mcp.json`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.roo/rules/token-optimizer.md` in your project.

Both destinations are the paths Roo Code's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo
(mcpServers key and project-level .roo/mcp.json precedence confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
