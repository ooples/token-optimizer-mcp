# #565 held-out check: do the fixes generalise? (pre-registration)

Written and committed before any run of this campaign, and before any
transcript, score or cost of these four tasks was opened.

## Question

The #565 development set exposed two defects in our arm, and both were fixed
using those development transcripts (`../565-five-product/RESULTS-BEFORE-FIXES.md`):

- `smart_grep` sends hits grouped by file, with a `distinct` summary;
- `disclose` no longer withholds a log body behind an envelope field.

Fixes tuned on a set always look better on that set. This campaign asks whether
the arm holds up on four tasks nobody has looked at.

## Tasks

The four drawn held-out tasks from the #565 pre-registration, unchanged:

- code-debug-cascade-py
- code-debug-ledger-py
- code-feature-js
- report-pdf

web-research-oss-inventory, the fifth held-out task, is not run here. It costs
about $5 a run, and the user chose to decide on it after this result.

## Arms and design

- The same 8 arms as #565, reusing `../565-five-product/arm-order.json`
  unchanged (sha256 `883c60c5…`).
- n = 3 repetitions × 4 tasks × 8 arms = **96 runs**, serial, one segment.
- A fresh results volume, `thol-results-565-heldout`.
- Estimated spend about $25 (#565 averaged $0.21 a run); approved by the user.

## What our arm runs

There is no release containing the fixes. The user chose not to cut one until
every #565 finding is addressed. So the image carries a packed tarball of
`bench/five-product-campaign` at head `534ce0f4` (tree `152076f2…`, clean),
installed both globally and into the seeded 7.11.0 runtime
(`Dockerfile.reinstall`). The version string still reads 7.11.0, because the
entrypoint requires the pin and the seeded runtime to agree. The tree hash in
`/opt/optimizer-provenance.json` is the identity.

Competitor arms and their pins are unchanged from #565. The only change is that
the headroom arms now stop their detached proxy after each run (534ce0f4). That
changes host memory, not anything the model sees.

## Endpoints

- **Primary: cost.** Per-task mean `total_cost_usd` divided by control's on the
  same task, with a bootstrap CI over tasks (`analyse-campaign.py`, seed
  20260913). With 4 tasks the CI will be wide. "Cheaper" is claimed only if it
  excludes 1.0, and is not expected to.
- **Secondary: `cold_start_cost_usd`**, as amended in the #565 pre-registration.
- **Quality guard: score.** Per task. An arm with a lower mean score on a task
  is reported as a quality loss there, whatever it costs. report-pdf's score is
  reported for every arm.
- **Failures:** every non-`ok` run, by arm, task and error. Non-ok runs are
  re-run by resume and both are reported.

## Reading

- Our arm at or below control on the primary endpoint, with no quality loss,
  means the fixes did not overfit. It does not show they help: these tasks may
  not exercise either fix.
- Our arm above control means it is a finding. It goes through the same
  transcript analysis as #565 before anything is changed.

All results are published whichever way they fall.

## Post-results notes, 2026-11-15 (#590 review)

The text above is left as registered. These notes were added after the results
and change no number in them.

- **Reading.** The first bullet said an at-or-below-control result "means the
  fixes did not overfit". It cannot. Neither fixed path fired on these tasks
  (`RESULTS.md`), so the most this outcome supports is *no regression detected
  on these held-out tasks*. A claim that the fixes generalise needs held-out
  tasks that exercise them. `RESULTS.md` is worded to match.
- **Arm-order checksum.** `883c60c5…` is the hash of the CRLF checkout the rig
  read. The committed LF blob hashes `ad54734b…`. The two files are
  byte-identical once CRLF is removed. See the note in the #565
  pre-registration.
- **Commit hashes.** #590's history was rebuilt so its commit messages pass
  commitlint, and the bench commits were re-parented onto master without the
  product commits they had sat on. `534ce0f4` (the measured head) and
  `ac3ae488` (this file as registered) are therefore not on the rebuilt branch.
  Both stay reachable from the signed tag `thol-565-heldout-as-run`. The
  packed tree `152076f2` that the campaign ran is unaffected.
