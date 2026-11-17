# #610 on the board: task classification vs master

Written and committed before any run.

`594-discipline-bycat` decided the per-category settings using 3 tasks per category. It was
not a board result, and presenting it as one was the mistake this campaign corrects. Here,
the whole product is measured on every reproducible task: #610 as shipped (classifier,
per-category settings, holdout telemetry) against master as of this campaign.

## What runs

- **Images**, built from this branch's rig with each product packed by `bench:pack`:
  - `thol-rig:pr610`: token-optimizer-mcp 6c3bd71d (tree 55cfe546), `feat/task-class-settings`.
    Amended before any run; see "Amendment 2" at the end.
  - `thol-rig:master`: token-optimizer-mcp 1518a5d7 (tree 8b68d518), master.
  - `/opt/optimizer-provenance.json` is checked in each image before launch.
- **Arm:** `token-optimizer-mcp` in both images. Nothing else differs between the images.
- **Results volumes:** `thol-610-board-v2-pr610` and `thol-610-board-v2-master`, one per image. The runner keys resume on (competitor, task, rep) under the client version, which is the same in both images (2.1.325), so a shared volume would skip the second image's runs.
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

## Amendment 1 (2026-11-16, before any run was recorded)

The first launch spent nothing. It stopped while building its plan, because
`run.sh` passed `REPS=<rep>` while `arm-order.json` holds five orders.
`run.sh` now gives each call the first `rep` orders of `arm-order.json`. That
is a prefix of the committed plan, never a reordering, and with one arm every
order is the same.

While it was stopped, the product under test changed:

- **What was found.** Two judge models labelled 1,192 of the user's real
  prompts. On those, the classifier at 766d1d7e put 11.1% of non-survey prompts
  in survey, on sessions the rules were never tuned on.
- **What changed.** At 147f8e5a the survey bar is higher, and that rate is
  0.4%.
- **Is 766d1d7e still a candidate?** No. A board measured on 766d1d7e would
  describe a build that is no longer a candidate, so the pr610 image was rebuilt
  at 147f8e5a.
- **What stays fixed.** The master image, tasks, reps, decision rule and stop
  are unchanged.
- **How the board classification is affected.** The classification of the board
  tasks above was re-checked at 147f8e5a and is listed below; any task whose
  category moved is named.

## Amendment 2 (2026-11-17, before any paid run)

Both result databases had no `runs` table when inspected, and no campaign was
running. Thus no previous paid results are being replaced or pooled.

- Candidate: `6c3bd71d52e7ae65d496e9b0100f474bcada5c3b`, clean product tree
  `55cfe5467358a265bf609b4dd232a8e2e8cd9a4c`.
- Baseline remains `1518a5d7c41f342e65dd10c89ee2595826607828`, clean tree
  `8b68d518a20e069fa09bc39c6fffff737ff7edf6`.
- Follow-ups now resolve accepted proposals and numbered choices from bounded
  conversation, then inherit the active task when unclear. Tool observations
  cannot replace a known task. Fix-to-survey transitions explicitly release
  previously delivered output-discipline instructions.
- The candidate image was rebuilt from this product tarball. Preflight caught
  that `Dockerfile.reinstall` omitted the local rewrite task; that recipe now
  copies local tasks as the full Dockerfile does. Both images contain the task.
- All 17 board prompts were classified again inside the rebuilt image; their
  categories match the list above. No task moved category.
- The real-prompt, judge-consensus evaluation is separate: prompt-only 147/487,
  contextual 155/487. This is not human gold and does not establish high accuracy.
- Tasks, five repetitions, alternating image order, category thresholds,
  success gate, outlier inspection and the $70 stop remain unchanged.

### Setup-only correction (2026-11-17, still zero paid runs)

The launch completed the harness selftest, then refused the sliced arm-order
file because its checksum differed from earlier setup metadata. Slicing the
file would also change its checksum between repetitions. The fixed committed
plan now explicitly allows prefixes; the wrapper validates all five orders,
executes the requested prefix, and always hashes the same complete file.
The wrapper change is applied identically to both images, without changing
either product. New `v2` volumes preserve the old setup-only volumes and avoid
silently rewriting their order metadata. No paid rows are discarded.
