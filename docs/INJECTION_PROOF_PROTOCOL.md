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
