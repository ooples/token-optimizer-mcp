# Pre-registration: does our output-discipline block beat tokenade's rules file?

Written and committed **before** the campaign it governs, so that the analysis
cannot be chosen after the numbers are in. The commit that adds this file is
recorded in the report; a reader can check that it precedes every row's
`started_at`.

## What this is not

**Not a blind pre-registration, and calling it one would be the first lie.** A
previous campaign already ran two of these tasks and reported a win. I have seen
that data. What this document can honestly do is fix the analysis for a *new*
confirmatory run over the *full* battery, so the outcome cannot be steered by
choices made after seeing it. What it cannot do is un-see the pilot.

The pilot is therefore reclassified, in this document and in anything that cites
it, as exploratory. Nothing in it is a result.

## The claim under test

Our 510-character `CLAUDE.md` block delivers cost per unit of work delivered at
or below tokenade's 2,667-character rules file, at equal or better task success.

## Arms

Exactly three. All three get the same image, the same model, the same task set,
the same rep budget.

| arm | what it carries | delivery |
| --- | --- | --- |
| `control` | nothing | -- |
| `ours-rules` | `OUTPUT_DISCIPLINE`, 510 chars | `CLAUDE.md`, no hooks, optimizer off |
| `tokenade-rules` | their scaffold block, 2,667 chars | `CLAUDE.md`, no hooks |

`ours-rules` imports the shipped constant rather than copying it, so the
measured text cannot drift from the text users get.

**The known asymmetry, stated up front:** tokenade also ships a binary and six
hooks that cannot run in this image. If those contribute materially, this
comparison understates them. It is a comparison of the two rules files, and it
will be described as nothing more.

## Tasks

All seven. Not a subset, and the subset is the reason this document exists:
the pilot ran two, and they were the two where movement had already been seen.

`explain-failure`, `flooded-symbol`, `debug-pipeline-py`, `single-shot-extract`,
`pure-generation`, `repeat-comprehension`, `needle-in-repo`.

**Authorship conflict, declared:** I wrote all seven, and I wrote
`explain-failure` *after* designing the block, with a rubric that rewards
brevity -- which is what the block instructs. It is the task most likely to
flatter us. It stays in the battery, because dropping a task after seeing its
result is the same offence in the other direction, but the headline is required
to survive its removal (see *Robustness* below).

## Primary endpoint

One number, fixed now: the **geometric mean of per-task cost-per-unit ratios,
cold track, `ours-rules` against `tokenade-rules`**, with its bootstrap
interval.

Cost per unit delivered is `sum(usd) / sum(score)` over all runs including
failures, so a cheap arm that fails cannot win by failing.

## Secondary endpoints

Declared now so they cannot be promoted to primary later: output tokens,
completion rate, per-task ratios.

## Stopping rule

The existing precision rule, unchanged: reps continue until the bootstrap
interval on the median reaches a width ratio of 0.10, with a floor of 6 and a
cap of 12 reps per task per arm. A task that has not converged at the cap is
reported unresolved and excluded from the headline. **No arm's reps are extended
after looking at its ratio.**

## Multiplicity

Per-task intervals are corrected with Holm-Bonferroni across **every test the
track publishes** -- both arms, all resolved tasks -- at family-wise alpha 0.05.
A per-task win is only reported as a win if it survives that correction.

The primary endpoint is a single pre-specified test and is not corrected.

## Robustness, specified before the data

The headline must hold under each of these, or the failure is reported:

1. **Drop `explain-failure`** -- the task with the authorship conflict.
2. **Drop the two pilot tasks** (`explain-failure`, `debug-pipeline-py`), leaving
   five tasks whose results I have never seen for these arms.
3. **Second build.** The whole campaign repeats on an independently rebuilt
   image. Direction must agree. One build is one day's noise.

## What would falsify the claim

Any of: the primary interval spans parity; the primary point estimate exceeds
1.0; `ours-rules` completes fewer tasks than `tokenade-rules`; the direction
flips on the second build; or the headline depends on `explain-failure`.

Each of these is reported if it happens. A pre-registration whose author only
publishes when it passes is a press release.
