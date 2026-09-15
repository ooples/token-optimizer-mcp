# Next fixed-build verification protocol

Recorded before examining results from this campaign.

- Model: gpt-6-astra; local Codex and installed HeadRoom binaries.
- Tasks: JSON outlier lookup, code search, log diagnosis, retry-policy bugfix,
  multi-file money refactor, external route refresh.
- Arms: control, our compression proxy, installed HeadRoom proxy.
- Three repetitions per task and arm, each arm in each position once: 54 runs.
- Workflow seeds 15-17 (`SEED_OFFSET=14`). Refresh route positions vary. The
  JSON/code/log fixtures and the post-seed-4 bugfix/refactor variants are fixed
  regressions; their content does not change with this seed offset. This is
  new-run verification, not six unseen task designs.
- Natural tool selection for workflows; the existing controlled initial-read
  contract remains for JSON/code/log tasks. No new product tuning during the run.
- Use the same compiled build throughout. Save manifest and startup provenance.
- Retain all attempts; report failures and missing usage explicitly. Do not
  retry into the same sample or pool this campaign with development screens.
- Primary checks: task correctness from independent artifact/read audits;
  provider input/cached/output totals reconciled to client usage.
- Report each task separately: total input, uncached input, output, requests,
  agent time, and the explicitly labeled standard-rate token-cost scenario.
- A task is a measured mean win only if all its attempts pass and the candidate
  mean is lower than the comparator on the named metric. A token win is not
  automatically a cost win. Failures invalidate headline campaign comparisons.
- Three repetitions are a verification screen, not statistical proof of
  universal superiority. Shared provider caches remain a limitation. No account
  invoice, subscription savings, or proxy hosting costs are measured.

If a regression appears, retain the whole campaign, diagnose the loss, and
record any subsequent changed-build run as a new development campaign.
