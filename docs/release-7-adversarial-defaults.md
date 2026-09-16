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

Claude's environment precedence was checked against its
[official reference](https://code.claude.com/docs/en/env-vars#precedence).
Codex profile-file and override syntax were checked against the installed
0.154.0 CLI's `--help`, rather than assuming earlier profile behavior still applied.

## Additional guardrails

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

The real Claude binary check used synthetic credentials and a local streaming
response stub. It proves settings-based routing and protocol compatibility; it
does not clear the exhausted account's live model gate. The current-account
Codex installed-package receipt is recorded separately in
[release-7-defaults-proof.json](release-7-defaults-proof.json).

Still open: account-blocked Claude/Copilot/Gemini model checks, managed routing for
other CLIs and unsupported provider modes, managed enterprise settings behavior,
and cost/performance comparisons for the newly enabled default combination.
Green tests and successful activation do not establish superiority on every task.
