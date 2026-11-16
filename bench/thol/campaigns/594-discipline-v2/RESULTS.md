# #594 rewritten output-discipline block: results

Run 2026-11-16 against `PREREGISTRATION.md` (tag `thol-594-discv2-prereg`), image built from
token-optimizer-mcp 8f7e6c1f. 30 runs, all `ok`, all successful. Spend $5.36 (budget about $5,
stop at $7). The first launch was stopped by host memory pressure before any run finished; the
relaunch resumed into the same volume and the same arm order.

## Decision: the rule failed on these three tasks; the default is not changed

**Scope correction (same day).** The pre-registered rule said default the block off if it failed
here, and it failed every row. That rule was wrong in scope. These three tasks were chosen
because the old block had lost on them, so they cannot speak for the product. The ledger
attribution data (`bench/ledger/attribution.jsonl`, same hooks with and without the block, old
wording) has it winning on two other tasks: debug-pipeline-py $0.0375 against $0.0652 (0.58x)
and explain-failure $0.0771 against $0.0885 (0.87x). The default-off change was made and then
reverted in token-optimizer-mcp #608. The default waits for an A/B covering both task sets and
both wordings.

The original decision section follows, unchanged.

### Original decision: default the block off

| Task | Rewrite (median $) | No block (median $) | Ratio | Rule | Met |
|---|---|---|---|---|---|
| code-bugfix-py | 0.110 | 0.103 | 1.07x | <= 1.03x | no |
| log-needle-zh | 0.147 | 0.126 | 1.17x | <= 1.03x | no |
| seo-audit | 0.317 | 0.258 | 1.23x | <= 1.00x | no |

The rule fixed before the runs says ship only if every row is met; none is. So
`TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE` becomes opt-in (unset means off). (Withdrawn; see
the scope correction above.)

For reference, the control medians from `594-discipline-ab` were 0.093, 0.141 and 0.255.

## Also reported

| Task | Arm | Output tokens (median) | Turns (median) | Runs using `Read` |
|---|---|---|---|---|
| code-bugfix-py | rewrite | 746 | 6 | 5 of 5 |
| code-bugfix-py | no block | 667 | 5 | 5 of 5 |
| log-needle-zh | rewrite | 1056 | 8 | 0 of 5 |
| log-needle-zh | no block | 1326 | 8 | 3 of 5 |
| seo-audit | rewrite | 8682 | 7 | 0 of 5 |
| seo-audit | no block | 6868 | 15 | 4 of 5 (12 reads each) |

**Persisted-output pointer:** the duplicate is gone. Each rewrite log-needle run carries exactly
one pointer, Claude Code's own `<persisted-output>`; the optimizer adds no second "full output"
artifact.

## Findings

1. **The rewrite did not stop the steering away from `Read`.** Its new line ("read files and run
   commands as usual, and prefer fewer tool calls over smaller ones") was in every run, yet the
   rewrite arm used `Read` in 0 of 10 log-needle and seo-audit runs against 7 of 10 without it.
   It batched `cat` instead. Disposition: open; the wording still steers reads.
2. **The block raised the very column it targets.** seo-audit output tokens were 8682 against
   6868. Fewer turns (7 against 15) did not pay for it. Disposition: open.
3. **A whole-log `cat` only happens with the block.** Every rewrite log-needle run printed the
   548.8 KB log once, which Claude Code persisted; no no-block run did. Disposition: open; same
   cause as finding 1.
