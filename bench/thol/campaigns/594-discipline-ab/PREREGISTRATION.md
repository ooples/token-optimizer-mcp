# #594 output-discipline A/B: pre-registration

Written and committed before any run. The #594 paid check failed (`../594-check/RESULTS.md`).
Its free audit pointed to one shared factor: our arm avoids `Read` and prints files with Bash
`cat` loops, while no hook acts on those calls. The suspected cause is the SessionStart
output-discipline block. This A/B switches only that block.

## What runs

- **Product under test:** `thol-rig:candidate`, rebuilt from token-optimizer-mcp
  `fix/hooked-claude-code-instructions` at b727e502 (clean tree; provenance in
  `provenance.json` here).
- **Arms:**
  - `control`.
  - `token-optimizer-mcp`.
  - `token-optimizer-nodisc`: the same manifest with
    `TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE=off`. No other difference.
- **Tasks:** the three losses: `seo-audit` (1.60x), `log-needle-zh` (1.17x) and
  `code-bugfix-py` (1.12x).
- **Repetitions:** 5. The arm order rotates per repetition (`arm-order.json`).
- **Budget:** about $8 from the 594-check medians. A stop is called if the spend passes $9.

## Questions and decision rule (fixed now)

Measure: the median `total_cost_usd` per task and arm over the five reps. Also the number of
`Read` calls against Bash file-printing calls per run.

1. **Is the block the cause?** Yes if `nodisc` has a lower median than `token-optimizer-mcp`
   on at least 2 of 3 tasks, and on `seo-audit` has at least as many `Read` calls as
   `token-optimizer-mcp` in at least 4 of 5 runs.
   - If yes, the block is removed or rewritten before the full board.
   - If no, the block stays, and the loss is attributed elsewhere from the transcripts.
2. **Does either arm beat control?** Reported per task. This does not gate the decision
   above. The full board stays blocked until a later pre-registered check passes the
   594-check bar.
3. **Success:** each arm's success count is reported, and any failure is audited.

## What the transcripts are searched for (all arms, every run)

- **Fixable product issues:** a hook firing where it should not, a hook absent where it
  should act, and context or notices that cost more than they save.
- **Missed savings:** large tool results that we pass through untouched, repeated reads of
  the same file, and output tokens spent restating tool results.
- **Optimizations seen in control:** cheaper tool strategies the model picks without us,
  which our guidance or hooks could encourage or should stop discouraging.

Each finding is recorded with its run id and token cost. Each one is either fixed in #594
or written down as an open item; none is left only in prose.

Three tasks and five reps are a diagnosis, not a benchmark. A win here does not stand in
for the full board.
