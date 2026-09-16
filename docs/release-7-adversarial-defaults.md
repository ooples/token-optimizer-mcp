# Adversarial review: version 7 default activation

Reviewed the installer, launcher, account/provider selection, graph resolution,
and removal path after commit `926a24a8`. Its Linux and Windows release CI passed
([run 35156569819](https://github.com/ooples/token-optimizer-mcp/actions/runs/35156569819));
the findings below demonstrate why those green checks were insufficient.

## Findings fixed

| Severity | Failure | Correction and regression evidence |
| --- | --- | --- |
| High | Direct profile writes could truncate personal settings on ENOSPC. | Locked temporary writes, flush and rename; stale-content checks, hard-link rejection and permission preservation. Partial-write fault injection leaves the original intact and releases the lock. |
| High | UTF-16 PowerShell profiles were decoded as UTF-8. | Preserve UTF-16LE and existing BOMs; retain byte-faithful backups; add a UTF-8 BOM when PowerShell needs it for non-ASCII paths. Invalid encodings fail before changing files. |
| High | Uninstall removed anything between our markers, including later user edits. | Verify an ownership checksum; edited or duplicate blocks are rejected. Preflight all profiles before modifying any of them. |
| High | Codex profile files and unquoted configuration overrides could select a different provider from the launcher. | Read named profile files, honor CLI override syntax, and retain custom provider authentication in client configuration. Tests cover profile files and unquoted provider IDs. |
| High | Claude settings-file environment could override the proxy's shell environment and bypass routing. | Resolve user/project/local/explicit settings precedence and create a private invocation overlay containing the loopback URL. Preserve explicit settings and remove the overlay on exit. A real Claude binary passed against a synthetic local upstream. |
| Medium | Creating `.bash_profile` could suppress an existing `.bash_login` or `.profile`. | Select the existing Bash login profile in Bash's precedence order. |
| Medium | Percent-encoded installed paths silently disabled graph loading. | Convert module URLs using `fileURLToPath`; test an installed layout with spaces and Unicode. Use the same explicit wiki-directory resolver as MCP and hooks. |
| Medium | New Responses tasks sharing an initial AGENTS message reused an older task's knowledge block. | Identify the complete user setup before the first assistant/tool turn; regression checks fresh findings on a new task and unchanged knowledge on continuation turns. |

Claude's environment precedence was checked against its
[official reference](https://code.claude.com/docs/en/env-vars#precedence).
Codex profile-file and override syntax were checked against the installed
0.154.0 CLI's `--help`, rather than assuming earlier profile behavior still applied.

## Additional guardrails

### Follow-up review

- Replaced the premature "proxy active" banner with listener startup followed by
  evidence from observed model requests. Telemetry does not establish model
  routing. Exit summaries separate compression and graph injection; zero-model
  sessions explicitly remain unverified, including potential managed-policy
  overrides. These observations do not certify provider success or billed savings.
- Extended worktree isolation to Claude's `--worktree=NAME` and `-w NAME` forms.
  A seeded-graph regression proves the launching project's finding reaches a
  normal session and is absent from client-selected worktree sessions.
- Preserve Claude's first-party MCP tool search when routing through loopback.
  Its [environment reference](https://code.claude.com/docs/en/env-vars) documents
  that non-first-party base URLs otherwise disable native deferral. Explicit
  settings and third-party gateways retain their existing choices. A real HTTP
  proxy test preserves deferred tool definitions, tool references, beta headers,
  and response content. Account-backed Claude validation remains pending.

The three affected suites passed 58 checks. Changed-file lint passed. The real
Claude binary completed the synthetic local-server task, with one model request
observed separately from its telemetry request.

### Combined configuration comparison

[Audited receipt](release-7-combined-comparison.json): two balanced JSON pairs,
fresh seeds 1900000402–1900000403, installed HeadRoom 0.37.0 versus core MCP plus
the proxy. All four attempts passed independent answer, exposure, and provider
usage checks. This uses the existing benchmark harness, not the managed launcher;
the fresh fixture projects had no seeded graph findings.

| Mean per task | Core MCP + proxy | HeadRoom |
| --- | ---: | ---: |
| Input tokens | 40,521.5 | 49,465 |
| Agent time, seconds | 18.35 | 15.75 |
| Total time including proxy startup, seconds | 19.35 | 44.00 |

Estimated token cost was 22.0% lower under the existing frozen 10/1/50 rate-card
scenario; these are not invoices. Agent time was 16.5% worse despite lower total
time. Both pairs lost on agent speed, so this is a remaining optimization target,
not evidence of across-the-board superiority. Two development pairs provide no
high-confidence production-wide claim. Raw captures remain at the local evidence
path recorded in the receipt.

- Local/remote Codex and alternate Claude cloud-provider modes retain native
  routing with an explicit notice. They are not counted as optimized traffic.
- Unknown pre-login/keyring authentication retains native routing; the launcher
  no longer guesses the OpenAI endpoint from an absent `auth.json`.
- Client-created worktrees keep compression but disable graph injection because
  their eventual project root is not known when the launcher starts.
- Base URLs containing userinfo, query parameters or fragments are rejected
  rather than silently changing their meaning.

## Validation and remaining gates

Five targeted suites passed locally, 58 tests total, covering installation failure
safety, routing, graph loading, Responses prefix stability and existing proxy
contracts. Build, changed-file lint and the npm contents gate passed. New
adversarial suites are included in the Linux/Windows release CI matrix.

[Hardening CI run 35158419184](https://github.com/ooples/token-optimizer-mcp/actions/runs/35158419184)
passed all 15 suites at `b163a357`: 137 tests on Linux and 135 tests plus two
POSIX-only skips on Windows. The subsequent conversation-key regression passed
locally, and the repacked installation passed the current-account Codex task
again with the same 278-character block on all nine Responses requests.

The real Claude binary check used synthetic credentials and a local streaming
response stub. It proves settings-based routing and protocol compatibility; it
does not clear the exhausted account's live model gate. The current-account
Codex installed-package receipt is recorded separately in
[release-7-defaults-proof.json](release-7-defaults-proof.json).

Still open: account-blocked Claude/Copilot/Gemini model checks, managed routing for
other CLIs and unsupported provider modes, managed enterprise settings behavior,
and cost/performance comparisons for the newly enabled default combination.
Green tests and successful activation do not establish superiority on every task.
