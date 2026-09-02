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
