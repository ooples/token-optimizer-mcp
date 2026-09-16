# Version 7 release verification

Date: 2026-09-16. Release PR: #345. Candidate base:
`8d2c42ac16e6f81688eb044fbcdd96462fd47d11`, plus the packaging and safe-edit fixes.

## Finding and fix

The first clean npm install failed Gemini certification: the npm allowlist
omitted `gemini-extension.json` and its `GEMINI.md` context file. Both are now
included. `npm run verify:package-contents` checks the actual npm pack file list
for 20 required CLI entrypoints and client assets. The publishing workflow runs
this gate after building and before publication.

The disk-full investigation also exposed direct writes in `smart_edit` that could
truncate the target on ENOSPC. Edits now write and flush a private temporary file
in the target directory before replacing the original. Failed writes/replacements
preserve the original even with backups disabled. The asynchronous implementation
follows symlink targets and preserves permission bits. Fault-injection tests cover
a partial write followed by ENOSPC and a denied rename.

## Artifact and environment

Verification used Windows, Node 22.15.0, npm 11.4.2, and new temporary installation
directories. No registry release was published. The final local tarball was built
using the release workflow's version stamping, build, and checksum generation:

`ooples-token-optimizer-mcp-7.0.0.tgz`

SHA-256: `0b174425e392c04855096404259c2f7272e743243c31939873e62c8f883d7e47`

This identifies the tested local artifact, not a future CI artifact. The report
was added afterward. Registry provenance remains a post-publication check.

## Completed checks

- Independent `npm ci` and build; generated hook synchronization check passed.
- Fresh production install from the packed archive; six CLI entrypoints present.
- Installed-package client certification: 16/16.
- Installed-package adapter process certification: 16/16, semantic parity true.
- Hook installation repeated with byte-identical settings (idempotent).
- MCP initialization identified server version 7.0.0. Read, cached repeat read,
  edit, and read-after-edit checks passed.
- Isolated installation doctor: 17/17 checks passed, including real hook
  enforcement and an MCP server probe.
- Production dependency audit: zero reported vulnerabilities.
- Forty focused integration tests passed across client certification, hooks,
  MCP stdio contracts, and tool profiles.
- Full suite before the safe-edit fix: 315 suites, 4,438 tests passed; 10 skipped.
  After the fix: 6 affected suites, 48 tests passed; 2 POSIX-specific tests skipped
  on Windows. These cover failure preservation, edit semantics, cache handoff,
  line endings, and the production MCP stdio contract.
- Final build and lint passed (zero lint errors; 541 existing warnings).
- All 1,844 checksum-listed files matched the built source. After npm installation,
  three executable scripts had only the expected CRLF-to-LF shebang normalization;
  the remaining content matched exactly. Checksums are a separate release asset.

## Live CLI results

The task read an 800-line file twice, located a marker, changed one state line,
read the updated file, and wrote a JSON result through MCP tools. An independent
comparison verified all 800 lines and the result. Tests used isolated project
state and existing account authentication.

| Client | Version | Result |
| --- | --- | --- |
| Codex | 0.154.0 | Passed direct MCP on the packaging fix; passed the final shipping artifact through the compression proxy (43.518 s), with provider HTTP 200 and usage accounting. |
| OpenCode | 1.17.12 | Passed the packaging fix and final shipping artifact; final run 54.776 s, eight MCP calls, zero MCP errors. |
| Claude Code | 2.1.272 | MCP initialized as 7.0.0; live model task pending because the weekly account quota is exhausted. |
| Copilot | 0.0.367 | MCP initialized as 7.0.0; live model task pending because the monthly account quota is exhausted (402). |
| Gemini | 0.28.0 | MCP initialized as 7.0.0; live model task pending because the account/client combination is rejected as ineligible. |
| Other client adapters | — | Process and configuration certification only; no claim of live model-task coverage. |

The user chose to retain current accounts and leave the three blocked live gates
pending. These task timings are smoke-test observations, not competitor benchmarks
or evidence of universal cost/speed superiority.
See [the structured live evidence](release-7-live-proof.json) for six successful
runs, cache-hit assertions, full-file comparisons, and final proxy accounting.

## Corrections and remaining gates

An initial Codex harness denied writes before they reached MCP; the isolated
fixture rerun with writes permitted passed. Initial Gemini hook-path and Copilot
MCP-schema harness errors were corrected before classifying account blockers.

The host doctor detected an existing Claude plugin at version 6 and a missing
Codex startup timeout. Those host configuration findings are distinct from the
isolated version 7 installation, which passed all doctor checks.

A disk-full event interrupted the full suite and a shipping OpenCode run. An
unused worktrees were removed to recover space. OpenCode then passed, preserving
all fixture lines. The complete suite rerun passed. Following the safe-edit fix,
a fresh package install and new Codex/proxy and OpenCode runs also passed.

Ship readiness remains conditional on the pending live gates. Cross-platform
permission/symlink tests still need a POSIX runner. This verification does not
establish that the release has no bugs.
