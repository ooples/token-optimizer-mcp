# Full results and adversarial review

**Paid execution is on hold.** No additional benchmark model calls were made. The audit scripts did not run another campaign. The failed candidate result remains unchanged.

## Completed Codex comparison

Candidate `6c3bd71d` vs master `1518a5d7`, Codex CLI 0.169.0, GPT-6.1 Sol high reasoning. Seventeen tasks, five repetitions per product. Both products passed 85/85 task runs: 80 scores of 1.0 and five PDF scores of 0.9 each. The primary geometric mean of task-median credit ratios is 1.020455 (+2.05%): the pre-registered cost gate failed.

All task results are below. Costs are estimated standard Codex credits, not subscription invoices. Lower candidate cost is better. Every cell has five repetitions; both products passed 5/5 on every task.

| Task | Candidate median credits | Master median credits | Change | Candidate score range | Master score range |
|---|---:|---:|---:|---:|---:|
| code-bugfix-py | 1.54059 | 1.56714 | -1.69% | 1-1 | 1-1 |
| code-comprehension-django | 1.84019 | 1.93083 | -4.69% | 1-1 | 1-1 |
| code-debug-cascade-py | 2.63267 | 1.96045 | +34.29% | 1-1 | 1-1 |
| code-debug-ledger-py | 2.09480 | 1.84399 | +13.60% | 1-1 | 1-1 |
| code-debug-pipeline-py | 1.81938 | 2.12633 | -14.44% | 1-1 | 1-1 |
| code-feature-js | 1.82437 | 1.79830 | +1.45% | 1-1 | 1-1 |
| code-feature-validate-py | 1.87463 | 1.92800 | -2.77% | 1-1 | 1-1 |
| code-iterate-tests | 2.05292 | 2.08570 | -1.57% | 1-1 | 1-1 |
| code-migration-py | 2.22648 | 1.87509 | +18.74% | 1-1 | 1-1 |
| code-migration-py-xl | 1.68936 | 1.71180 | -1.31% | 1-1 | 1-1 |
| code-overview-cobra | 4.15441 | 3.93096 | +5.68% | 1-1 | 1-1 |
| code-refactor-split-py | 1.51967 | 1.65072 | -7.94% | 1-1 | 1-1 |
| code-rewrite-modernize-py | 3.45489 | 4.14624 | -16.67% | 1-1 | 1-1 |
| code-settings-inventory-django | 1.79943 | 1.32822 | +35.48% | 1-1 | 1-1 |
| log-needle-zh | 1.08591 | 1.12994 | -3.90% | 1-1 | 1-1 |
| report-pdf | 2.14016 | 2.43207 | -12.00% | 0.9-0.9 | 0.9-0.9 |
| seo-audit | 4.12614 | 3.77965 | +9.17% | 1-1 | 1-1 |

`all-170-runs.csv` contains every repetition, score, success flag, input/cached/uncached/output/reasoning tokens, credit estimate, recorded duration and failed MCP calls. `all-17-tasks.csv` includes all five individual credit observations for both products. Original numerical JSON is in ../results-v1/.

Scored estimates total 379.14152 credits; retained setup probes add 3.31051. The native availability smoke is not included in that retained setup total. No account invoice is claimed. Total input includes cached input; it must not be charged twice. Recorded agentSeconds includes grading after the CLI, so it is not pure model latency.

## Findings, ordered by consequence

### 1. No current competitor ranking exists (blocks competitive claims)

The 170-run study has two arms, both ours. It has zero competitor observations and zero no-optimizer controls. It cannot answer whether we beat Tokenjuice, Tokenade, Headroom or any of the 47 external products. Use the complete COMPETITORS.md matrix; do not call the verified subset the full field.

### 2. Version and integration admission is incomplete (blocks paid expansion)

The old pins were checked November 11. Current release checks found multiple stale packages, repository moves, a source placeholder and a release-versus-registry discrepancy. The installed Edgee binary fails with missing GLIBC_2.38 and GLIBC_2.39 on the image. Old manifests invoke Claude-specific installers/wrappers even for products now documenting Codex. Each latest official client integration needs a free activation and fidelity probe first. Do not count installation or tool presence as measured use.

### 3. The frozen report accepts missing hook evidence and impossible scores (blocks relying on it alone)

In memory, removing every hooks, selectedSettings and taskEvents record still produced complete=true. A score of 99 was also accepted. The runner normally supplies these records, so this is not evidence the measured rows were forged. It is a missing independent report guard. The separate audit now checks actual hook counts, live model, categories/settings, original artifact hashes, published rows and Codex usage. All 170 actual records passed those checks. Add strict reusable guards and negative controls before another paid campaign.

