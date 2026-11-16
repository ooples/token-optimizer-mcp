# #594 rewritten output-discipline block: pre-registration

Written and committed before any run. Follows `../594-discipline-ab/RESULTS.md`, which found that
the old block steered the model away from `Read` and into extra, narrower calls. The block now
says it governs what the model writes, not how it reads (token-optimizer-mcp 8f7e6c1f). The same
commit stops compacting Bash stdout that Claude Code has already persisted.

## What runs

- **Product:** `thol-rig:candidate`, rebuilt from token-optimizer-mcp
  `fix/hooked-claude-code-instructions` at 8f7e6c1f (clean tree; provenance here).
- **Arms:**
  - `token-optimizer-mcp`: the rewritten block.
  - `token-optimizer-nodisc`: no block. No other difference.
- **No control arm**, to keep the spend at about $5. The control medians from
  `594-discipline-ab` (same model, same Claude Code version, five days' gap at most) are the
  reference and are reported as such.
- **Tasks:** `seo-audit`, `log-needle-zh`, `code-bugfix-py`.
- **Repetitions:** 5, alternating arm order.
- **Budget:** about $5. A stop is called if the spend passes $7.

## Decision rule (fixed now)

Measure: the median `total_cost_usd` per task and arm.

**Ship the rewrite** if both hold:
1. On bugfix and log-needle, its median is at most 1.03x nodisc's. (The old block was
   1.09x and 1.05x.)
2. On seo-audit, its median is at most nodisc's.

**Otherwise** default the block off (`TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE` unset means off), with
the switch kept for opt-in.

**Also reported:**
- `Read` use per run.
- Turns, and output tokens.
- Whether the persisted-output pointer duplicate is gone on log-needle.

## What the transcripts are searched for

Fixable product issues, missed savings and cheaper strategies, as in `594-discipline-ab`. Each
finding is recorded with a disposition.
