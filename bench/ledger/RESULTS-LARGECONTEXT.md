# Large-context results: the product beats their rules file, and one of our own mechanisms is costing us

Governed by the addendum in [PREREGISTRATION.md](./PREREGISTRATION.md), committed
before the run. Raw rows: `largecontext.jsonl` (364 rows, 4 harness failures
excluded and listed). Fixed n = 30 per arm per task, no early stopping.

## Why this experiment exists

The first campaign measured a rules file against a rules file and drew. Two
measurements showed that was the wrong contest.

**Where the money is.** Pricing the earlier 173 rows at Sonnet rates: output is
**25.3%** of spend, cache_read **58.2%**, cache_creation 16.4%, input 0.1%. A
rules file can only reach the output quarter.

**Why our own mechanism had never been measured.** The largest file any task in
the old battery produced was **0.3 KB**, against a substitution threshold of
~25 KB. Outlining, bounding and re-read substitution had never fired once in
any campaign this harness had run. The earlier finding that `assist-norules`
was indistinguishable from control described a battery in which the mechanism
could not activate. Withdrawn.

## The headline

All figures: cost per unit of work delivered, failures charged, n=30, **100%
completion on every arm and every task**.

| arm | vs control | |
| --- | --- | --- |
| `ours-rules` (our 510-char text) | **0.661** [0.621, 0.699] | -33.9% |
| `assist` (the full product) | **0.694** [0.657, 0.730] | -30.6% |
| `tokenade-rules` (their 2,667-char text) | **0.790** [0.757, 0.827] | -21.0% |

**Primary endpoint, pre-registered: `assist` against `tokenade-rules` =
`0.878` [0.831, 0.926]** — the interval excludes parity. A 12.2% win.

| task | ratio | |
| --- | --- | --- |
| large-file-defect | 0.887 [0.868, 0.905] | significant |
| noisy-command | 0.868 [0.821, 0.929] | significant |
| whole-file-transform *(adversarial)* | 0.879 [0.758, 1.025] | spans parity |

## The finding that matters more than the win

Attribution — `assist` against `ours-rules`, which isolates interception from
text:

| task | ratio | what it says |
| --- | --- | --- |
| large-file-defect | 0.926 [0.904, 0.944] | interception **helps 7.4%** |
| noisy-command | 0.925 [0.880, 0.987] | interception **helps 7.5%** |
| whole-file-transform | **1.356** [1.125, 1.642] | interception **costs 35.6%** |
| **aggregate** | **1.051** [0.986, 1.119] | spans parity |

Interception does real work exactly where it was designed to — a large file to
locate something in, and a large tool result to sift. It then loses more on the
whole-file rewrite than it wins on the other two combined, and the aggregate
comes out **net negative**: our hooks currently cost about 5% against simply
shipping our text.

That is a concrete, reproducible product defect, not a measurement artifact.
When the model is going to rewrite an entire file, handing it an outline is
strictly harmful: it pays for the outline, then has to read the file anyway.
`ours-rules` beats `assist` by 35.6% on that task for exactly that reason.

**Fixing it is the highest-value work available.** With the regression removed,
`assist` would beat `ours-rules` on all three tasks and the margin over
tokenade's text would widen well past 12.2%.

## The caveat that bounds every number above

`tokenade-rules` is **their rules file alone**. Their real product
(`@tokenade/cli`, installable, freemium) also intercepts reads and compacts
command output — their own README names "whole files when one function
mattered, 2,000-line build logs". Their actual mechanism competes on the same
74.7% this experiment targets, and it is absent from this arm.

**So this is not "we beat tokenade".** It is: our full product is 12.2% cheaper
than their rules file, and our text alone is 16.4% cheaper than their text. A
claim about their product requires their product, which needs an account.

## What I got wrong, recorded

- **I labelled `whole-file-transform` adversarial and it is not** — at least
  not in the way I reasoned. I argued an outline is useless there and forgot
  that bulk editing is a different mechanism of ours that thrives on it. It
  did behave adversarially in the end, but for a reason I did not predict, so
  the label was luck rather than design. The large-context battery still needs
  an adversarial task chosen on purpose.
- **Three earlier build-2 results that survived multiplicity correction are
  withdrawn** — they were all n=6-7 early stops under the adaptive rule, which
  is optional stopping and manufactures exactly that.
- **Four runs were killed by my own container cleanup**, not by the product.
  They are classified as harness failures, excluded, and listed in the report.
  Before that classifier existed they dragged an arm from score 1.00 to 0.30
  on a task it had never actually failed.

---

# After the fix: the confirmed regression is gone

The whole-file-rewrite penalty above was caused by a dead parameter.
`substitutionFor` accepted `alreadyRead`, echoed it back, consulted it nowhere,
and no caller passed it -- so a file was replaced by an outline of itself on
**every** read of it. When the model needs the file's bodies, an outline of its
signatures cannot answer, so it reads again, receives another outline, and the
loop repeats until the size floor rises with the turn count.

The fix is one outline per file per session. Asking twice is the signal: the
hook cannot know at read time whether the model wants a symbol's location or
its contents, and it does not need to.

Re-measured on a fresh build, fixed n=30, **all three tasks now complete**.
Attribution -- `assist` against `ours-rules`, isolating interception from text:

| task | before the fix | after the fix | |
| --- | --- | --- | --- |
| whole-file-transform | **1.356** [1.125, 1.642] | **1.143** [0.946, 1.393] | penalty no longer established |
| noisy-command | 0.925 [0.880, 0.987] | 0.912 [0.834, 0.991] | still a win |
| large-file-defect | 0.926 [0.904, 0.944] | **0.973** [0.912, 1.048] | **win no longer established** |
| **aggregate** | **1.051** [0.986, 1.119] | **0.942** [0.893, 0.992] | net cost became a net win |

