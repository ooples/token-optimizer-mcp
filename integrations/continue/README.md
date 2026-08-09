# Continue integration

Tier: **rules** -- Continue has no packaged lifecycle continuation, so its always-applied rules route expensive calls and require the active model to perform semantic wiki_write harvesting before completion.

## Install

1. **MCP server** -- merge the contents of `config.yaml`
   (in this directory) into your `config.yaml`.
2. **Rules** -- copy `token-optimizer.md` (in this directory)
   to `.continue/rules/token-optimizer.md` in your project.


Both destinations are the paths Continue's own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against https://docs.continue.dev/reference
(mcpServers is a LIST of name/command/args -- confirmed).

Both files in this directory are generated from
`scripts/generate-client-configs.mjs`; edit that, not these.