### 4. Real failed MCP calls consume work even when tasks pass (fixable product issue)

Baseline: 13 wiki_write failures and one smart_edit failure. Candidate: 10 wiki_write failures. There were 580 completed MCP calls and 24 failed ones. The 340 error-typed Codex items were duplicate informational hook-trust warnings, not 340 product failures; there were no unexpected error items.

Offline reproduction shows why qualified Python method anchors fail: extractSymbols returns Money and from_float, while #Money.from_float does not resolve. A #from_float anchor and a file-only anchor each store successfully. reproduce-anchor.mjs proves this with no model work. Some other failures used an unrooted project or empty anchors; do not attribute every failed write to this one mechanism. Improve exact symbol support or actionable diagnostics/advice, and verify each remaining class offline before paying to measure it again.

### 5. Reproducibility and grading isolation need stronger boundaries

The candidate SEO audit repetition 4 used two live web-tool actions. That adds an external-data path even though the dedicated live-web task was excluded. Retain that run; do not remove it post hoc. The next protocol must explicitly permit and freeze web inputs, or disable web consistently.

The model runs with bypassed sandbox permissions in the same container as mounted truth, graders and credentials. Read-only mounts prevent writes, not reads. Audit found no recorded commands or tool arguments referencing the protected paths, but that scan is not a security boundary or proof of non-access. Keep grading/truth outside the agent-accessible runtime. No final code-workspace snapshots were retained, so the code tasks cannot now be regraded against their final files without reconstructing them; archive final workspace state before container removal next time.

### 6. The small cost difference is uncertain; settings causality is unmeasured

Exploratory paired within-task bootstrap, 10000 draws, seed 20261118, gave a 95% ratio interval [0.9429,1.1260]. This does not replace the fixed failed gate or establish a population effect. The board has only one rewrite and one locate task, no explain task, and no conversational follow-up accuracy sample.

Thirteen candidate sessions were held out: fix 2, build 5, survey 5, locate 1, rewrite 0. That is 15.3% overall and 20% of survey runs. It dilutes category effects and adds small-sample variability. Preserve them; do not filter for a more favorable result.

The arms differ by the whole product change, not solely the survey flag. The fixed rule required removing the survey override; it does not prove the flag alone caused a 5.56% increase. A claim about the best setting needs a controlled same-code ablation after the free checks. The learned classifier in #611 was disabled, so this study says nothing about its savings or independent task accuracy.

### 7. Cost and monitoring controls were incomplete

The driver cap counts completed scored estimates; retained setup usage was outside that total. Timeout or missing usage can leave exposure unknown. A cap checked between runs can overshoot on one expensive run. Include setup/failed-attempt usage, per-run limits and explicit handling of unknown exposure in the next plan.

The detached process completed without updating the checkpoint or the maintainer. A future supervisor must record milestones and terminal success/failure, enforce stop conditions and produce a final report automatically. A detached launch is not monitoring, and a status file is not a delivered chat notification.

## Historical competitor evidence (separate model and product builds)

historical-all-runs.csv and .json export all 458 retained records from three older campaigns: 294 development records (288 ok, 6 errors), 101 held-out records (96 ok, 5 errors), and 63 check records (all ok). They use Claude Sonnet 4.6, not this GPT-6.1 Sol campaign. Retried errors are retained. Their controls, current-for-that-study versions and older product trees are not a current Codex leaderboard.

| Historical campaign | Product observations | Correct reading |
|---|---|---|
| #565 development | ours, Tokenjuice, Tokenade, Headroom in two modes, CTO, patched CTO, control; 288 ok | Our mean task-cost ratio to control was 1.149; not a current competitive result. |
| #565 held-out | same eight arms; 96 ok | Our mean ratio was 0.843, 95% interval [0.643,1.029]; primary interval includes parity. |
| #594 check | ours, Tokenjuice, control; 63 ok | Our product failed its fixed acceptance bar; all three arms passed 21/21 tasks. |

Full historical per-task tables remain in ../../565-five-product/RESULTS-BEFORE-FIXES.md, ../../565-heldout/RESULTS.md and ../../594-check/RESULTS.md. Do not pool these means or their dollar rates with the Codex medians and credit scenario.

## Disposition

Do not start another paid run from this review. Preserve the failed experiment, repair the report/admission/retention controls and reproduce product failures offline. Account for every competitor with an immutable latest-version lock and either a qualified official integration or an explicit evidence-backed blocker. Present the resulting design, exposure cap and any scope limits for review before spending again. See NEXT_CAMPAIGN.md.
