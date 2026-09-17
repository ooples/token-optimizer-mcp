# Version 7 verification status

Verified runtime source: `9e386efa`. No release was published or merged.

The fixes are maintained on `fix/release7-production-readiness`, targeting
`master`; Release Please PR #345 contains only its release preparation changes.
The receipts retain their original tested commit IDs and 7.0.0 tarball hashes.
Rebasing the fixes onto master removed only Release Please's version/changelog
changes; the runtime implementation is unchanged. Release Please owns the final
version bump after the fixes merge.

## Installation and default operation

[Fresh global-install receipt](release-7-global-install-proof.json): npm 11.4.2
installed the tarball into a new Windows prefix, adding 145 packages. With
ordinary piped lifecycle output, postinstall automatically created isolated
Claude hook settings, an install manifest, and a managed PowerShell profile.
No manual installer call was needed. The package contains all 28 required assets.

The installed copy passed these checks:

- Codex, through that automatically created profile: correct read/edit/write
  result and project graph marker; 14 model requests, all HTTP 200.
- OpenCode with the configured Azure account: correct read/edit/write result,
  project graph marker and subsequent wiki query; seven requests, all HTTP 200.
- Claude Code: the actual CLI completed against a local synthetic Anthropic
  upstream through its session proxy. This checks protocol/configuration routing,
  not account access or model correctness.

For both live model clients, graph injection was present and stable on every
request; the marker was written before any explicit wiki lookup. Core MCP tools,
wiki, balanced compression and session proxy behavior used their defaults.
The runtime dependency audit reported zero vulnerabilities.

## Correctness and performance

The full local test run finished with 328 passing suites and two failures in
checks affected by the lazy-schema and fresh-telemetry changes. Both checks were
corrected; their two suites and 14 tests passed on rerun. The full run recorded
4,500 passing tests and 12 skips. Nineteen targeted installation tests also passed
after the postinstall fix. This is a full run plus focused reruns, not a claim
that a second full run was performed.

[The log follow-up](release-7-log-cost-proof.json) passed eight of eight attempts
against the installed HeadRoom binary. All four pairs favored ours in agent time
and estimated cost: means of 17.10 versus 32.525 seconds and $0.119668 versus
$0.296643 under the recorded rate-card scenario. The earlier broader campaign,
including its losses, remains in [the original receipt](release-7-multiworkload-proof.json).

## Pending evidence

- Claude account quota, Copilot quota and Gemini account/client rejection gates
  remain pending at the user's direction; no alternate accounts were used.
- Independent broad workload confirmation remains necessary for claims about
  every task. These small development campaigns do not prove universal speed,
  cost or production reliability.
- Native routing remains in effect for unsupported provider modes and managed
  enterprise policies. Their live behavior is not certified by these checks.

Global setup requires package-manager lifecycle scripts to be enabled. Local
dependency installs and CI do not modify user profiles; the explicit
`token-optimizer-install` command activates those installations when desired.
