# Output-discipline block by task category: pre-registration

Written and committed before any run. Follows `../594-discipline-v2/RESULTS.md`. That campaign
measured three tasks chosen because the old block lost on them, and it cannot set a product
default. The ledger attribution data has the block winning on two other tasks. The question
here is not "on or off" but **which kinds of task the block helps**. The answer feeds a
per-category settings table: a classifier at prompt submit, corrected by the first tool calls
(design chosen 2026-11-16).

## What runs

- **Product:** `thol-rig:candidate`, the same image as `594-discipline-v2` (token-optimizer-mcp
  8f7e6c1f, clean; `/opt/optimizer-provenance.json` checked before launch).
- **Arms:** `token-optimizer-mcp` (the rewritten block) and `token-optimizer-nodisc` (no
  block, nothing else changed).
- **Repetitions:** 5, arm order alternating per rep (`arm-order.json`).
- **Categories, labelled by hand from each task's prompt before any run:**

| Category | Tasks | New runs? |
|---|---|---|
| **fix**: a red suite, find and repair the cause | code-bugfix-py, code-iterate-tests, code-debug-pipeline-py | bugfix reused from v2 |
| **build**: write or restructure code to a spec | code-feature-js, code-migration-py, code-refactor-split-py | all new |
| **survey**: read a corpus, write a prose document | seo-audit, code-overview-cobra, code-settings-inventory-django | seo-audit reused from v2 |
| *locate* (one task, reported, not decided) | log-needle-zh | reused from v2 |

- **Reuse.** v2 ran the same image, arms, rep count and order on code-bugfix-py, seo-audit and
  log-needle-zh. Those 30 runs are reused, not repeated. 70 new runs: 7 tasks x 2 arms x 5.
- **Budget:** about $14 (from earlier control medians), stop if spend passes $25.
- Excluded, with reasons: code-migration-py-xl (a larger copy of code-migration-py),
  code-comprehension-django (a fourth survey task, the most expensive), web-research (live
  web, not reproducible), report-pdf and the debug-ledger and debug-cascade tasks (to keep
  three per category).

## Decision rule (fixed now)

Per task: ratio = median `total_cost_usd` (rewrite) / median (no block).
Per category: the geometric mean of its three task ratios.

- **Block on for the category** if the geometric mean is **< 1.00** and no task in the
  category is above 1.10.
- **Block off for the category** if the geometric mean is **> 1.03**.
- **Otherwise inconclusive:** the category gets the "unknown" row's default, which stays on
  until a category result says otherwise.

If all three categories land on the same side, there is no per-category effect for this
setting and it gets one global default (on or off by the same rule over all nine tasks).

**Also reported per category:** output tokens, turns, `Read` use per run, task success.

## Known limits, stated now

- Three tasks per category is the minimum that stops one task from deciding a category. It
  does not prove the category boundary is the right one.
- Only the rewritten wording is measured. The ledger wins were with the old wording; if the
  rewrite loses where the old one won, that is a wording finding, reported as such.
- Categories are labelled by hand here. The classifier that will assign them in the product
  is not built yet; its accuracy is a separate measurement.

## What the transcripts are searched for

Fixable product issues, missed savings and cheaper strategies, as in the earlier campaigns.
Each finding is recorded with a disposition.
