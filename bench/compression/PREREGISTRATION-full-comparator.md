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