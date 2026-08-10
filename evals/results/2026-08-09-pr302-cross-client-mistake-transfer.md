# PR #302 cross-client mistake-transfer cohort — August 9, 2026

## Verdict

The live graph's storage and cross-client delivery chain works in the tested
cohort. Its effectiveness is **not established**, and one concurrent cohort was
harmful.

- Codex `0.147.0` / `gpt-5.6-sol` and Claude Code `2.1.225` /
  `claude-sonnet-5` each naturally harvested a qualifying finding.
- Fresh same-client and cross-client consumers received the exact producer
  finding at `SessionStart`, before the first preventable action.
- The matched cross-client controls had 10/10 correct consumers and 0/10
  executed recurrences. Because both empty arms already had zero recurrence,
  the cohort cannot show a recurrence reduction.
- Three concurrent Codex writers produced three independently acknowledged
  findings. The graph had zero malformed lines, orphaned findings, or lost
  accepted writes, and a later Claude consumer received 3/3 findings.
- That natural concurrent consumer failed all three hidden end-state/proof
  graders while its empty-graph match passed. Correctness takes precedence over
  the natural arm's lower token, tool, latency, and cost totals.
- Irrelevant and stale controls were listed at `SessionStart`. They caused no
  correctness regression in the single-task cross-client cohort, but irrelevant
  delivery failed the stricter negative-control requirement and was expensive.
- The graph text was only 81 tokens in each single-finding handoff and 141 tokens
  in the three-finding concurrent handoff. A no-system comparison nevertheless
  found substantial full-integration overhead, especially for Codex. The likely
  issue is the plugin/MCP tool and behavior surface, not graph text alone.

The dashboard therefore reports `insufficient randomized evidence`; no
"smarter" or net-efficiency claim is made.

## Protocol and isolation

- Pre-registration: `docs/CROSS_CLIENT_MISTAKE_TRANSFER_PROTOCOL.md`.
- Scenario reported here: `verification-entry-point` for the five-arm and
  same-client cohorts; all three registered scenarios for concurrency.
- Consumer arms: `empty`, `natural`, `oracle`, `irrelevant`, and `stale`.
- Every matched arm received the same frozen post-producer workspace. CLI
  transcripts, session state, `AGENTS.md`, `CLAUDE.md`, auto-memory, `.codex`,
  `.claude`, and `.token-optimizer` were not copied.
- Codex used a PR-only local plugin cache and a config-level MCP command pinned
  to this checkout's built `dist/server/index.js`. The MCP graph, shared graph,
  state, audit, episode, pair, task, model, and client values were passed
  explicitly because Codex does not inherit those environment variables into an
  MCP subprocess.
- Claude used only project settings, an explicit PR plugin directory, a strict
  local MCP config, and non-persistent print sessions.
- The no-system Codex baseline used `--ignore-user-config`, zero project-document
  budget, memory off, and no plugins/MCP. The Claude baseline used no plugin and
  a strict empty MCP config.
- Hidden audit sentinels and filesystem end state determined correctness. Model
  prose was never the grader.
- Published ledgers contain hashes, identities, finding IDs, usage, timing,
  grades, and redacted diagnostics; no transcripts are included.

## Matched cross-client controls

### Codex producer → Claude consumer

All rows used clean commit `261c836` and one matched pair.

| Arm | Correct | Attempted | Executed | Delivery | Injected | Total tokens | Tools | Latency | Cost |
| --- | :---: | :---: | :---: | --- | ---: | ---: | ---: | ---: | ---: |
| Empty | yes | no | no | — | 0 | 72,326 | 19 | 102.933 s | $0.651624 |
| Natural | yes | no | no | SessionStart | 81 | 63,027 | 8 | 37.731 s | $0.402366 |
| Oracle | yes | yes | no | SessionStart | 82 | 68,845 | 15 | 91.262 s | $0.595286 |
| Irrelevant | yes | no | no | SessionStart | 76 | 86,188 | 29 | 171.733 s | $0.991547 |
| Stale | yes | no | no | SessionStart | 91 | 67,331 | 12 | 66.850 s | $0.519192 |

Natural versus empty saved 9,299 total tokens, 11 tool calls, 65.202 seconds,
and $0.249257 in this pair. The paired recurrence effect was exactly zero
because neither arm executed the mistake. The irrelevant arm was the slowest,
most expensive, and most tool-heavy arm.

### Claude producer → Codex consumer

All rows used clean commit `261c836` and one matched pair. Codex did not expose a
single total-token or price value, so uncached/cached accounting is reported
without manufacturing a total or cost.

| Arm | Correct | Attempted | Executed | Delivery | Injected | Uncached | Cached | Tools | Latency |
| --- | :---: | :---: | :---: | --- | ---: | ---: | ---: | ---: | ---: |
| Empty | yes | no | no | — | 0 | 374,157 | 335,616 | 49 | 94.234 s |
| Natural | yes | no | no | SessionStart | 81 | 229,702 | 167,168 | 31 | 74.203 s |
| Oracle | yes | no | no | SessionStart | 82 | 223,012 | 189,440 | 23 | 62.278 s |
| Irrelevant | yes | no | no | SessionStart | 76 | 288,577 | 264,448 | 52 | 112.690 s |
| Stale | yes | no | no | SessionStart | 91 | 183,261 | 166,656 | 18 | 78.059 s |

