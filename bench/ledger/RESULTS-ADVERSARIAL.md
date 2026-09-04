# The adversarial task did not behave adversarially

Governed by Addendum 2 of [PREREGISTRATION.md](./PREREGISTRATION.md), committed
before this run. Raw rows: `adversarial-confirm.jsonl` (180 rows, one build,
image `sha256:e88226334c19` at commit `3c2ea4e8`). Fixed n = 60 per arm, no
early stopping. 100% completion on every arm.

## Why the task exists

The large-context aggregate rests on tasks our mechanism is built to win. Its
only declared adversarial task, `whole-file-transform`, does not converge, so it
is excluded from the headline -- and with it gone the attribution comparison
prints the harness's own `NO ADVERSARIAL TASKS RESOLVED -- this comparison has no
bias control`. `generation-amid-bulk` was designed to close that gap: the answer
exists nowhere in the tree, and the tree is 1,200 generated functions that
indexing must chew through and can never use.

## The result

| comparison | ratio | |
| --- | --- | --- |
| `ours-rules` vs control | 0.556 [0.513, 0.600] | -44.4% |
| `assist` vs control | 0.496 [0.457, 0.539] | -50.4% |
| **`assist` vs `ours-rules`** | **0.892 [0.821, 0.969]** | interception wins 10.8% |
| control vs `ours-rules` | 1.800 [1.664, 1.944] | |

## This is a finding against us, and it was pre-registered as one

The pre-registration says, in advance:

> `assist` **winning** this task against `ours-rules` would indicate the battery
> is rigged rather than that we are good. Parity is the expected and acceptable
> result; a loss is acceptable. A win is a finding against us.

`assist` wins, and the interval excludes parity. **The task does not work as a
bias control.** It is a fourth task our mechanism wins, not a counterweight to
the three we already had.

The harness separately marks it `UNRESOLVED`: the ratio interval is about 14.8%
wide, above its convergence bar, so the headline is still withheld and the
`NO ADVERSARIAL TASKS RESOLVED` warning still prints. Both statements are true
together -- it did not converge by the harness's rule, and its interval
nonetheless excludes parity in the direction that is bad for us. Neither cancels
the other.

## Why the design was wrong

The reasoning was: if the answer exists nowhere in the tree, retrieval,
outlining and substitution have nothing to offer and only their overhead to
charge. The missing step is that the 1,200-function bulk is still *present*, and
the agent still touches it incidentally -- and when it does, read substitution
turns an expensive read into a cheap outline. **The bulk added to make the task
adversarial is the same thing that gave interception something to win.**

Adding "the code already in pkg/ is unrelated and need not be read" to the prompt
cut the variance it was meant to cut -- the n=12 pilot projected +/-17% at n=30,
and the arms came in at 9% and 12% against control at n=60 -- but it did not stop
the agent looking, so it did not remove the opportunity.

## Score so far on adversarial design: 0 for 2

- `whole-file-transform` behaved adversarially, but for a reason not predicted --
  the label was luck rather than design, and it does not converge.
- `generation-amid-bulk` was designed on purpose and is not adversarial at all.

**The battery still lacks a converging adversarial task.** Every aggregate that
excludes `whole-file-transform` continues to carry the harness's bias-control
warning, and no number in this project should be quoted as if that warning were
absent.

## What would actually be adversarial

Stated as a hypothesis for the next attempt, not as a result. The mechanism wins
whenever large content is *reachable*, whether or not the task needs it. So an
adversarial task cannot merely make the content irrelevant -- it must make it
absent, or make substitution actively harmful:

- **No bulk at all.** A generation task in a genuinely small repo removes every
  read worth intercepting. The risk is that it stops being a *large-context*
  task, which is the regime this battery exists to measure.
- **Content that must be reproduced verbatim.** An outline cannot answer, so the
  substitution is paid and then discarded. This is `whole-file-transform`'s
  design; the open problem is its variance, not its direction.

The honest position until one of those converges: our mechanism has no measured
counterweight in the large-context regime.
