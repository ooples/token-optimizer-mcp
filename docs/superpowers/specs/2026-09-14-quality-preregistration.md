# Pre-registration: does history substitution cost the model anything?

Written before any measurement, and committed so it cannot be edited after
seeing a result. Every cost question about `v4-substitute` has been settled
offline; this is the only one left, and it is the one that decides shipping.

## The question, stated narrowly

Not "is the output good". **Does removing model reasoning from history change
what the model does next?**

That is narrower on purpose. A broad quality question needs whole-task outcomes
and is therefore expensive, slow, and — as this project has already learned —
easy to run in a form that cannot answer it. The narrow question is directly
about the risk the design actually carries: that the substitute fails to carry
state the model needed, so it repeats work, re-reads a file, or contradicts a
conclusion it already reached.

## Why not go straight to the benchmark

Because we did, and it did not work. The record, all measured:

| what happened | consequence |
| --- | --- |
| Tool deferral shipped off by default | the ledger recorded it active on 0 of 351 requests; months of campaigns measured nothing |
| The knowledge arm ran against an empty graph | byte-for-byte the plain proxy arm, reported as a null |
| `TOKEN_OPTIMIZER_PROXY_KNOWLEDGE_CHARS` was forwarded by neither script | a four-arm sweep would have run four identical arms |
| `v4Substitute` was named nowhere in the proxy | registered, tested, benchmarked, unreachable |
| A benchmark arm called the primitive instead of the strategy | measured half the feature and reported the other half as worthless |
| The campaign ran n=1 with cache_read ratios spanning 0.47–2.38 | variance several times the ~11% effect it was looking for |
| THOL tasks run 8–26 turns; this feature's value scales with length | measured in the regime where it is worth least |

Six of those seven produce **a null that looks like a result**. The instrument
below is designed so that failure mode is impossible to reach silently.

## Instrument A — the next-action probe (runs first)

`bench/compression/next-action-probe.mjs`.

For each sampled turn of a real conversation:

1. Build the **control** prefix (what the client would send) and the
   **substituted** prefix (what the proxy would send).
2. Sample the next assistant turn from each at **temperature 0**.
3. Sample the control prefix a **second** time, also at temperature 0.
4. Classify each reply into an action: tool name, target (file path or command),
   and whether it is a terminal answer.

**Three calls per sampled turn, not two.** The third is the control-vs-control
pair and it is not optional: it establishes the floor. Without it a divergence
number cannot be read at all.

### What counts as a divergence

Actions are compared **semantically, never textually**: same tool, same target,
same terminal/non-terminal disposition. Rewording is not divergence. This is
stated in advance because "compare the replies" would otherwise be decided after
seeing how they differ.

### Why temperature 0

At production temperature a changed prefix produces a different sample **even
when no information was lost** — different bytes, different sampling path. Under
the strict decision rule that alone would show substitution as degrading quality
regardless of whether it does. Temperature 0 collapses the control-vs-control
floor toward zero so remaining divergence is attributable to content.

This buys interpretability at the cost of measuring a mode the product does not
run in, so it is followed by a **production-temperature spot check** — a smaller
sample, not a second verdict, run only to confirm nothing appears that
temperature 0 concealed.

### Decision rule, fixed now

**Substitution fails if its divergence rate exceeds the control-vs-control floor
by a statistically significant margin (two-proportion test, α = 0.05).**

No threshold negotiation after the fact. If it fails, `v4-substitute` does not
ship and the digest design is reconsidered.

### Sample size

Powered at 80% for a two-proportion difference:

| effect to detect | paired samples |
| --- | --- |
| 10 percentage points | ~250 turns |
| 5 percentage points | ~900 turns |

Sampled turns are drawn across the conversation-length range **including 100+
turns**, declared here rather than chosen later, because the amount of reasoning
removed grows with length and so does any risk from removing it.

### Cost gate

A **10-turn dry run reports the exact per-sample cost before any real spend.**
No campaign, probe or sweep in this project proceeds on an estimated price
again.

## Instrument B — the THOL campaign (fires only if A is clean)

Built now, held. Specified here so it cannot be designed around a result.

- **Arms**: `control`, `token-optimizer-proxy`, `token-optimizer-proxy+substitute`.
- **Randomised arm order.** THOL runs control → mcp → proxy in fixed order,
  which is a systematic confound.
- **Reps derived from measured variance**, not chosen. The last campaign's
  cache_read ratios spanned 0.47–2.38 at n=1; the rep count comes from that
  spread and the effect size sought, computed before the run.
- **Stratified by session length**, reported separately for short (<13 turns)
  and long (>=13) tasks. Pooling them averages a regime where the feature cannot
  work with one where it should.
- **Score is the gate.** Any cost win with a score regression is a loss.

## Guardrails, each tied to a failure above

1. **Fired-check.** Before any result is read, assert from the ledger that the
   transform ran on every request it should have. A run where it did not fire is
   discarded, not interpreted.
2. **Power stated before spend.** The detectable effect size is declared, or the
   run does not happen.
3. **Regime declared up front.** Which conversation lengths are sampled, fixed
   here.
4. **Shipped entry points only.** Every arm calls the exported function the
   product calls — never a primitive, never a reimplementation.
5. **Verifier integrity.** Confirm a score measures the task and not a hook
   artifact; `report-pdf` once scored 0.30 against control's 0.90 with the PDF
   built correctly every time.

## What would invalidate this design

- **Agreement is not correctness.** Both arms can take the same wrong action.
  The probe detects *change*, not quality in the absolute; only Instrument B
  speaks to task outcome.
- **Temperature 0 is not production.** The spot check bounds this gap; it does
  not close it.
- **Transcripts store `thinking: ""`.** The probe's substituted prefix therefore
  removes signatures and whatever text the live client would have carried, so
  the amount removed is a lower bound on production — and so, plausibly, is any
  quality effect.
- **A near-zero floor is an assumption until measured.** If control-vs-control
  divergence at temperature 0 turns out to be large, the instrument is not
  sensitive enough and the strict rule cannot be applied; that result stops the
  probe rather than being worked around.
