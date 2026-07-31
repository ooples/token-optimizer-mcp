# Crush integration

Tier: **directive** -- Crush exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `crush.json`
   (in this directory) into your `crush.json`.
2. **Rules** -- copy `AGENTS.md` (in this directory)
   to `AGENTS.md` in your project.

Both destinations are the paths Crush's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://github.com/charmbracelet/crush
(mcp key with type:stdio confirmed; AGENTS.md is the project default).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
