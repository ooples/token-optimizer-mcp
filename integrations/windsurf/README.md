# Windsurf integration

Tier: **native hook + rules** -- Windsurf's native lifecycle bridge routes expensive calls, captures structural graph evidence, and injects applicable findings. The rules require the active model to perform semantic wiki_write harvesting.

## Install

1. **MCP server** -- merge the contents of `mcp_config.json`
   (in this directory) into your `mcp_config.json`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.windsurf/rules/token-optimizer.md` in your project.
3. **Hooks** -- copy `hooks/` to `.windsurf/hooks/token-optimizer/`, then merge `hooks.json` into `.windsurf/hooks.json`.


Both destinations are the paths Windsurf's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://docs.windsurf.com/windsurf/cascade/memories
(directory form is current, .windsurfrules is legacy; Cascade pre/post hook contract verified).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
