# Windsurf integration

Tier: **directive** -- Windsurf exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `mcp_config.json`
   (in this directory) into your `mcp_config.json`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.windsurf/rules/token-optimizer.md` in your project.

Both destinations are the paths Windsurf's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://docs.windsurf.com/windsurf/cascade/memories
(directory form is current, .windsurfrules is legacy).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
