# Zed integration

Tier: **rules** -- Zed has no packaged lifecycle continuation, so its always-applied rules route expensive calls and require the active model to perform semantic wiki_write harvesting before completion.

## Install

1. **MCP server** -- merge the contents of `settings.json`
   (in this directory) into your `settings.json`.
2. **Rules** -- copy `AGENTS.md` (in this directory)
   to `AGENTS.md` in your project.


Both destinations are the paths Zed's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://zed.dev/docs/ai/mcp
(context_servers shape confirmed; no source key in the current schema).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
