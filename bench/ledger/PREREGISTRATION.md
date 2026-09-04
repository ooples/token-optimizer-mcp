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

Every task the cold track has. Not a subset, and the subset is the reason this
document exists: the pilot ran two, and they were the two where movement had
already been seen.

`explain-failure`, `flooded-symbol`, `debug-pipeline-py`, `single-shot-extract`,
`pure-generation`, `needle-in-repo`.

> **Amendment, made before any result was visible.** The first version of this
> document said "all seven" and listed `repeat-comprehension`. That task is
> warm-only by construction -- it measures the cost of returning to material
> already read, which a cold track has by definition never read -- so it was
> never in the cold battery and the count was simply wrong. Corrected 90
> seconds into the run, with rows on disk but no ratio computed and no report
> rendered. The correction is recorded rather than applied silently, because an
> amended pre-registration is only worth anything if its amendments are
> visible. The battery is six.

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
   four tasks whose results I have never seen for these arms.
3. **Second build.** The whole campaign repeats on an independently rebuilt
   image. Direction must agree. One build is one day's noise.

## What would falsify the claim

Any of: the primary interval spans parity; the primary point estimate exceeds
1.0; `ours-rules` completes fewer tasks than `tokenade-rules`; the direction
flips on the second build; or the headline depends on `explain-failure`.

Each of these is reported if it happens. A pre-registration whose author only
publishes when it passes is a press release.

---

# Addendum: the large-context experiment

Written and committed before the run it governs, as above.

## Why there is a second experiment

The first one measured a rules file against a rules file and drew. Two
measurements taken afterwards explain why that was the wrong contest:

**Where the money is.** Over the 173 rows of the first campaign, priced at
Sonnet rates:

| component | share of spend |
| --- | --- |
| output | 25.3% |
| cache_read | 58.2% |
| cache_creation | 16.4% |
| input | 0.1% |

A rules file can only reach the 25.3%. Interception, bounding and outline
substitution reach the other 74.7%.

**Why our own mechanism measured as nothing.** The largest file any task in
the first battery produced was **0.3 KB**. The optimizer's substitution
threshold is ~25 KB. Outlining, bounding and re-read substitution therefore
never fired once, in any campaign this harness has ever run. The earlier
finding that `assist-norules` is indistinguishable from `control` was true and
misleading: it is a statement about a battery in which the mechanism could not
activate, not about the mechanism.

That earlier conclusion is withdrawn as evidence about the product.

## The fixed-n design, and why the first experiment's numbers were soft

The adaptive stopping rule is optional stopping: it runs reps until the
interval looks narrow, so an arm stops early exactly when its sample happened
to be tight. Measured across the 36 arm-task cells of the two confirmatory
builds:

| | cells | mean CV |
| --- | --- | --- |
| stopped early (n<=7) | 15 | 9.4% |
| ran to the cap (n>=12) | 14 | 17.1% |

`corr(reps run, CV) = 0.357`. The three build-2 results that survived
multiplicity correction were all n=6-7 early stops, which is what this
procedure manufactures. **They are withdrawn.**

This experiment uses `--reps 30`, fixed, chosen before the run and never
revised. No convergence check, no early stop, no `unresolved` state.

## Arms

Four, all on the same image, model and task set.

| arm | carries |
| --- | --- |
| `control` | nothing |
| `assist` | THE PRODUCT: hooks, interception, bounding, outline substitution, graph |
| `ours-rules` | our 510-char block only, as a CLAUDE.md, optimizer off |
| `tokenade-rules` | their 2,667-char file, as a CLAUDE.md |

`ours-rules` is present to attribute: it separates what our text does from what
our interception does, which is the question the first experiment could not
answer.

## Tasks

The three large-context tasks, all new:

- `large-file-defect` -- one wrong line in a 342 KB module
- `noisy-command` -- a mandated `pytest -v` producing 49.5 KB of tool result
  (measured; `-q` produces 1.3 KB, which is why the flag is mandated)
- `whole-file-transform` -- **ADVERSARIAL**: every function in a 45 KB file must
  change, so an outline is useless and any substitution costs a wasted turn

The adversarial task is not decoration. If `assist` does not lose on it, the
task is not adversarial enough and must be made harder -- the same rule the
original set is held to.

## Primary endpoint

The geometric mean of per-task cost-per-unit ratios, cold track, **`assist`
against `tokenade-rules`**, with its bootstrap interval.

This is the product against the competitor, which is the comparison that was
never run.

## Secondary

`assist` vs `control`; `assist` vs `ours-rules` (the attribution that isolates
interception from text); output tokens; completion.

## Multiplicity

Holm-Bonferroni across every per-task test the track publishes, family-wise
alpha 0.05. The primary is a single pre-specified test and is not corrected.

## What would falsify the claim

The primary interval spanning parity; a point estimate above 1.0; `assist`
completing fewer tasks; or `assist` winning the adversarial task, which would
indicate the battery is rigged rather than that we are good.

---

# Addendum 2: a second adversarial task, and its pre-registered n

Written before the confirmatory run, after a pilot and because of it.

## Why