**The fix did what it was for, and it also cost something.** The whole-file
rewrite penalty was confirmed before and is not confirmed now, and the aggregate
crossed from 1.051 -- interception costing about 5% against shipping our text
alone -- to 0.942, whose interval excludes parity. That is the headline.

**But `large-file-defect` moved the wrong way and the earlier draft of this
section predicted it would not.** It read "holding steady at about 0.91 --
consistent with the 0.926 it showed before the fix, so the fix does not appear
to have cost the tasks interception already won". At full n it is 0.973 with an
interval spanning parity: a 7.4% win became no established effect. One outline
per file per session is exactly the thing that helps a task whose whole shape is
"locate a defect in a large file", so capping it removed some of what
interception was winning there. The fix is still worth it on the aggregate, but
it is a trade and not a free repair.

Against control, all three tasks, after the fix:

| arm | vs control | |
| --- | --- | --- |
| `assist` | 0.699 [0.658, 0.742] | -30.1% |
| `ours-rules` | 0.696 [0.649, 0.743] | -30.4% |

**Two limits on the aggregate above, both printed by the harness itself.** It is
computed over 2 of the 3 tasks, because `whole-file-transform` does not converge
and is excluded from the headline by the rule in PREREGISTRATION.md. And with
that task excluded, no adversarial task remains resolved, so the run carries the
harness's own `NO ADVERSARIAL TASKS RESOLVED -- this comparison has no bias
control` warning. `noisy-command` on its own excludes parity but does not
survive correction for the 6 tests on this track. The aggregate is the strongest
honest statement available, and it is weaker than a three-task result would be.

## What I got wrong completing this cell, recorded

- **The published "12 of 30 reps" was wrong twice over.** It was read from
  `postfix-merged.jsonl`, a stale artifact holding 12 assist reps of that cell
  while `postfix.jsonl` held **27** at the same build key. The merged file had
  understated a paid cell by 15 runs, and the number reached this document
  without ever being checked against the source stores.
- **The top-up collided with existing rep labels and shadowed three paid runs.**
  To keep the build key intact, the 3 remaining reps were run from a worktree at
  the provenance commit `a695840` -- which predates the `nextRep` fix. At that
  commit `coldArm` passes no `startRep` to `runColdTask`, which defaults to 1, so
  a 3-rep top-up labelled itself 1,2,3 over labels already in use. The store held
  30 rows and the reader, keeping the newest row per key, reported n=27. The rows
  were relabelled to unused numbers; nothing was discarded and no measured field
  was altered. Pinning provenance by checking out the old commit reintroduces
  every harness defect that commit had -- the reason `--commit-sha` should exist
  as a flag instead.

---

# Method correction: the multiplicity test was not null-calibrated

Review found that the value fed to Holm-Bonferroni was not a p-value. It was
the achieved level of the percentile interval -- twice the smaller tail of the
resampled ratio distribution -- which resamples the OBSERVED arms and never
simulates parity. It also had a failure mode that flattered us: whenever a
ratio sits cleanly away from 1, every bootstrap draw lands on one side, the raw
tail is zero, and the level pins to its clamp of 1/(n+1) -- where `n` is the
count of FINITE resampled ratios, which can be fewer than the 2,000 draws once
invalid ones are filtered. The smallest non-zero level the raw formula can
otherwise produce is 2/n, one draw on the short side. Either way the value that
reaches the correction is a function of the resample count rather than of the
effect, and at 2,000 draws it clears any family-wise threshold this benchmark
uses -- so "survives multiplicity correction" was being decided by how many
times we resampled.

Replaced with a permutation test. Under the null that the arm label does not
matter, a run's (cost, score) pair is exchangeable between arms: pool the
pairs, deal them back into groups of the original sizes, recompute the ratio of
totals, and count how often chance alone produces a departure from parity at
least as large as the observed one. The (+1) in numerator and denominator is
Phipson-Smyth, so a p-value is never exactly zero -- a permutation test cannot
resolve past its own resample count and should not claim to.

Unresolved tasks now count toward the family as well. They are still excluded
from the headline, but the report PRINTS their intervals, and an interval a
reader can see is one a reader can quote.

**That is not in tension with `large-file-defect` above carrying no interval.**
Two different situations wear the word "unresolved". A task that reached its
pre-registered n and still has a wide interval IS reported, interval and all,
and is corrected with the rest -- the width is the result. A task that never
reached its n, as `large-file-defect` had not at 12 of 30 reps, has no result
to report at any width, so no interval is quoted for it and it is not in any
family. The first is an answer that happens to be imprecise; the second is not
an answer.

**No published conclusion changes.** Re-run under the corrected test:

| comparison | headline | family | survives correction |
| --- | --- | --- | --- |
| assist vs **tokenade-rules** | 0.878 [0.831, 0.926] | 9 | large-file-defect, noisy-command |
| assist vs **ours-rules** | 1.051 [0.986, 1.119] | 9 | all three |

**The two rows are different comparisons, and an earlier draft of this section
read them as one.** Against *tokenade-rules*, `whole-file-transform` does not
survive correction (p = 0.106), which matches its interval spanning parity.
Against *ours-rules* it does survive (p = 0.011) -- and it survives as a
**loss**, at ratio 1.336: that is the interception penalty being confirmed, not
a win. A task can be significant against one baseline and not another, and
saying "survives correction" without naming the baseline invites exactly the
contradiction that was here.

What changed is that the claim is now defensible, not that the numbers moved.
