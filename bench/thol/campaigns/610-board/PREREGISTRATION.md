# #610 on the board: task classification vs master

Written and committed before any run.

`594-discipline-bycat` decided the per-category settings using 3 tasks per category. It was
not a board result, and presenting it as one was the mistake this campaign corrects. Here,
the whole product is measured on every reproducible task: #610 as shipped (classifier,
per-category settings, holdout telemetry) against master as of this campaign.

## What runs

- **Images**, built from this branch's rig with each product packed by `bench:pack`:
  - `thol-rig:pr610`: token-optimizer-mcp 766d1d7e (tree 88c67e22), `feat/task-class-settings`.
  - `thol-rig:master`: token-optimizer-mcp 1518a5d7 (tree 8b68d518), master.
  - `/opt/optimizer-provenance.json` is checked in each image before launch.
- **Arm:** `token-optimizer-mcp` in both images. Nothing else differs between the images.
- **Results volumes:** `thol-610-board-pr610` and `thol-610-board-master`, one per image. The runner keys resume on (competitor, task, rep) under the client version, which is the same in both images (2.1.325), so a shared volume would skip the second image's runs.
- **Repetitions:** 5. Images alternate per rep: odd reps run pr610 first, even reps run master
  first (`run.sh`). The same rep of both images runs back to back, so drift over the day hits
  both arms equally.
- **Tasks:** 17.
  - The 16 upstream THOL tasks other than `web-research-oss-inventory`. That task uses the
    live web (not reproducible), costs about $5/run, and would breach the stop; the user
    decided on 2026-11-16 to leave it out.
  - The rig-local `code-rewrite-modernize-py` (`../../local-tasks/README.md`), which is not
    on the public board.
- **Budget:** about $36-46 from recorded medians ($3.30 per battery of the 16 tasks, plus an
  estimated $0.3-0.6 per rewrite run). **Stop if recorded spend passes $70**, checked after
  each image-rep.

## Classification of the board, as the shipped classifier assigns it

fix: bugfix, debug-cascade, debug-ledger, debug-pipeline, iterate-tests.
build: feature-js, feature-validate, migration, migration-xl, refactor-split.
survey: comprehension-django, overview-cobra, settings-inventory, report-pdf, seo-audit.
locate: log-needle-zh. rewrite: code-rewrite-modernize-py.

Under #610 only survey (output discipline off) and rewrite (outline substitution off) run
settings that differ from master's. Every other task tests that #610 costs nothing where it
changes nothing: the classifier, the per-prompt block delivery and the telemetry writes.

## Decision rule (fixed now)

Per task: ratio = median `total_cost_usd` (pr610) / median (master).

- **#610 ships its per-category settings** if the geometric mean over the 17 tasks is **≤
  1.00**, and the success rate summed over all tasks is not lower for pr610.
- **Per category**, reported with the same ratio:
  - **survey or rewrite** (settings changed): if the category's geometric mean is **> 1.03**,
    that category's override is removed before merge.
  - **fix, build, locate** (settings unchanged): a geometric mean **> 1.05** is treated as an
    overhead regression, investigated and fixed before merge.
- A task whose ratio lies outside **[0.67, 1.5]** has its transcripts read before any verdict.
  An outlier of that size is a finding, not noise to average away.

## Known limits, stated now

- Five reps per arm. Earlier campaigns measured per-task run-to-run spread of about ±15%, so
  one task's ratio decides nothing. The geometric mean over 17 tasks is the result.
- One local task speaks for rewrite. Its ratio is reported, not generalised.
- The holdout is on by default (10%). A board session that hashes into it runs master-like
  settings; that dilutes the effect and does not bias it. The share of held-out sessions is
  reported from the ledger in the images' results.

## What the transcripts are searched for

Fixable product issues, missed savings and cheaper strategies, as in the earlier campaigns.
Each finding is recorded with a disposition.
