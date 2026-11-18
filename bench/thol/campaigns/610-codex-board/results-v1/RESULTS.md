# Codex task-category comparison: failed cost gate

Completed 2026-11-17T21:50:34.677774+00:00. All 170 runs are valid. Candidate and baseline each passed 85/85 tasks.

The pre-registered geometric mean of per-task median credit ratios is **1.020455**, a **2.05% increase**. The <=1.00 cost gate failed; equal task success does not override that failure. No task ratio crossed the fixed [0.67,1.5] transcript-review threshold.

Candidate `6c3bd71d` and baseline `1518a5d7` used Codex CLI 0.169.0, GPT-6.1 Sol, high reasoning, five repetitions per product, paired alternating order, identical fingerprinted task inputs and independent graders. Native hook audits recorded classification on all 85 candidate runs. The settings holdout selected 13/85 sessions (15.3%); it was not filtered out.

| Category | Tasks | Candidate / baseline | Fixed limit | Required disposition |
|---|---:|---:|---:|---|
| fix | 5 | 1.047812 | 1.05 | within threshold |
| build | 5 | 1.012512 | 1.05 | within threshold |
| survey | 5 | 1.055629 | 1.03 | remove override |
| locate | 1 | 0.961033 | 1.05 | within threshold |
| rewrite | 1 | 0.833259 | 1.03 | within threshold |

Survey exceeds 1.03: remove its output-discipline override before merge. Rewrite is retained provisionally: its one task used 16.67% fewer estimated credits, but that does not establish a general rewrite benefit. No unchanged category exceeded 1.05. Fix is close to that limit (1.047812), so its overhead warrants attention in the next candidate comparison.

## Usage and cost scenario

The complete campaign used 379.14152 estimated standard Codex credits: candidate 193.04349, baseline 186.09803. Those arithmetic totals are distinct from the pre-registered per-task median geometric ratio. Agent execution time totaled 4.12 hours.

| Product | Input tokens, including cached | Cached input tokens | Output tokens |
|---|---:|---:|---:|
| Candidate | 17,459,303 | 15,443,456 | 214,570 |
| Baseline | 17,565,672 | 15,632,512 | 201,435 |

Rates were frozen before measurement at 50 / 2.5 / 250 credits per million uncached-input / cached-input / output tokens. Uncached input is total input minus cached input. Output is not double-counted with reasoning. These are rate-card estimates, not actual subscription charges. Slightly fewer total tokens does not establish cheaper use when cached input and output differ.

Five repetitions per product give limited precision. This is a measured failed gate, not a statistical claim that every future use regresses. One local task represents rewrite and one represents locate. No post-hoc replacement, exclusions or pooling with the Claude account-refusal attempts was used.

## Per-task median ratios

| Task | Candidate credits | Baseline credits | Ratio |
|---|---:|---:|---:|
| code-bugfix-py | 1.54059 | 1.56714 | 0.983058 |
| code-comprehension-django | 1.84019 | 1.93083 | 0.953056 |
| code-debug-cascade-py | 2.63267 | 1.96045 | 1.342891 |
| code-debug-ledger-py | 2.09480 | 1.84399 | 1.136015 |
| code-debug-pipeline-py | 1.81938 | 2.12633 | 0.855643 |
| code-feature-js | 1.82437 | 1.79830 | 1.014497 |
| code-feature-validate-py | 1.87463 | 1.92800 | 0.972318 |
| code-iterate-tests | 2.05292 | 2.08570 | 0.984283 |
| code-migration-py | 2.22648 | 1.87509 | 1.187399 |
| code-migration-py-xl | 1.68936 | 1.71180 | 0.986891 |
| code-overview-cobra | 4.15441 | 3.93096 | 1.056844 |
| code-refactor-split-py | 1.51967 | 1.65072 | 0.920610 |
| code-rewrite-modernize-py | 3.45489 | 4.14624 | 0.833259 |
| code-settings-inventory-django | 1.79943 | 1.32822 | 1.354768 |
| log-needle-zh | 1.08591 | 1.12994 | 0.961033 |
| report-pdf | 2.14016 | 2.43207 | 0.879975 |
| seo-audit | 4.12614 | 3.77965 | 1.091673 |

## Evidence and follow-up

`runs.json` contains all 170 numerical measurement rows; `summary.json` is reproduced by the frozen report module; `provenance.json` records image/input/harness identities. `artifact-hashes.json` fingerprints the original per-run records. Raw model transcripts, hook payloads and authentication remain outside the repository.

The original candidate failed. Removing the survey override creates a new product identity and requires fresh measurements; these results cannot be relabelled as validation of that amended candidate. The optional learned classifier and fresh human-label evaluation in #611 remain separate and frozen.

The background process finished, but its status checkpoint remained marked running until the maintainer requested an update. The checkpoint is now corrected. Starting a detached process without an active follow-up did not provide the expected monitoring.
