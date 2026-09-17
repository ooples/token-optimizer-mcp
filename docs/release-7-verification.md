# Version 7 release verification

Date: 2026-09-16. Release PR: #345. Candidate base:
`8d2c42ac16e6f81688eb044fbcdd96462fd47d11`, plus the packaging and safe-edit fixes.

## Finding and fix

The [startup follow-up](release-7-startup-verification.md) removes unused encoder
allocations and records before/after MCP startup and memory measurements.

### Dependency audit follow-up

The 2026-09-16 registry audit reported no runtime findings, but 11 development
dependency findings. The compatible lockfile refresh updates npm's bundled
dependencies, ESLint's configuration loader, and cosmiconfig. The security
overrides now select js-yaml 4.3.2 and qs 6.16.0. After an incremental install,
`npm audit` reports zero findings across all 1,190 audited packages. Build, lint,
and the ten targeted lifecycle/model-count regressions pass with that installed
tree. Registry audit results are time-specific, not a guarantee of no defects.

### Default activation follow-up

The subsequent [adversarial review](release-7-adversarial-defaults.md) found and
fixed profile corruption/ownership hazards, provider-selection mismatches,
Claude settings precedence, and graph loading from encoded installation paths.

The installer now activates managed `claude`, `codex`, and `opencode` commands in supported
shell profiles. A new shell loads the activation; each session starts and owns a
loopback proxy, registers the packaged MCP server, and closes its proxy on exit.
Explicit proxy, knowledge, MCP-registration and global opt-outs remain available.
Uninstall removes the managed profile block while retaining unrelated settings.
The core profile includes wiki tools; balanced compression, zero small-tool
exemption and tool deferral remain the defaults. Knowledge injection is now on
by default and reported separately from compression savings.

[Default installation proof](release-7-defaults-proof.json) records a real Codex
run through the installed PowerShell activation, with no proxy-enable or profile
override. Nine Responses requests returned HTTP 200 and each carried the same
278-character graph block. The task read twice, edited and verified a fixture,
wrote the correct marker, and queried the wiki. No wiki lookup occurred before
writing the marker. An earlier apparent pass was rejected because the model had
retrieved the marker through `wiki_read`; auditing it exposed Codex's
`additional_tools` setup item, now covered by the prefix-injection regression.

Seven focused suites passed locally (88 tests), followed by the added real-shape
regression and custom-profile regression. Build, changed-file lint, generated
integration checks and the package gate passed (21 required assets). The CI
release gate now includes managed-client, proxy, Responses knowledge and doctor
coverage. Claude transport/auth preservation and proxy shutdown were checked
against a local mock upstream; its real model task remains quota-blocked.

The [OpenCode follow-up](release-7-opencode-verification.md) adds managed routing
for explicit OpenAI/Anthropic-compatible provider endpoints, Chat Completions
compression and graph injection, current-account installed-package evidence, and
an independently audited local comparison against installed HeadRoom. It also
adds local enterprise routing-policy detection and nested-project graph resolution.
Nine targeted suites passed 110 checks; the subsequent launcher hardening passed
21 checks across its three affected suites. Build, changed-file lint and the package
gate passed, with 24 required assets checked in the tarball.

Other clients retain their existing MCP/hooks integrations. This follow-up does not establish
universal routing, net cost superiority, or completion of the previously pending
account-dependent live gates. The receipt identifies the tested tarball and the
small subsequent launcher changes covered by targeted tests.

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
a partial write followed by ENOSPC and a denied rename. Commits are serialized
per target within one server, and an exclusive filesystem lock prevents two
separate `smart_edit` servers from committing over each other. Stale edits are
rejected. Hard-linked targets are rejected without modifying either filename.
A separate test preserves an external change made while the temporary file is
being written. Arbitrary external editors do not participate in our lock protocol.

The adversarial review also found `hooks/logs/dispatcher.log` in the earlier local
tarball. The npm file allowlist now explicitly excludes runtime logs, databases
and journals, temporary files, edit locks, local state/cache directories, and
environment files. The package gate rejects these artifacts if any get through.

Locks are released after success or failure. If a server is killed mid-edit, its
lock is deliberately not stolen: the next edit reports the lock path and recovery
instructions. The lock contains the owner's PID and start timestamp. Confirm that
owner has stopped before removing an abandoned lock; age alone is not sufficient.
This preserves the original file rather than risking a paused writer resuming.

## Artifact and environment

Verification used Windows, Node 22.15.0, npm 11.4.2, and new temporary installation
directories. No registry release was published. The final local tarball was built
using the release workflow's version stamping, build, and checksum generation:

`ooples-token-optimizer-mcp-7.0.0.tgz`

SHA-256: `ec07f3df0dd3f0a7e122e14d00b96c58200bd02046fe3da3e74420d2c2fa4da8`

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
  The subsequent concurrency guards passed all five storage-failure/concurrency
  cases locally and the focused release job on Linux, including POSIX tests.
- Final build and lint passed (zero lint errors; 541 existing warnings).
- Adversarial-review fixes: 44 focused tests passed locally; two POSIX-specific
  cases skipped on Windows. The cross-process exclusion and killed-owner tests
  also passed against the freshly installed tarball. Its hard-link probe rejected
  the edit, preserved both names and their shared inode, and left no lock/temp
  file. The 1,990-file tarball contains no runtime artifacts, including the log
  discovered in the previous artifact. A package regression checks exclusions
  against synthetic runtime data placed inside allowed directories.
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
| Codex | 0.154.0 | Passed direct MCP on the packaging fix; passed the final shipping artifact through the compression proxy (119.927 s), with provider HTTP 200 and usage accounting. |
| OpenCode | 1.17.12 | Passed the packaging fix and final shipping artifact; final run 56.545 s, seven MCP calls, zero MCP errors. |
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

A disk-full event interrupted the full suite and a shipping OpenCode run.
Unused worktrees were removed to recover space. OpenCode then passed, preserving
all fixture lines. The complete suite rerun passed. Following the safe-edit fix,
a fresh package install and new Codex/proxy and OpenCode runs also passed.

The new release CI job runs focused checks on Linux and Windows. The moving
Windows runner's VS 18 installation was not recognized by its bundled node-gyp
during better-sqlite3 installation. Windows verification therefore uses the
VS 2022 runner. A native compiler toolchain is needed when SQLite builds from
source; this is not evidence of installation on a machine without build tools.

[CI run 35151419912](https://github.com/ooples/token-optimizer-mcp/actions/runs/35151419912)
verified code commit `ca684f6b`: six suites passed on each OS, with 52 tests
passing on Linux and 50 passing plus two POSIX-only skips on Windows. Both jobs
also passed clean dependency installation, generated-artifact checks, build,
and the npm package contents gate. The later adversarial-review fixes are recorded
separately below.

[Adversarial-fix CI run 35153105825](https://github.com/ooples/token-optimizer-mcp/actions/runs/35153105825)
verified code commit `b15b331e`: all eight suites passed on Linux (56 tests) and
Windows (54 tests, two POSIX-only skips). This adds actual child-process lock
contention, killed-owner behavior, hard-link rejection, and npm runtime-artifact
exclusions to the prior checks. The final tarball above was freshly installed;
the process-lock probes, hard-link probe, doctor, all 16 client/adapter checks,
and live Codex/proxy and OpenCode tasks passed against that installation.

Ship readiness remains conditional on the pending live gates. This verification
does not establish that the release has no bugs.
