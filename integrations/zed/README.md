# Zed integration

Tier: **directive** -- Zed exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

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
