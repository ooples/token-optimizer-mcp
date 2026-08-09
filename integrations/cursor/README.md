# Cursor integration

Tier: **native hook + rules** -- Cursor's native lifecycle bridge routes expensive calls, captures structural graph evidence, and injects applicable findings. The rules require the active model to perform semantic wiki_write harvesting.

## Install

1. **MCP server** -- merge the contents of `mcp.json`
   (in this directory) into your `.cursor/mcp.json`.
2. **Rules** -- copy `token-optimizer.mdc` (in this directory)
   to `.cursor/rules/token-optimizer.mdc` in your project.
3. **Hooks** -- copy `hooks/` to `.cursor/hooks/token-optimizer/`, then merge `hooks.json` into `.cursor/hooks.json`.


Both destinations are the paths Cursor's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://cursor.com/docs/context/rules
(rules path, .mdc extension and alwaysApply frontmatter confirmed; project hooks use .cursor/hooks.json).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
