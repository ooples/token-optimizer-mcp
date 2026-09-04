# A converging adversarial task, on the third attempt

Governed by Addendum 3 of [PREREGISTRATION.md](./PREREGISTRATION.md), committed
**before** this run at `a1421eb`. Raw rows: `retitle-confirm.jsonl` (180 rows, no
duplicates, one build -- image `sha256:abfce039` at commit `a1421eb3`). Fixed
n = 60 per arm, no early stopping, **100% completion, every run scoring 1.000**.
Spend: $15.92.

## The result

**`assist` vs `ours-rules` on `whole-file-retitle` = 1.010 [0.944, 1.081]**

The interval spans parity and is **±6.8% wide**. That is Addendum 3's outcome 1,
named in advance as the intended one: interception is measured, with precision,
and shown not to help on a task where it cannot help.

| | old task | this task |
| --- | --- | --- |
| ratio | 1.149 | 1.010 |
| interval | [0.962, 1.395] | [0.944, 1.081] |
| width | ±21% -- UNRESOLVED in three campaigns | **±6.8% -- resolved** |

Against control, for context: `ours-rules` 0.660 [0.618, 0.704], `assist` 0.667
[0.622, 0.715]. Both arms beat vanilla by about a third here; the point of the
task is that they do not beat *each other*.

**The harness's `NO ADVERSARIAL TASKS RESOLVED` warning no longer prints.** That
warning has stood over every aggregate this project has published.

## What the two failures taught, and what fixed it

- **`whole-file-transform`** -- right direction, unusable precision. It asked for
  one uniform replacement across 120 functions, which the agent could satisfy
  with 120 targeted edits, one find/replace, or a whole-file rewrite. Those cost
  wildly different amounts, and the spread was not sampling noise: more reps
  never narrowed it.
- **`generation-amid-bulk`** -- right precision, wrong direction. Built as a bias
  control, it turned out to be a task we win, because reachable bulk is exactly
  what read-substitution feeds on. See [RESULTS-ADVERSARIAL.md](./RESULTS-ADVERSARIAL.md).

`whole-file-retitle` requires each message to carry its own function's name, so
no single find/replace expresses the answer and the dominant cost -- emitting 120
unique strings -- is the same on every route. Verified by scoring the strategies
rather than arguing about them: the old uniform find/replace now scores **0.5**,
the declared golden scores **1.000**, and an unsolved workspace scores 0.25.

## What this does NOT do

**It does not retroactively clear the warning on results already published.**
`competitors-v1.jsonl` and the large-context campaigns ran with
`whole-file-transform`, which never resolved. Every figure in
[RESULTS-COMPETITORS.md](./RESULTS-COMPETITORS.md) and
[RESULTS-LARGECONTEXT.md](./RESULTS-LARGECONTEXT.md) still carries its
bias-control caveat, and re-running the full battery -- 7 arms across 4 tasks --
is what would change that. Nothing here licenses quoting those numbers as
bias-controlled.

**It is one task, not a guarantee.** A single resolved adversarial task means the
battery is no longer composed only of ground we chose. It does not prove the
battery is unbiased.

## The prediction that was wrong, recorded

The 12-rep pilot put this ratio at **0.977 [0.816, 1.170]** -- below parity -- and
the mean crossed parity between rep 8 ($0.0827) and rep 12 ($0.0763). Addendum 3
listed "excludes parity below 1" as a real possibility that would have made this
a third failure. At n=60 the answer is 1.010, above the pilot's point estimate
and squarely on parity. The pilot was right about precision and uninformative
about direction, which is exactly what its interval said.
