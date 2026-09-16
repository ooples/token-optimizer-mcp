# Responses deduplication development comparison

Registered before live execution. Candidate: current default proxy with stable
request-local deduplication, expanded output support, bounded cached token
estimates, and small exact JSON tables. Tool-description experiment remains off.
Competitor: installed HeadRoom 0.37.0, actual proxy, same local Codex/model.

Fixed schedule: eight pairs / sixteen attempts; two repetitions per group,
arms proxy,headroom with the second repetition reversing order:

| Group | Suite / task | Seeds | Repeat reads |
| --- | --- | --- | --- |
| JSON | heldout-v1 / json | 3141592001, 3141592002 | 1 |
| Nullable | adversarial-v1 / nullable | 2494523015, 2494523016 | 1 |
| Refresh | heldout-v1 / refresh | 1618034001, 1618034002 | natural workflow |
| Repeated JSON | heldout-v1 / json | 3141592101, 3141592102 | 3 |

Repeated JSON explicitly instructs three sequential reads of an unchanged file.
This is a mechanism diagnostic, not a natural-workload prevalence claim. Audit
actual tool output repetition and transmitted references before attributing a
benefit to deduplication. Noncompliance remains a reported outcome, never a
replacement run. Existing answer/file oracles remain unchanged.

Retain every attempt, failure, and unknown charge. Run the existing independent
quality/usage/capture auditors and recorded $10/$1/$50 cost scenario. Report
per-pair and aggregate cost, agent time, requests, and cached/input tokens.
Original losses and the frozen study remain intact. Neither local byte wins nor
this small development batch establish every-task superiority.

Use existing symmetric Windows memory guards and telemetry. Stop on a guard
failure and retain completed outcomes. No tuning during this schedule.

Adversarial implementation checks: append-only output stability, no references
to removed or changed content, bounded request-local indexes, distinct call/status
metadata on repeated errors, exact source-read anchors, local-shell JSON validity,
multimodal metadata, rejection of token-expanding encodings, and lexical table
reconstruction including escaped strings and integers beyond JS precision.
o200k_base counts are estimates with a margin, not provider billing guarantees.
