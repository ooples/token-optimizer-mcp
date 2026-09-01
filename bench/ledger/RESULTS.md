# Confirmatory run: our rules file against tokenade's

Governed by [PREREGISTRATION.md](./PREREGISTRATION.md), committed before the run.
Raw rows: `confirmatory.jsonl` (build 1), `confirmatory-build2.jsonl` (build 2).

## The headline

**The pre-registered claim is not established.**

| | ratio | 95% interval | verdict |
| --- | --- | --- | --- |
| **Primary** -- `ours-rules` vs `tokenade-rules`, all 6 cold tasks, build 1 | **0.951** | **[0.857, 1.059]** | **spans parity** |
| same, build 2 | -- | -- | withheld, 50% unresolved |

Our 510-character block and their 2,667-character file are **indistinguishable
in cost per unit of work delivered**. The point estimate favours us by 4.9% and
every one of the six tasks points the same way, but the interval contains 1.0
and the pre-registration named exactly that as falsifying.

What can honestly be said: **equal measured effect at one fifth the length**.
Not "we beat them".

## Every task, so the aggregate can be checked against its parts

`ours-rules` / `tokenade-rules`, cost per unit delivered, cold track:

| task | ratio | interval | |
| --- | --- | --- | --- |
| explain-failure | 1.003 | [0.908, 1.144] | spans parity |
| needle-in-repo | 0.969 | [0.764, 1.241] | spans parity |
| flooded-symbol | 0.969 | [0.827, 1.131] | spans parity |
| pure-generation | 0.871 | [0.643, 1.193] | spans parity |
| single-shot-extract | 0.959 | [0.748, 1.265] | spans parity, **unresolved** |
| debug-pipeline-py | 0.766 | [0.674, 0.881] | excludes parity, **unresolved** |

Nothing survives Holm correction across the track's seven tests. The one task
whose interval excludes parity never converged, so it is excluded from the
headline by the stopping rule rather than by choice.

**The authorship conflict resolved against us, which is worth stating plainly.**
`explain-failure` is the task I wrote after designing the block, with a rubric
rewarding what the block instructs -- the task most likely to flatter us. It is
the one task where we do not lead: 1.003, a dead tie. Had it come back as our
biggest win, that number would have been worth very little.

## Robustness checks, as pre-specified

| check | result |
| --- | --- |
| 1. Drop `explain-failure` | **cannot be evaluated** -- 40% of the remaining battery unresolved, headline withheld |
| 2. Drop both pilot tasks (4 tasks never seen for these arms) | 0.935 [0.818, 1.069] -- **spans parity** |
| 3. Second build | direction agrees on **all six tasks**; headline withheld (50% unresolved) |

Check 2 is the one that matters for selection bias, and it agrees with the
primary: same direction, same failure to separate.

### Check 3 in full -- an independently rebuilt image

Different image digest, same everything else. `ours-rules` / `tokenade-rules`:

| task | ratio | interval | |
| --- | --- | --- | --- |
| flooded-symbol | 0.945 | [0.914, 0.972] | **survives Holm correction** |
| single-shot-extract | 0.943 | [0.918, 0.969] | **survives Holm correction** |
| explain-failure | 0.913 | [0.862, 0.964] | **survives Holm correction** |
| needle-in-repo | 0.910 | [0.797, 1.011] | spans parity, unresolved |
| debug-pipeline-py | 0.847 | [0.756, 0.945] | unresolved |
| pure-generation | 0.834 | [0.790, 0.878] | unresolved |

**Every task favours us, and three survive correction.** This is the strongest
evidence in the whole exercise, and it still does not license the claim: the
headline is withheld because half the battery did not converge, and the
pre-registered primary was the headline, not a count of per-task wins.

Two things this build says that cut the other way, and both belong here:

- `explain-failure` moved from **1.003** on build 1 to **0.913** on build 2.
  That is a large swing on a task with no reason to be build-sensitive, and it
  is a direct measurement of how much build-to-build variation this battery
  carries.
- Build 2's intervals are far tighter than build 1's for the same tasks
  (`flooded-symbol`: [0.914, 0.972] against [0.827, 1.131]). Two runs of the
  same experiment producing that different a precision is itself a caution
  against reading either one alone.

### Reading the two builds together

| | build 1 | build 2 |
| --- | --- | --- |
| primary headline | 0.951 [0.857, 1.059], spans parity | withheld, 50% unresolved |
| tasks favouring `ours-rules` | 5 / 6 | 6 / 6 |
| surviving Holm correction | none | flooded-symbol, single-shot-extract, explain-failure |

Direction is consistent across every task in both builds. Magnitude is
consistent too, at roughly 5-10%. What is missing is not the effect -- it is the
power to resolve it, and that is a fixable property of the battery rather than
a fact about either product.

**Verdict: not established as pre-specified. Do not claim the win.**

## Retraction

An earlier stage of this work reported **`0.639 [0.546, 0.940]`, a significant
win on `debug-pipeline-py`**. That number is withdrawn. Two independent reasons:

1. It compared `assist` -- our hooks **plus** the block -- against their text
   alone. It was described as text against text. It was not.
2. It was computed with an interval that was too narrow (see below). Re-analysed
   through the corrected estimator, the pilot's tasks come back **100%
   unresolved** and no headline is computable from them at all.

The pilot is exploratory. Nothing in it is a result.

## The defect that made every earlier interval too narrow

Found by reading a report adversarially, not by a test. A real line read:

    single-shot-extract   0.924  [0.935, 1.030]

A point estimate cannot lie outside its own interval. It did because the two
were different statistics sharing a label: the point was a ratio of totals
(the ledger's stated definition) while the interval resampled a ratio of
*medians of per-run unit costs*. They agree on tidy data -- which is why every
existing test passed -- and diverge exactly where the answer matters.

The median form was also wrong on the ledger's own terms: a run scoring zero has
no unit cost, so a median over unit costs drops it, and an arm could lower its
published cost by failing. That is the one defect this ledger exists to remove.

Corrected intervals are markedly wider. `flooded-symbol` was `0.969
[0.882, 0.985]` and is now `0.969 [0.827, 1.131]`. **Several results that read
as significant are not**, and I had reported from them.

## What this says about the benchmark itself

Three of six tasks never converged at the 12-rep cap, with intervals of 20-36%.
With honest intervals the battery cannot resolve an effect of the size actually
present (~5%). That is a finding about the instrument, not about either product:

- More reps, not fewer tasks. The cap is a spend control; it was not chosen to
  resolve 5% and does not.
- The unconverged tasks (`pure-generation`, `single-shot-extract`,
  `debug-pipeline-py`) are bimodal in cost -- the agent either finds the answer
  in two turns or hunts for six. That variance is the target for redesign.

The cap was **not** raised after seeing these numbers, which the
pre-registration forbids. Any rerun at a higher cap is a new experiment and will
say so.

## Known limits, none of them fixed by more data

- **Not a full replica of the competitor.** Their binary and six hooks cannot
  run in this image, so this compares the two rules files and nothing else. If
  their hooks contribute materially, this understates them.
- **I wrote all six tasks.** Two are marked adversarial -- designed so our
  approach cannot help -- which is a structural defence, not a cure.
- **One model, one day, two builds.**
- **The pre-registration is not blind.** I had seen the pilot. It says so.
