# #594 paid check: results

**Verdict: FAIL** against the bar pre-registered in `PREREGISTRATION.md`
(tag `thol-594-check-prereg`). Per that file, the full board is not run.

- **Product:** `thol-rig:candidate`, token-optimizer-mcp 052f5a53.
- **Model:** claude-sonnet-4-6 on Claude Code 2.1.325.
- **Runs:** 63, all `ok`. Spend: $12.15.

## Median cost per task (3 reps)

| Task | Control | Ours | tokenjuice | Ours / control | #565 ours / control | Ours / tokenjuice |
|---|---|---|---|---|---|---|
| code-bugfix-py | $0.094 | $0.105 | $0.094 | 1.12 | 1.13 | 1.12 |
| code-feature-validate-py | $0.199 | $0.194 | $0.207 | **0.97** | 1.14 | 0.94 |
| code-iterate-tests | $0.130 | $0.123 | $0.147 | **0.94** | 1.13 | 0.84 |
| code-refactor-split-py | $0.110 | $0.103 | $0.115 | **0.93** | 1.04 | 0.89 |
| seo-audit | $0.258 | $0.414 | $0.264 | 1.60 | 1.18 | 1.57 |
| code-settings-inventory-django | $0.391 | $0.279 | $0.229 | **0.71** | 2.45 | 1.22 |
| log-needle-zh | $0.118 | $0.138 | $0.128 | 1.17 | 1.86 | 1.08 |

The "#565" column is the same median ratio computed from the #565 development
run. It is not the cold-start measure quoted in the #565 notes.

## The bar

1. **Ours ≤ control on at least 5 of 7 tasks: FAIL (4 of 7).** The four are
   feature-validate, iterate-tests, refactor-split and settings-inventory.
2. **settings-inventory at most 1.10x control: PASS (0.71x).** log-needle at
   most 1.10x: **FAIL (1.17x).**
3. **Success at least control's: PASS (21 of 21 for every arm).**

## What the transcripts show (free audit, before any further spend)

- **seo-audit (the largest loss): the model's strategy differed.**
  - Control and tokenjuice read the 12 HTML files with parallel `Read` calls
    in one turn, in 5 of their 6 runs.
  - Our arm used Bash `for f in ...; cat` loops and follow-up greps in all 3
    runs (0, 0 and 5 `Read` calls), and in one run re-read files it had
    already printed.
  - No hook acted on those calls: no compaction marker, no outline, no
    PreToolUse context.
  - The cost shows as cache writes of 26-30k tokens against 18-20k, and output
    tokens at 1.5x.
- **log-needle and bugfix:** our arm made no `Read` call on log-needle (control
  made one in 2 of 3 runs), and one extra Bash call in every bugfix run.
- **Common factor, not yet proven:** our arm steers away from `Read`. The
  candidate cause is the SessionStart output-discipline block ("Every token you
  write is billed at output rates ... Write the least code that works"), which
  can favour one compact shell loop over many Read calls. Three reps cannot
  separate this from model variance. A targeted A/B with the block on and off
  is the test.
