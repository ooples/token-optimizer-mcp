# Client support

Sixteen clients are supported at the strongest level their current protocol
allows. The old two-tier table was stale: it incorrectly said Gemini and Qwen
had no pre-tool veto and omitted newer Cursor, Cline, Windsurf, and Kilo hook
surfaces.

## Capability matrix

The tier is a protocol guarantee, not a product preference. A rules/MCP-only
client cannot observe arbitrary built-in shell or file operations, so it is
never presented as having native automatic capture.

| Client group                                                   | Tier                   | Automatic guarantee                                                                |
| -------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| Claude Code, Codex, Copilot CLI, Gemini CLI, Qwen Code, Cursor | lifecycle continuation | native routing/capture/delivery and one active-model completion reflection         |
| Cline, OpenCode, Kilo, Windsurf                                | native observation     | native routing/capture/delivery; semantic write through the active-model rule      |
| Roo Code, Zed, Amp, Continue, Crush, Droid                     | MCP + rules            | MCP-visible activity and explicit graph tools; no claim over hidden built-in calls |

The executable registry in `hooks-core/capabilities.mjs` contains the exact
per-client surfaces and prevents the adapter, generator, verifier, dashboard,
and certification report from inventing different matrices.

“Active-model semantic harvest” always means the model doing the work decides
whether a durable, non-obvious conclusion exists and calls `wiki_write` itself.
No supported path delegates that judgment to a detached harvesting model.

## One decision engine

Every native command-hook client runs the decision and graph engine in
[`hooks-core/`](../hooks-core); generated entry files only name the client and
event. OpenCode and Kilo bridge their in-process plugin APIs into those same
generated entries. Clients without command hooks receive rules generated from
one source in `scripts/generate-client-configs.mjs`.

This is deliberate. Before it, Claude Code, Codex and Gemini each carried their
own copy of the threshold constant and the guidance string, and they had already
drifted. Client integrations now differ only where the protocol differs.

```bash
npm run sync:hooks          # regenerate vendored copies, entries, and configs
npm run sync:hooks:check    # CI gate: fails if any copy has drifted
npm run verify:certification # structured protocol certification for all 16
node scripts/certify-clients.mjs --json # also detects installed exact versions
```

The core is vendored into each native client directory rather than imported, because
each client executes hooks from a directory it controls (`~/.codex/hooks`, the
Gemini extension path, the Claude Code plugin root) and no shared location
resolves across all of them. `sync:hooks:check` is what keeps vendoring honest.

All native lifecycle paths also import the same privacy-safe observability core.
Each invocation produces one correlated completion event whether it succeeds,
skips unusable input, times out, or fails open after an exception. The version
stamped into vendored hooks comes from `package.json` during `sync:hooks`, so a
mixed installation is visible in diagnostics instead of looking like a product
logic failure. Claude Code's custom SessionStart, PreToolUse, and PreCompact
paths are explicitly instrumented rather than being mistaken for generated
adapter entries.

## How these were verified

Every config shape was checked against the client's own published documentation,
and the URL is recorded in each integration's README. That check found four real
errors, each of which would have failed **silently** -- the file installs, the
client reports nothing, and the server never loads:

| Client   | Was                                | Should be                                                                                                                                                                     |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kilo** | `mcp_settings.json` / `mcpServers` | **wrong at the schema level.** Kilo rebranded; it reads `kilo.jsonc` under an `mcp` key, with `type: "local"`, `command` as an **array**, and `environment` rather than `env` |
| Zed      | a `source` key                     | not in the current schema; removed                                                                                                                                            |
| Windsurf | `.windsurfrules`                   | the legacy single-file form; now `.windsurf/rules/`                                                                                                                           |
| Crush    | `CRUSH.md`                         | the per-user file; the project one is `AGENTS.md`                                                                                                                             |
| Cline    | `cline_mcp_settings.json`          | the VS Code filename; the CLI reads `~/.cline/mcp.json`                                                                                                                       |
| Roo      | `mcp_settings.json`                | the global path; project-level `.roo/mcp.json` takes precedence                                                                                                               |

Kilo is the one worth dwelling on: **six of ten clients share the `mcpServers`
convention, and assuming the seventh did too would have shipped a config that
could never load.** Conventions are not schemas.

`npm run verify:clients` asserts these shapes on every run, including that
superseded paths stay deleted and that rule-only clients do not claim a native
veto they do not have.

All ten generated configuration shapes are confirmed against published documentation,
with the source URL recorded in each integration's README.

## Configuration, all clients

The MCP server advertises its 18 essential tools by default. Set
`TOKEN_OPTIMIZER_TOOL_PROFILE=full` in the server environment only when a client
needs the complete 102-tool specialist catalog. Use the four-operation
`cognitive` profile for UCR/live-graph sessions; its measured static schema is
1,162 `cl100k_base` tokens versus 30,593 for the full catalog.

| Variable                                | Default   | Effect                                   |
| --------------------------------------- | --------- | ---------------------------------------- |
| `TOKEN_OPTIMIZER_MODE`                  | `enforce` | `advise` = never refuse; `off` = disable |
| `TOKEN_OPTIMIZER_LARGE_READ_BYTES`      | `25600`   | Size at which a read stops being cheap   |
| `TOKEN_OPTIMIZER_PRECOMPACT_TIMEOUT_MS` | `8000`    | Cap on pre-compaction work               |
| `TOKEN_OPTIMIZER_LOG_DIR`               | state logs | Structured lifecycle JSONL directory     |
| `TOKEN_OPTIMIZER_LOG_MAX_BYTES`         | `5242880` | Rotate an active lifecycle log at size   |
| `TOKEN_OPTIMIZER_LOG_RETENTION_DAYS`    | `14`      | Maximum lifecycle log age                |
| `TOKEN_OPTIMIZER_LOG_MAX_FILES`         | `40`      | Maximum retained lifecycle log files     |

An unrecognised `TOKEN_OPTIMIZER_MODE` falls back to `enforce`, so a typo cannot
quietly turn the product off.
