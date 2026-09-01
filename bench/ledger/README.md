# Ledger

A cost benchmark for coding agents that **charges every run, including the ones
that fail**, and refuses to publish a number it cannot support.

It exists because we tried to use an existing leaderboard to decide whether a
change to our own product helped, and could not. The defects below are not
hypotheses; each is something that produced a wrong answer we acted on.

## What was wrong with the instrument we were using

| Defect | What it did to us |
|---|---|
| Ranking averages `total_cost_usd` over runs with `status = 'ok'` | Dropping failed runs drops **their cost too**. Failing a task is free, and an entrant that fails the expensive half of a battery is scored only on the cheap half. |
| Fresh state directory per run | Any mechanism that carries knowledge between sessions is structurally unmeasurable. It can only ever score within-session behaviour. |
| Fixed rep count (n=3) | One run at 2.4× its siblings (`[0.113, 0.111, 0.273]`, cv 56%) moved a headline from −3.2% to −10.6%. Three samples cannot separate that from a real effect. |
| Bimodal tasks unflagged | One task costs ~$0.24 **or** ~$0.35 depending on the path taken. A mean over it is a number the task never produces. |
| No build identity in rows | Every row reported the same package version whatever built it, so a resumed arm silently averaged two builds. We shipped a "22.3% improvement" that was two days of unrelated changes. |
| Cost is the only axis | Nothing penalises a worse answer that costs less — the exact failure mode a token optimizer is prone to. |

## What Ledger does instead

**Charges failures.** The headline is cost per unit of work actually delivered:

```
costPerUnit = sum(usd over ALL runs) / sum(score over ALL runs)
```

A failed run contributes its cost and a score of 0. Halving spend by producing
half-right answers moves numerator and denominator together and gains nothing.
Completion rate is reported *beside* cost, never folded into it.

**Scores deterministically.** Each task ships its own verifier returning `[0,1]`
from concrete checks — a test that passes, a symbol that exists, an answer
matching a known value. No LLM judge, no rubric. A rubric argument is
unfalsifiable; a failing assertion is not.

**Two tracks, never averaged.** `cold` starts from fresh state (what existing
leaderboards measure). `warm` lets state accumulate across an ordered sequence
in one repository (how these tools are actually used). A tool that wins one and
loses the other is described that way.

**Samples until the interval is tight.** Reps continue until the bootstrap
interval on the median narrows below 10% of the estimate, or a spend cap is
reached. A task that never converges is reported by name as `UNRESOLVED` and
**excluded from the headline** rather than averaged in. If more than a third of
the battery is unresolved, the comparison is withheld rather than caveated — a
number with a footnote gets quoted without the footnote.

This costs more than a fixed n=3: a clean task needs roughly 8 reps per arm to
reach 10% precision. That is the price of being able to defend a 10% claim.

**Percentile bootstrap on the median, seeded.** No normality assumption, because
the data is openly bimodal. Seeded, because a published interval that cannot be
recomputed from the published rows is not evidence. Ratios resample arm and
control *jointly*, so a control that wanders widens the interval instead of
lending the arm false confidence.

**Refuses mixed builds.** Every row carries `image_digest` and `commit_sha`, and
summarising a group spanning two builds throws. Not a warning — a warning in a
long campaign log is indistinguishable from no warning.

## Why you should trust a benchmark written by a vendor

You shouldn't, on assertion. So:

- Every run row is published, with the image digest and commit that produced it.
- The task set **must** include families where our own approach cannot help —
  single-shot tasks, novel repositories, pure generation — and we report our
  losses there first.
- The harness is reproducible by anyone; the statistics are seeded and exact.
- The guards are mutation-tested: removing failure-charging, downgrading the
  build guard, folding unresolved tasks into the headline, or swapping the
  median for the mean each break the suite (`tests/bench/ledger.test.mjs`).

If our product wins here and loses everywhere else, that is a fact about this
benchmark, and the raw rows are published so you can find it.

## Status

**Built and tested, no API spend required:**

- measurement layer -- scoring, adaptive sampling, provenance, ranking
- task contract with weighted deterministic verifiers
- campaign runner -- cold reps and warm sequences, with the executor injected
- starter battery, including the declared adversarial families

75 tests. Eight guards are mutation-verified rather than merely green: removing
failure-charging, downgrading the build guard to a warning, folding unresolved
tasks into the headline, swapping the median for the mean, dropping failed runs
from the ledger, giving warm tasks separate state directories, making
provenance optional, and letting `adversarial` go undeclared each break the
suite.

**Not yet built:** the docker executor that actually drives an agent. It is a
single injected function:

```js
execute({ task, arm, track, rep, stateDir })
  -> { status, usd, turns, workspace }
```

That is deliberately the only part which costs money to exercise. It never
scores anything — the verifier belongs to the task, so an executor cannot
influence its own mark.
