# Output-discipline block by task category: results

Run 2026-11-16 against `PREREGISTRATION.md` (tag `thol-594-bycat-prereg`), image token-optimizer-mcp
8f7e6c1f. 70 new runs, all `ok`, all successful, $13.90 (estimate about $14, stop at $25). Three
tasks reuse `594-discipline-v2` as pre-registered (same image, arms, reps and order).

## Per task (median `total_cost_usd`, 5 reps each arm)

| Category | Task | Block | No block | Ratio | Output tokens (block / none) | Turns (block / none) |
|---|---|---|---|---|---|---|
| fix | code-bugfix-py (v2) | 0.110 | 0.103 | 1.068 | 746 / 667 | 6 / 5 |
| fix | code-iterate-tests | 0.122 | 0.148 | 0.824 | 1186 / 1665 | 9 / 12 |
| fix | code-debug-pipeline-py | 0.334 | 0.408 | 0.819 | 4671 / 6253 | 22 / 28 |
| build | code-feature-js | 0.129 | 0.142 | 0.908 | 1299 / 2112 | 8 / 8 |
| build | code-migration-py | 0.123 | 0.153 | 0.804 | 995 / 2538 | 6 / 17 |
| build | code-refactor-split-py | 0.111 | 0.120 | 0.925 | 1201 / 1399 | 10 / 11 |
| survey | seo-audit (v2) | 0.317 | 0.258 | 1.229 | 8682 / 6868 | 7 / 15 |
| survey | code-overview-cobra | 0.184 | 0.209 | 0.880 | 2520 / 2804 | 8 / 12 |
| survey | code-settings-inventory-django | 0.270 | 0.229 | 1.179 | 5150 / 4422 | 10 / 7 |
| locate | log-needle-zh (v2, reported only) | 0.147 | 0.126 | 1.167 | 1056 / 1326 | 8 / 8 |

## Decision, by the rule fixed before the runs

| Category | Geometric mean | Any task > 1.10? | Decision |
|---|---|---|---|
| fix | **0.897** | no (max 1.068) | **block on** |
| build | **0.877** | no | **block on** |
| survey | **1.084** | yes | **block off** (> 1.03) |

The categories do not all land on the same side, so the block is a per-category setting, not a
global one. Shipped in token-optimizer-mcp #610: `survey.outputDiscipline = false`; fix and build
keep the default (on), now with this measurement behind it.

## Findings

1. **The block pays where the model writes code and loses where it writes a document.** On fix
   and build it cut output tokens on every task but bugfix (up to 61% on migration) and usually
   turns too. On the two survey losses it *raised* output tokens (seo-audit +26%,
   settings-inventory +16%): the report has to be written in full either way, and under the block
   the model packed it into fewer, longer turns (seo-audit 7 vs 15) whose output is billed at the
   output rate. Disposition: fixed by the per-category setting.
2. **The `594-discipline-v2` default-off conclusion would have cost money.** Its three tasks
   were two survey-like or locate tasks and the one fix task where the block loses. Across the
   six fix and build tasks the block saves 10-12%. Disposition: recorded; v2's scope correction
   stands.
3. **locate rests on one task** (log-needle-zh, 1.17x). Not decided, per the pre-registration.
   It keeps the default until it has three tasks. Disposition: open.
4. **Variance on survey is high** (code-settings-inventory one block run at 0.494, cobra one
   no-block run at 0.420). The medians are robust to those single outliers, but the survey
   decision is the closest of the three. The earlier `594-discipline-ab` run (older image, also 5
   reps) had seo-audit going the other way (block 0.233 vs 0.243), so survey is the cell most
   worth re-measuring when the board runs. Disposition: reported; re-measure on the board.
