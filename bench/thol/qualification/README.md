# Free qualification and evidence repair

**Paid benchmarking is on hold. This directory does not authorize a new paid
campaign.** No provider credentials or host HOME are mounted into qualification
containers. Activation runs use Docker `--network none`; package/source
preparation is separate, with npm/Bun lifecycle scripts disabled and uv source
builds disabled. Rust dependency fetches happen before network-denied builds.

The [full 47-product status](results-v1/STATUS.md), [JSON](results-v1/qualification-matrix.json)
and [CSV](results-v1/qualification-matrix.csv) distinguish source verification,
installation, mock-provider client wiring, native hooks and MCP known answers.
They do not rank savings. Research, standalone transformations, IDE extensions,
Claude and OpenCode integrations remain visible in separately reviewed cohorts.
An upstream badge is not an exclusion rule.

The [completed paid results](../campaigns/610-codex-board/results-v1/RESULTS.md)
remain unchanged: both versions passed 85/85 tasks; the candidate's task-median
geometric cost ratio was **1.020455**, failing its <=1.00 gate. That campaign has
no competitor arm and no true no-optimizer control. All [170 rows](../campaigns/610-codex-board/review/all-170-runs.csv)
and [458 historical records](../campaigns/610-codex-board/review/historical-all-runs.csv)
are available separately. Historical Claude results cannot be pooled with Codex.

## Verified controls and their limits

- `guarded_report.py` requires independent evidence admission before invoking
  the unchanged historical analysis. It checks identities, hashes, raw usage,
  hook execution, live model receipts, classifications, selected settings and
  score bounds. Unreadable input replaces a stale verdict with a rejection.
  The explicit historical publication normalization drops `startedAt` and adds
  null `selectedSettings` only when absent; it does not allow arbitrary omissions.
- `lifecycle.py` journals dispatch before execution and counts setup, failed and
  successful attempts. Unknown usage, infrastructure errors, interruption,
  reservation overrun and insufficient remaining budget stop further dispatch.
  **This is a library, not the replacement paid runner.** Provider-side hard
  limits, process/container supervision, watchdog behavior and actual update
  delivery still need integration and rehearsal. A local status file is not a
  delivered chat notification; a reservation is not a provider-enforced cap.
- `workspace_evidence.py` retains final workspace bytes with per-file and archive
  hashes. `isolation_dry_run.py` used a clean Python image: its agent could not see
  truth/grader files, and two separate grading runs agreed on the retained output.
  This is an architecture rehearsal on a tiny fixture. **The actual 17 tasks and
  production agent image still need the same separation and free regrading.**
- `mock_codex.py` runs the actual pinned Codex CLI against a loopback Responses
  fixture. It requires an executed known-answer tool, completed turn, unchanged
  requested model/effort and multiple local protocol exchanges. Fake usage is
  explicitly synthetic and never included in cost results. Hook instrumentation
  preserves the vendor command and records original/instrumented manifest hashes.
- MCP probes reject an unknown tool and then require a known answer on the same
  connection. This establishes limited local recovery, not full task quality.
- `headroom_probe.py` tests the documented wrapper against a fake CLI and a local
  upstream. Its noisy-output fixture must retain the full failure line in the
  matching tool result, not merely elsewhere in the user prompt. Persistent
  proxy/config state after wrapping is recorded; the disposable container owns
  teardown. No head-to-head model result is inferred from byte reduction.

The new checks have adversarial negative controls for missing evidence, score 99,
wrong models, duplicated rows, stale reports, omitted fields, unknown cost,
interrupted attempts, false tool completion, dropped errors and changed routing.
See [the follow-up review](REVIEW.md) for remaining admission gaps.

## Reproduce without a model service

Run from the repository root:

```powershell
python -m unittest discover -s bench/thol/qualification -p 'test_*.py' -v
python bench/thol/qualification/guarded_report.py --rows bench/thol/campaigns/610-codex-board/results-v1/runs.json --contract bench/thol/qualification/610-evidence-contract.json --hashes bench/thol/campaigns/610-codex-board/results-v1/artifact-hashes.json --evidence <private-original-evidence> --output <new-report.json>
python bench/thol/qualification/source_inventory.py --matrix bench/thol/qualification/current-matrix.json --output <private-cache>
python bench/thol/qualification/prepare_context.py --cache <private-cache> --output <new-build-context>
docker build -t <qualification-image> <new-build-context>
```

Activation mounts this directory read-only at `/qualification`, checksum-verified
native artifacts read-only at `/native`, and a fresh output directory at
`/evidence`. Always pass `--network none`. `QUALIFICATION_PRODUCTS` selects names;
`QUALIFICATION_NATIVE_CLIENT=1` enables the real-client/mock-provider check.
Optional `/native-built` supplies explicitly labelled source-built variants.
Keep each attempt directory; use a new name after changing a probe.

Archives, binaries, build caches, private prompts and models stay outside git.
Published evidence contains generated fixture data and public vendor metadata.
The historical runner/report remain frozen for reproduction and must not be used
to bypass the current spending hold.
