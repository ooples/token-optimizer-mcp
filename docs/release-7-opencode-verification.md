# Version 7: managed OpenCode and Chat Completions

## Implemented

- Shell activation includes `opencode`. Its launcher supplies the packaged core
  MCP server and a per-session plugin through inline configuration; provider
  files and credentials stay in the client.
- The plugin routes explicit base URLs for OpenAI, OpenAI-compatible and Anthropic
  SDK providers through project-scoped proxies. Duplicate loading does not create
  nested proxies. Unsupported transports retain native routing. Built-in OAuth
  fetch implementations that replace a base URL are not certified by this work.
- A dedicated Chat Completions adapter compresses string tool results using the
  existing token gate, bounded caches, read protection and forward references.
  It preserves tool-call IDs, reasoning, tools, images and provider options.
  Graph knowledge uses a stable system message; Responses fields never leak into
  the Chat Completions request. Query parameters remain on the upstream request.
- Chat Completions prompt/completion usage is normalized in the ledger, with
  cached input retained as a subset. It is not counted twice.
- Managed launchers resolve the repository root before loading graph knowledge,
  matching MCP/hooks when started in a nested project directory. Non-repository
  paths use the existing shared-graph resolver and its scope restrictions.
- Claude managed routing is detected in local policy files, JSON drop-ins, and
  Windows registry policy. These routes remain native. Remote and macOS MDM policy
  can arrive outside this preflight; observed traffic is still required to claim
  proxy routing.

## Live verification

The [installed-package OpenCode receipt](release-7-opencode-proof.json) records
the existing configured Azure account, OpenCode 1.17.12, and a real model task.
All seven model requests returned HTTP 200 and received project knowledge. Six
MCP calls completed: repeated read, edit, verification read, write, and wiki query.
The independently checked result contains the injected marker and updated state;
the wiki lookup ran after writing the marker and found the same project finding.
Provider usage was present on every request.

The initial development attempt failed its artifact checks: the model invented
root-relative paths and requested a dry-run edit. That attempt remains at
`opencode-managed-j4I8Hu` under the release verification temporary directory. The
corrected fixture uses a Git project and explicit absolute paths, as the existing
Codex fixture does. The failed attempt is not counted as a pass.

The installed Codex task also passed again with nine successful model requests.
The real Claude binary passed against the synthetic local upstream. Its current
account model gate remains pending by user instruction.

## Installed HeadRoom comparison

[Audited local receipt](release-7-chat-comparison.json), HeadRoom 0.37.0 versus
the real HTTP proxy, eight synthetic cases, alternating arm order. The fixtures
vary row count and repeated observations. Both use the same loopback upstream;
HeadRoom's rate limit is disabled. Graph injection is disabled in this compression
probe; the installed live task separately verifies graph delivery. First requests include cold transforms, but
process startup is excluded. These are development measurements, not a powered
study or end-to-end agent-cost comparison.

| Mean per request | Token optimizer | HeadRoom |
| --- | ---: | ---: |
| Request latency, ms | 47.9 | 101.5 |
| Transmitted bytes | 1,733.1 | 19,458.8 |
| Estimated serialized-body tokens, o200k_base | 432.4 | 5,656.1 |

Token optimizer was smaller and faster on all eight cases. The independent
fixture oracle found the requested failed record and value in every first result
and reconstructed every original row from the recovery file while the proxy was
running. Non-tool messages and tool-call IDs were preserved. This verifies our
selected fixtures and recovery, not arbitrary task quality or billed savings.
Spill files are removed at proxy shutdown, so the audit runs before cleanup.

Reproduce after building with `node bench/live/chat-route-probe.mjs`.

## Remaining release gates

This does not clear the prior Codex JSON agent-speed loss, certify every provider
mode/CLI, or prove universal superiority. Account-blocked Claude/Copilot/Gemini
checks remain pending. Broader end-to-end performance confirmation and remote/MDM
enterprise deployments remain unverified. No release was published or merged.