Natural versus empty used 144,455 fewer uncached tokens, 168,448 fewer cached
tokens, 18 fewer tools, and 20.031 fewer seconds in this pair. Again, recurrence
was already zero in empty, so prevention effectiveness is not identified.

## Same-client fresh sessions

| Producer → consumer | Capture | Exact delivery | Attempted | Executed | Correct | Injected | Consumer usage |
| --- | :---: | :---: | :---: | :---: | :---: | ---: | --- |
| Codex → Codex | yes | yes | no | no | yes | 81 | 265,079 uncached; 37 tools; 91.419 s |
| Claude → Claude | yes | yes | no | no | yes | 81 | 67,245 total; 14 tools; 76.906 s; $0.589651 |

These rows prove a graph-only handoff to a fresh process/session. With no matched
empty arms, they are not causal effectiveness estimates.

## Concurrent writers and later consumer

The accepted corrected cohort used clean commit `712b0d3`.

### Writer integrity

- Three Codex processes ran concurrently against one workspace and graph.
- All three completed correctly after the required producer mistake.
- Natural semantic capture: 3/3 writers.
- Acknowledged unique findings: 3.
- Graph lines: 99; snapshot lines: 24.
- Malformed lines: 0; orphaned findings: 0; contradicted findings: 0.
- Missing accepted writes: 0; graph parseable: yes; zero-loss gate: yes.
- Later natural Claude consumer received 3/3 exact finding IDs at SessionStart
  before its first task action, at a total of 141 injected tokens.

### Consumer outcome

| Arm | Correct | First pass | Attempted | Executed | Total tokens | Tools | Latency | Cost |
| --- | :---: | :---: | :---: | :---: | ---: | ---: | ---: | ---: |
| Empty | yes | no | yes | yes | 80,508 | 34 | 190.656 s | $1.052296 |
| Natural | **no** | no | yes | yes | 78,584 | 23 | 167.666 s | $0.983535 |

Natural saved 1,924 tokens, 11 tools, 22.990 seconds, and $0.068761, but its
correctness delta was -100 percentage points. It failed the required proof/end
state for verification, generated-source, and false-positive-validation. This
row is harmful by the pre-registered priority ordering.

### Retained diagnostic cohort

An earlier Claude×3 → Codex diagnostic exposed a grading defect: a writer with
no acknowledged `wiki_write` was incorrectly credited when another writer's
finding in the shared graph passed its semantic matcher. The raw ledger is
retained with `invalid-attribution` in its filename. Its aggregate
`captureSuccesses: 3` field is invalid; recomputing from per-writer acknowledged
IDs gives 2/3 writers, two accepted writes, zero lost writes, and 2/2 later
delivery. The evaluator now requires both semantic match and that writer's
acknowledged finding ID; a regression test covers the case.

The diagnostic consumers were both correct, but both repeated the generated
source-of-truth mistake. It is not used in the dashboard claim cohort.

## Context-window and integration overhead

The same hidden-grader task was also run without the plugin or any MCP server.
These are single-run diagnostics, not randomized estimates.

### Codex consumer

| Configuration | Correct | Attempted | Executed | Uncached | Cached | Tools | Latency |
| --- | :---: | :---: | :---: | ---: | ---: | ---: | ---: |
| No system | yes | yes | no | 83,464 | 72,192 | 10 | 33.180 s |
| Full integration, empty graph | yes | no | no | 374,157 | 335,616 | 49 | 94.234 s |
| Full integration, natural graph | yes | no | no | 229,702 | 167,168 | 31 | 74.203 s |

Against no-system, the empty integration added 290,693 uncached tokens
(+348.3%), 39 tools, and 61.054 seconds. Natural retrieval reduced the empty
integration's work but remained 146,238 uncached tokens (+175.2%), 21 tools, and
41.023 seconds above no-system. The 81-token graph injection was only 0.035% of
the natural run's uncached accounting.

### Claude consumer

| Configuration | Correct | Attempted | Executed | Total tokens | Tools | Latency | Cost |
| --- | :---: | :---: | :---: | ---: | ---: | ---: | ---: |
| No system | yes | no | no | 64,332 | 14 | 47.095 s | $0.387555 |
| Full integration, empty graph | yes | no | no | 72,326 | 19 | 102.933 s | $0.651624 |
| Full integration, natural graph | yes | no | no | 63,027 | 8 | 37.731 s | $0.402366 |

Against no-system, the empty integration added 7,994 tokens (+12.4%), five
tools, 55.838 seconds, and $0.264069. Natural used 1,305 fewer tokens, six fewer
tools, and 9.364 fewer seconds than no-system, but cost $0.014811 more. The
81-token graph injection was 0.129% of natural total tokens.

These measurements reject the broad theory that graph text itself consumes most
of the context window. They support a narrower concern: the complete plugin/MCP
surface can induce substantial extra model and tool activity, especially in
Codex. Tool-schema prompt cost is not separately observable in these CLI
streams, so it remains part of the full-integration delta rather than a claimed
root cause.