`whole-file-transform` does not converge, so the report excludes it from the
headline -- and with it gone the attribution comparison prints its own
`NO ADVERSARIAL TASKS RESOLVED -- this comparison has no bias control`. Every
task left in the aggregate is one our mechanism is built to win. That is the
shape of a rigged battery whatever the intervals say, and it is the gap this
task closes.

`generation-amid-bulk` -- **ADVERSARIAL**: the answer exists nowhere in the tree
and the tree is 1,200 generated functions the seed must index and can never use.
Our machinery has nothing to contribute and only its overhead to charge.

## The pre-registered n is 60 for this task, and here is the arithmetic

A pilot of 12 reps per arm (image `sha256:e882263...`, its own build, rows in
`pilot-adversarial.jsonl`) measured cost CV of **26.7%** for `ours-rules` and
**34.7%** for `assist`, giving `assist/ours-rules` = 1.057 [0.825, 1.355].
Projected to n=30 that is a **+/-17%** interval -- the band where
`whole-file-transform` sits unresolved, not the +/-7% where `large-file-defect`
resolves. At the measured variance, +/-10% needs n≈81 and +/-15% needs n≈38.

So n=30 was declared, in advance, insufficient for this task. **n = 60 per arm**,
fixed, no early stopping. If the variance reduction below lands, 60 buys roughly
+/-8%; if it does not, 60 still buys about +/-12%, which is inside the resolving
band. The number is set here so it cannot be chosen later from the data.

## The one change made to reduce variance, and why it is not a change of question

The prompt now states that the code in `pkg/` is unrelated and need not be read.
Our overhead on this task is paid by the session-start seed, which indexes the
tree before the agent decides anything, so what the agent then chooses to explore
is not what the task measures -- it was only adding spread. The bulk itself is
unchanged, and so is the property that makes the task adversarial.

## What would falsify the claim

Unchanged, and this task strengthens one clause of it: `assist` **winning** this
task against `ours-rules` would indicate the battery is rigged rather than that
we are good. Parity is the expected and acceptable result; a loss is acceptable.
A win is a finding against us.

## Honest limitation, stated in advance

This task enters its own campaign on its own build. It cannot join the existing
large-context aggregate, because adding a task changes the commit and therefore
the build key, and this ledger refuses to average across builds. Folding it into
the headline requires re-running every task and arm together; until that happens
it is reported as a standalone bias control and the aggregate keeps its warning.


---

# Addendum 3: a third attempt at a converging adversarial task

Written before the confirmatory run, after a pilot and because of it. This is the
third attempt; the first two are recorded below so the record cannot be read as
if this design were arrived at cleanly.

## What failed twice

- **`whole-file-transform`** had the right DIRECTION -- interception measured
  1.149 [0.962, 1.395] against `ours-rules` -- and unusable precision. Excluded
  from every headline as UNRESOLVED across three campaigns.
- **`generation-amid-bulk`** had the right PRECISION and the wrong direction. It
  was designed as a bias control and turned out to be a fourth task we win
  (0.892 [0.821, 0.969] at n=60). See RESULTS-ADVERSARIAL.md.

## The change, and why it should fix precision

`whole-file-retitle` requires each message to carry its own function's name, so
no single find/replace expresses the answer and the dominant cost -- emitting 120
unique strings -- is the same on every route. The strategy choice that produced
the spread is gone.

Measured in a 12-rep pilot (`retitle-pilot.jsonl`, image `sha256:abfce039`):
cost CV 20.4% (`ours-rules`), 24.3% (`assist`), 26.7% (control), against the old
task's projected +/-21% at n=30. Projected here: **+/-12.0% at n=30, +/-8.4% at
n=60**. Every one of the 36 pilot runs scored 1.000, so closing the cheap route
did not make the task unsolvable.

## The pre-registered n is 60, and the design is fixed here

**n = 60 per arm, fixed, no early stopping**, on `control`, `ours-rules` and
`assist`. 60 buys roughly +/-8.4%, inside the band where `large-file-defect`
resolves (+/-7%) and far from where `whole-file-transform` sat. The pilot rows do
NOT enter the result; they exist to choose this number.

## What would falsify it, stated before the data

The pilot's point estimate is **0.977 [0.816, 1.170]**, which is BELOW parity --
the opposite side from the old task's 1.149. So the honest possibilities are:

- **Interval spans parity** -- the intended outcome. Interception is measured and
  shown not to help where it cannot help. This is a valid bias control and clears
  the harness's `NO ADVERSARIAL TASKS RESOLVED` warning.
- **Interval excludes parity ABOVE 1** -- interception costs. Also acceptable,
  and a stronger control.
- **Interval excludes parity BELOW 1** -- `assist` WINS this task. Then it is not
  a bias control at all, it is a third task we win, and this attempt has failed
  exactly as `generation-amid-bulk` did. That outcome gets published as a third
  failure rather than reframed as a win, and the battery still has no converging
  adversarial task.
- **Interval still wider than +/-12%** -- the spread was never strategy choice,
  and the diagnosis in the commit message is wrong.

The pilot cannot distinguish the first three: its interval [0.816, 1.170]
contains all of them. That is the question n=60 is being bought to answer.

