# Pre-registration: the twelve-workload, three-column head-to-head

Written and committed **before** the harness that produces its numbers is run,
so the analysis cannot be chosen after the result is in. Nothing here is a
result. Every threshold below is a commitment made while the outcome is unknown.

Governs: `bench/compression/proof.mjs`, `bench/compression/head-to-head.mjs`,
and `bench/compression/headroom/run-theirs.py` when extended to carry our own
fixtures. Supersedes nothing; the four-workload table it replaces was correct
for the comparators it had.

## Why this campaign exists

The published table carries four rows because four workloads had a comparator.
The harness runs twelve. The other eight were never a head-to-head, so the
tally "ours on 3, theirs on 1" is a statement about four fixtures and has been
read as a statement about the product. This campaign gives all twelve a
comparator and publishes whatever comes back.

## Arms

Exactly three, on identical bytes, scored on identical denominators.

| arm | what it is | why it is here |
| --- | --- | --- |
| `ours` | this repository's compressor at the committed SHA | the product |
| `theirs-binary` | installed HeadRoom wheel, version pinned and recorded | what they actually ship |
| `theirs-design` | this repository's reimplementation of their published design | the existing comparator, kept so the reimplementation can be audited against the real thing |

`theirs-design` is retained deliberately. If it and `theirs-binary` disagree by
more than 5 percentage points of reduction on any workload, the reimplementation
is wrong and every number it has ever produced -- including the currently
published four-row table -- is reported as suspect in the same commit that finds
it.

## Fairness rules, inherited and binding

1. **Their best configuration wins.** Their side runs every entry point their
   own benchmarks use (`router`, `crusher`, `pipeline`) and the budget is swept
   from generous to punishing; the best result per workload is theirs. A budget
   we chose must never be the thing that beats them.
2. **Same bytes.** Both arms compress the identical payload, dumped once.
3. **Symmetric configuration.** Their router takes a `question`, ours a `query`.
   Both get it, from the same place.
4. **Both denominators, actually different.** Characters, and tokens from
   `cl100k_base` run over both arms' real output -- never chars/4, which makes
   the second column a rescaling of the first.
5. **Their estimator for their fixtures.** Where their published figure is the
   comparator, their token counter defines the denominator.

## Metrics, fixed now

Three columns, published together for every workload. A reduction figure
without its retention figures beside it is not a result.

- **`reduction`** -- 1 minus (output / input), reported in characters and in
  cl100k tokens.
- **`visible-retention`** -- retention units from the input that survive **in
  the bytes actually sent to the model**, with no fetch, no store and no second
  call. This is the column the README currently reports as 345 for us against
  1,890 for them.
- **`recoverable-retention`** -- `visible-retention` plus units recoverable from
  a named spill or marker, **subject to the durability precondition below**.
### The durability precondition, applied to both sides

`bench/competitive/results/claims.json` records that a HeadRoom CCR marker
resolves 1 of 1 while its store is warm and **0 of 1 once the store is cleared**,
with 90 rows in and 12 visible. We publish that as a defect. Our own compressor
elides into a spill roughly 0.94x the size of the input and asks to have it
counted as retained.

Those two mechanisms are the same shape, so they get the same test:

> A unit counts toward `recoverable-retention` only if it is still recoverable
> **after the producing process has exited and any in-memory store is gone** --
> recovered from committed bytes on disk by a fresh process, given only the
> marker text that appears in the output.

This is run against both arms by the same procedure. Consequences accepted in
advance:

- If our spill fails it, our `recoverable-retention` collapses to
  `visible-retention` and we publish a 345-against-1,890 column as a loss, and
  the "recoverable" language is removed from the README.
- If their markers pass it, the defect recorded in `claims.json` is narrowed to
  the warm/cold distinction it actually proves, in the same commit.
- If both fail, both columns report visible-only and the harness says so.

## What counts as a win, declared before the run

Per workload, `ours` wins that workload only by taking **both** `reduction` and
`recoverable-retention` against `theirs-binary`. Winning reduction while losing
retention is recorded as **split**, never as a win. The published tally counts
wins, splits and losses separately.

The campaign goal is 12 wins of 12. Any other outcome is published as measured,
in the same table, with no workload omitted and no comparator dropped.

## Known asymmetries, stated up front

- **The fixtures are ours.** All twelve were authored in this repository. A
  sweep on fixtures we wrote is weaker evidence than a worse result on THOL's
  independent tasks, and the published table must say so in that many words.
- **Their wheel is compiled; our arm is source.** Version, wheel hash and probe
  hash are recorded per run, as `claims.json` already does.
- **Their fixtures exercise their strengths.** Their four published workloads
  stay in the table unchanged so the new eight cannot quietly replace them.

## What voids this campaign

- Any metric defined, renamed or reweighted after a number is seen.
- A workload dropped from the published table for any reason other than a
  recorded harness failure affecting both arms equally.
- `theirs-binary` run at a version other than the one recorded in the output.
- Our side rebuilt between the two arms of a single run.
- A budget or configuration chosen for their side that their own benchmarks do
  not use.

## Recorded before the first run

- HeadRoom version: `0.37.0`
- Our tree: recorded per run as the committed SHA; no run is published from a
  dirty tree.

---

# Extension, committed 2026-09-25: the instruments, not just the arms

Everything above commits to how the two arms are *configured*. It says nothing
about the code that turns their output into a number, and that code is where
every retraction in this project has come from: the retracted `like4like`
figures, the retracted store-drift cause, the retracted 31% break-even, the
retracted recoverability edge. In each case the arms were fair and the
instrument was wrong.

So this extension pre-registers the instruments. Written before the three-pass
capture that will re-score every published figure has been read -- the capture
is regenerated *because* these commitments invalidate the one that exists.

