# Droid (Factory) integration

Tier: **directive** -- Droid (Factory) exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. **MCP server** -- merge the contents of `mcp.json`
   (in this directory) into your `mcp.json`.
2. **Rules** -- copy `AGENTS.md` (in this directory)
   to `AGENTS.md` in your project.

Both destinations are the paths Droid (Factory)'s own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://docs.factory.ai/cli/configuration/mcp
(mcpServers key confirmed; the CLI reads ~/.factory/mcp.json).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