## Pre-registered gates

| Gate | Result |
| --- | --- |
| 10 matched pairs per cross-client direction | **fail** — 1 per direction |
| Natural capture at least 80% | pass in accepted single/concurrent cohorts |
| Executed recurrence reduction at least 50% | **not identified** — empty recurrence was 0% |
| Paired 95% interval excludes zero | **fail** — one pair and zero effect |
| Natural correctness no more than 10 pp below empty | pass in single-task cohorts; **fail** in concurrent cohort (-100 pp) |
| Pre-action delivery at least 80% | pass — 100% of expected accepted findings |
| Irrelevant/stale controls cause no correctness regression | pass at n=1 |
| Irrelevant guidance is not delivered | **fail** — listed at SessionStart |
| Concurrent graph parseable, no orphan/lost accepted writes | pass |
| Concurrent later consumer correct with all findings | **fail** in accepted Codex×3 → Claude cohort |

Overall status: **infrastructure demonstrated; effectiveness not established;
one harmful cohort observed.**

## Live dashboard proof

The eight accepted ledgers plus the corrected concurrency cohort were loaded
into one graph and served by the built dashboard at `http://localhost:3342`.

- Evidence API: 14 handoff rows, two concurrency rows, six transfer cohorts.
- Browser: HTTP 200; six transfer rows rendered; concurrent writer table
  rendered; no console or page errors.
- Dashboard verdict: `insufficient randomized evidence`.
- Concurrent row: 100% capture, integrity, and delivery; 0% natural consumer
  correctness.
- Existing deterministic UI verification also passed 28/28 checks.

The live aggregate and screenshot are local runtime artifacts; the immutable
input ledgers below are committed.

## Redacted ledgers and SHA-256

| Ledger | SHA-256 |
| --- | --- |
| `2026-08-09-pr302-codex-to-claude-controls.jsonl` | `967AB5BF6AD1996BC3BD50AC8D67C675EBD3B95491EC7F7FBF5966544D93E092` |
| `2026-08-09-pr302-claude-to-codex-controls.jsonl` | `95CFE77ED878122BA028BC315A3154812365CE2B8DE8E7E5A9547B83A49B1428` |
| `2026-08-09-pr302-codex-to-codex-natural.jsonl` | `488DC043FF14F4CF314078DB157A9D1225B796FB2EDFE384FA3938522DCFD8D4` |
| `2026-08-09-pr302-claude-to-claude-natural.jsonl` | `EF552E18ECDA79729D6253042D29CDCCE26A3891814D396C302E6CD58BE1FF76` |
| `2026-08-09-pr302-concurrent-codex-to-claude.jsonl` | `477FF6F1A6D2229F6BB82F5FDC4E16316F11335FBCB71284F2DC666AF775C3FD` |
| `2026-08-09-pr302-concurrent-diagnostic-invalid-attribution.jsonl` | `EFDCCED7886E98DF85F933AD173106E2C212486CCE2682B8127C0ECC2DBD9CF2` |
| `2026-08-09-pr302-codex-no-system-baseline.jsonl` | `8DBF68AE4C2D497C097247C71C07AC0DE3E4FE0183FA19C3E312D2B45438816D` |
| `2026-08-09-pr302-claude-no-system-baseline.jsonl` | `14A7CD851249221A1DF695B7AA81068F497C6F62F721B07B3E502AE268767309` |

## Validation

- Repository Jest suite excluding stale `worktrees/`: 169 suites passed;
  2,126 tests passed, five skipped.
- Focused handoff/causal tests after evaluator hardening: 15/15 passed.
- Build and dashboard build passed.
- Dashboard browser verification: 28/28 checks passed.
- Client configuration verification: 227/227 checks passed.
- Client certification: 16/16 checks passed.
- Hook synchronization, package validation, and formatting checks passed.
- Lint: zero errors (492 pre-existing warnings).
- GitHub checks at evidence time: all required checks passed on the pre-report
  head; the report commit triggers the final check set.

An unscoped `npm test -- --runInBand` also discovered a stale checkout under
`worktrees/us-nf-semantic-caching` and ran its obsolete tests. Three failures
there are not from the current checkout; the current repository's corresponding
semantic-caching tests pass. The scoped current-checkout suite above is the
reported result.

## Required next experiments before an effectiveness claim

1. Replace unconditional SessionStart listing with prompt-aware relevance for
   clients that expose a prompt lifecycle, and suppress irrelevant/stale items
   where relevance cannot be established.
2. Diagnose the harmful three-finding Claude consumer with a preserved,
   privacy-reviewed trace and add a regression scenario before expanding the
   sample.
3. Measure MCP tool-schema and skill-loading cost separately from tool-use
   behavior; reduce the default tool surface and avoid unnecessary skill reads.
4. Make the single-task fixtures harder enough that empty arms have non-zero
   recurrence without telling consumers the answer, then run the pre-registered
   10 matched pairs per direction.
5. Repeat concurrency in both directions after the relevance fix and require
   every writer to acknowledge its own target finding.