## Two layers, tested separately, and why one test cannot cover both

- **Layer 1, the capture.** `headroom/run-theirs.py` and the payload export:
  what bytes each arm was given and what it returned. Its known-answer test is
  `known-answer/capture.check.mjs`, driven by stub arms whose right answer is
  arithmetic (`known-answer/arms.py`, `ours-identity.mjs`, `ours-lossy.mjs`,
  `ours-mirror.mjs`).
- **Layer 2, the scorer.** `head-to-head.mjs` and every instrument it calls:
  the tokeniser, `identifiers.mjs`, `retention.mjs`, `cost-model.mjs`,
  `speed-verdict.mjs`, `reproducibility.mjs`. Its known-answer test is
  `known-answer/scorer.check.mjs`.

A green layer-1 test says the capture recorded what happened. It cannot say the
scorer read it correctly, and for most of this project's history only layer 1
was tested. Both are required before a number is published.

## The commitment that makes those tests worth anything

A check is only evidence if it *refuses* something. The battery is therefore
mutation-tested: `known-answer/mutants.mjs` applies a known defect to an
instrument and requires the corresponding check to fail.

Fixed now, before the re-score:

1. **The score is published with the number, every time**, as caught/total.
2. **A survivor is closed by ADDING an assertion**, never by deleting the
   mutant, narrowing its blast radius, or relaxing the check it defeated. If a
   survivor cannot be closed, it stays in the table as a survivor and the claim
   it undermines is published as unverified.
3. **A mutant whose anchor no longer matches exactly once is reported STALE and
   counts as a failure**, because a mutant that applies nothing is
   indistinguishable from a mutant that was caught.
4. **Every instrument that decides a published number carries mutants.** An
   instrument with none is treated as untested regardless of how many assertions
   its own check file contains.

## The speed criterion, fixed before the capture that tests it

`speed-verdict.mjs`, and it is the same operation on both columns:

- Within a pass: our **p90** against their **p10**. Our slow readings against
  their fast ones -- the same distance from each median, in opposite directions.
- Across passes: the **median** of those per-pass values, on both sides.
- The bar is `ourSlow <= theirFast`. No jitter allowance, no tuned constant.
- **Minimum two passes per side.** Fewer on either side returns `null`.
- Three states, and `null` is a claim about the measurement, not about the code.
  The gate must never round it to a pass. Twelve speed criteria currently read
  `unverified` for exactly this reason, and they stay that way until a capture
  with three passes on *their* side exists.

Neither of the two wrong reductions is permitted, and they fail in opposite
directions: one pass on their side lets interference inflate their p10 and widen
the gap in our favour; a single p10 over the pooled readings of three passes
measures us against their best burst. Per-pass first, then median, is the only
reduction identical on both columns.

## Re-runnability is a precondition of publication, not a nicety

`reproducibility.mjs` refuses a record that cannot be re-run, and
`must-win.check.mjs` fails on that refusal. A record must carry, all of them
present and usable:

`commit` (40 hex), `node`, `tiktoken`, `encoding`, `payloadsDigest`,
`theirsDigest`, `headroomVersion`, `python`, plus `dirty: false` and a per-side
speed pass count of at least two.

Two commitments about this gate specifically, because a gate is easy to fake:

- **A field that is present but unusable is a refusal**, not a pass: `'unknown'`
  from a failed git call, an empty digest, a truncated sha, a version that is a
  number rather than a string. A published record whose provenance reads
  `unknown` is worse than one with no provenance, because it looks checked.
- **The required set is written out by hand in the check**, independently of the
  table it tests. A loop over the table's own keys cannot notice a field deleted
  *from* the table, and that is precisely the regression worth catching.

## The subscription claim, and what will and will not be published as proof

The claim that matters to a user is *how much of a weekly subscription
allowance is saved*. It is not a compression ratio, and the following is fixed
in advance so it cannot be softened later.

1. **The unit is an effective input token**, from `cost-model.mjs` `RATES`:
   input 1x, 5m cache write 1.25x, 1h cache write 2.0x, cache read 0.1x,
   output 5x. A saving quoted in raw characters or in undifferentiated
   "tokens" is not a subscription saving and is not published as one.
2. **Base context is measured, never assumed.** The shipped default is `null`
   so that an unmeasured run cannot silently inherit a flattering constant; the
   measured value comes from `bench/subscription/base-context.mjs` over real
   first requests, with a minimum session count. Understating the base inflates
   every percentage that follows, which is how the 12,000-against-65,063 error
   happened.
3. **The meter is evidence only as a delta over at least two readings** of the
   same `seven_day` window, and the cap it implies is published **as a bracket,
   not a point estimate** -- the observed levels do not agree, and a single
   reading cannot separate the cap from the fixed offset in the signature.
4. **The arithmetic carries known-answer tests**: `cost-split.check.mjs`,
   `base-context.check.mjs`, `calibrate.check.mjs`, each in `bench:instruments`
   and each mutation-covered under the rules above.
5. **No quota is spent to produce it.** Meter reads are GETs; every other input
   is a local transcript. No credential is ever written to an observations file.

## What voids this extension

- A published number produced by an instrument whose mutants were last run
  before its most recent change.
- A survivor closed by weakening the check that failed to catch it, or by
  deleting or narrowing the mutant.
- A `null` speed verdict counted as anything but unverified.
- A record published while `reproducibility.mjs` refuses it, or with that gate
  removed from `must-win.check.mjs` rather than satisfied.
- A subscription saving quoted without the base-context measurement it rests on,
  or with a cap presented as a point estimate.
- A capture re-scored after its numbers were read, with the criterion changed in
  between. The criteria above were fixed while twelve speed rows read
  `unverified` and the record read `NOT RE-RUNNABLE`; that is the state they
  were chosen in.
