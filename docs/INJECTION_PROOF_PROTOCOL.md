# Injection proof protocol

Pre-registered before the fix was written. The point of writing it first is that
the pass bar cannot be moved after seeing the numbers.

## The claim under test

That the knowledge graph makes an agent **measurably better at the work**, not
merely that it stores and can retrieve facts. Storage and retrieval were already
demonstrated; behaviour change was not.

## Baseline, measured 2026-08-04 (before any fix)

Taken from `metrics.jsonl` across three real project graphs after a long working
session.

| measurement | value |
|---|---|
| capture events (token-optimizer) | 4,053 |
| read events (token-optimizer) | 2,063 |
| **inject events that served a finding, all projects** | **2** |
| findings served for a `command`-type finding | 0 |

Two compounding causes, both verified by reading the shipped build:

1. **`forTouch()` is wired to nothing.** It is imported only by
   `tests/hooks/injection.test.mjs`. The production hook
   (`pretooluse-router.mjs`) imports `refusalPayload` and `substitutionFor` from
   the same module and never `forTouch`. So touching a file has never injected a
   finding; the only findings that reached a model arrived through the refusal
   path.

2. **There is no action trigger.** Injection is keyed on *file touch*, but the
   highest-value findings are about *actions*. The concrete case: a finding of
   type `command` — "run the suite with `npm test`, not `npx jest`" — is anchored
   to `plugin/hooks/lib/harvest.mjs`. An agent about to run `npx jest` is not
   touching that file, so the finding could never fire at the moment it mattered.
   It did not, and the agent lost a test cycle to exactly that mistake.

## Primary metric (the gate)

**Avoided dead-ends.** Seed the graph with N findings, each recording a real
dead-end already hit in this repository. A **fresh subagent** — no session
history, so it cannot know the answers — attempts tasks that walk into them.

- **Treatment**: graph enabled.
- **Control**: identical prompt, identical model, `TOKEN_OPTIMIZER_MODE=off`.

Pass requires **both**:

- **≥ 80%** of seeded dead-ends avoided in treatment that the control walks into.
- **0 regressions** — no case where an injected finding pushes the subagent into
  a *new* wrong path. A misleading finding is worse than no finding, so this is a
  hard zero, not a percentage.

## Secondary metric

**Tokens to the same correct outcome**, treatment vs control. Reported as a raw
number. Not a gate: token counts swing on unrelated choices, and a single run
cannot separate signal from that noise.

## Diagnostic

The **injection log** (`metrics.jsonl`, `kind: 'inject'`): what was served, for
which anchor or command, how many tokens, and whether the touch fell in the
stratified holdout. This explains *why* the primary metric moved, and is the
only thing that can distinguish "the graph had nothing" from "the graph had it
and never delivered it" — which is precisely the failure the baseline above
records.

## Honesty conditions

- The subagent is the subject because the author of this document has already
  seen the answers and is a contaminated subject.
- Seeded findings must describe dead-ends that are **not** discoverable from the
  code, comments, or git history in the time budget given. Otherwise the control
  can reach them by ordinary reading and the comparison measures nothing.
- Raw counts are reported alongside the verdict, so the numbers can be checked
  against the bar independently.

---

# Revision 2, after two runs that measured less than they appeared to

Both runs below were carried out. Neither supports the claim as originally
written, and this revision records why and what changed as a result. The bar was
raised, not lowered — which is the only direction a bar may move after seeing the
numbers.

## What the two runs actually produced

**Single-turn, 5 hand-written cases.** Control walked into 2, treatment avoided
both, 0 regressions. Reported at the time as PASS at 100%. Re-graded under the
rules below it is a **FAIL**: the rate rested on 2 admitted cases.

**Multi-turn, 3 real sandboxes with tools.** Every trap was verified to fire
mechanically before the run — the naive guess really does produce MSB1009,
`./build.sh | tail` really does report exit 0 on a failing build, `git fetch
origin master` really does report "0 behind" when origin has 3 commits to local's
1. **Zero of three fired against the subject.** Given tools, the control verified
instead of guessing: it ran `ls`, redirected to a file and echoed `$?`, and used
an explicit refspec that bypassed the clobbered config. Token delta −587 over
114,771, mean −196 with sd 747 — noise, and measuring nothing in any case,
because there was no rework to avoid.

The lesson is not "the graph does not work". It is that **a dead-end only has
value where verification is expensive**, and both corpora were full of dead-ends
one `ls` could settle.

## Two claims, gated separately

They are never blended into one number.

| claim | status | evidence |
|---|---|---|
| **Correctness** — avoids known dead-ends the control walks into | supported, under-powered | 2 of 2 admitted cases rescued, 0 regressions; fails the minimum-N bar |
| **Token savings** | **unproven** | no run has produced a measurable saving; the multi-turn delta was within noise |

The token claim stays open and explicitly unproven. It is not to appear in the
README, the tool descriptions, or a release note until a run supports it.

## The gate (implemented in `tests/fixtures/ab-gate.mjs`)

Graded by code, because both earlier runs were graded by reading answers and
deciding whether they looked right — the same contamination this document warns
about everywhere else, applied to the scoring step.

1. **Admission by control failure.** A case where the control gets the right
   answer measured nothing and is EXCLUDED, and reported as excluded. It is never
   counted as a treatment success.
2. **Minimum 5 admitted cases.** A bar clearable by two lucky cases will
   eventually be cleared by noise.
3. **≥ 80% of admitted cases rescued.**
4. **0 regressions**, looked for across every case including excluded ones — a
   misleading finding does its damage exactly where the subject needed no help.
5. **Tokens are reported, never gated**, over admitted cases where both arms were
   correct. Tokens spent reaching a wrong answer are not comparable to tokens
   spent reaching a right one.

## Four classes of dead-end, measured separately

Averaging these together is what produced a meaningless rate.

| class | what makes it bite |
|---|---|
| `expensive` | the failure only surfaces after costly work — a timeout, a full build, a CI round trip |
| `plausible` | no error at all; the wrong path looks exactly like success |
| `non-inferable` | the fact lives in history or in a person's head, not in the tree |
| `restricted` | fires only when the subject cannot reach the cheap check |

`restricted` is **reported separately and never in the headline**. Handicapping
the control is a demonstration, not a fair comparison.

## Two corpora, kept separate

- `tests/fixtures/ab-injection-harness.mjs` — hand-written. Regression coverage
  for the delivery path. Authored by someone who knew the answers, so it is not
  evidence about behaviour change.
- `tests/fixtures/harvested-dead-ends.mjs` — harvested from failures this project
  actually hit, each recorded with the symptom observed at the time. This is the
  corpus the headline number comes from.

Reported separately, always. An easy case in one must not flatter the other.
