# #594 paid check: pre-registration

Written and committed before any run. This is the third of the four de-risk steps
agreed for #565. It checks whether the #594 fixes turn the development-set losses
into wins before the full board is run.

## What runs

- **Product under test:** `thol-rig:candidate`, built from token-optimizer-mcp
  `fix/hooked-claude-code-instructions` at 052f5a53 (clean tree; the provenance
  is in `bench/thol/pkg/provenance.json`).
- **Arms:** `control`, `token-optimizer-mcp`, `tokenjuice`. tokenjuice beat us
  most often on these tasks in the #565 run.
- **Tasks:** the seven development-set tasks we lost to control: `code-bugfix-py`,
  `code-feature-validate-py`, `code-iterate-tests`, `code-refactor-split-py`,
  `seo-audit`, `code-settings-inventory-django` and `log-needle-zh`.
- **Repetitions:** 3. The arm order rotates per repetition (`arm-order.json`).
- **Budget:** ~$12, estimated from the #565 median cost per run. A stop is
  called if the spend passes $18.

## Pass bar (fixed now, not after seeing results)

Measure: the median `total_cost_usd` per task and arm over the three reps.

1. On at least 5 of the 7 tasks, our median is at or below control's.
2. On `code-settings-inventory-django` and `log-needle-zh` (#565: 1.88x and
   1.31x), our median is at most 1.10x control's.
3. Our success count over all 21 runs is at least control's.

**Reported but not gating:** our median against tokenjuice's on each task, and
output tokens and turns against control's.

**If the bar fails:** the full board is not run. The failing tasks get the same
audit-and-replay loop first, and the result is reported as it stands.

These tasks were the ones that drove the fixes, so passing here is evidence
that the fixes work. It is not evidence of generalisation. That is what the
full board and the held-out set are for.
