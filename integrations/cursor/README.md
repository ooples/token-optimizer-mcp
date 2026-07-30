# Cursor integration

Tier: **directive** -- Cursor exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `mcp.json`
   (in this directory) into your `.cursor/mcp.json`.
2. **Rules** -- copy `token-optimizer.mdc` (in this directory)
   to `.cursor/rules/token-optimizer.mdc` in your project.

Both destinations are the paths Cursor's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://cursor.com/docs/context/rules
(rules path, .mdc extension and alwaysApply frontmatter confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
