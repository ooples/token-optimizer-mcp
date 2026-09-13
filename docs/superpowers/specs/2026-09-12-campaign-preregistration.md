# Pre-registration: the compression campaign

**Status: DRAFT, awaiting approval. No API spend until this is signed off.**

Written before the runs, so the analysis cannot be chosen after seeing the data.
Everything below is a commitment: if a result comes out the wrong way, the
answer is to report it, not to re-slice it.

## Why this exists

Two experiments have already been run with different designs, and the difference
is what made them impossible to reconcile:

| | fixture head-to-head | THOL campaign |
| --- | --- | --- |
| question | given these bytes, how much is removed | what does the product cost end to end |
| competitor arm | yes (HeadRoom, 5 configs) | **none** |
| result | ours 91.9% vs theirs 52.4% | our proxy costs ~30% more than control |

The campaign had no competitor, so "our proxy costs 30% more" had nothing to
compare against and could not distinguish *our proxy is badly built* from *a wire
proxy costs about this much for anybody*. Those point at completely different
work. That gap is the reason for this document.

## Questions, each with a pre-committed decision rule

**Q1. Does a wire proxy cost extra regardless of whose it is?**
Answered by REPLICATION across independent proxies rather than by a custom null
arm. THOL ships several proxy-shaped competitors: `headroom` (Compress-Cache-
Retrieve proxy), `rtk` (CLI proxy invoked from a PreToolUse hook) and `edgee`
(Rust LLM gateway). Each is a different team's implementation of "put something
on the wire".
- If EVERY proxy arm costs materially more than `control`, the hop is inherently
  expensive and our ~30% is largely not ours to fix.
- If ours is the only one that does, it is our defect.
- This is stronger than the `headroom-null` arm I first designed, because a
  passthrough measures one vendor's transport while three independent proxies
  measure the shape of the thing.

**Q2. Is our proxy better or worse than theirs, end to end?**
Compare `token-optimizer-proxy` against `headroom` on cost, turns and score.
- Winning requires being better on cost AND not worse on score. Fewer turns is
  reported but does not by itself count as a win, because the enforce arm already
  proved turns and cost can move in opposite directions.

**Q3. Does either compressor actually fire on this traffic?**
Read both proxies' own logs and report the fraction of requests each compressed.
- Pre-committed expectation, recorded so it can be wrong: ours fired on 2 of 371
  requests last time, and I expect theirs to fire rarely too. If theirs fires
  often and ours does not, that is a real defect in our triggering.

**Q4. Does our MCP `wiki_write` fix work?**
`report-pdf` scored 0.3 on 3/3 reps because the agent's final message was a
memory-write confirmation. The guidance now forbids that ordering.
- Fix confirmed only if `token-optimizer-mcp` scores >= 0.9 on `report-pdf`.
- Anything less means the trailing `wiki_write` was a symptom, not the cause, and
  the recorded finding must be corrected.

## Arms (5)

Every competitor arm is THOL's OWN verified manifest, not one I wrote. This
matters: I spent a tick building `headroom` and `headroom-null` manifests, a
Dockerfile install step and a proxy starter in entrypoint.sh, all of which
already existed. THOL registers 46 competitors, 13 verified with pinned
versions, and its own Dockerfile comment says so. The custom work is reverted.

| arm | what it is |
| --- | --- |
| `control` | THOL's own: no optimizer, same model and prompts |
| `token-optimizer-assist` | ours, hooks only -- separates hooks from proxy |
| `token-optimizer-proxy` | ours, hooks + our compression proxy |
| `headroom` | theirs, v0.27.0, official `headroom wrap claude` auto mode |
| `rtk` | a second independent proxy, v0.42.3, for the Q1 replication |

`headroom`'s manifest is `verified: true` with the note "install validated by the
2.1.183 campaign (every run's setup completed rc=0; 120+ ok runs)", so the
competitor-misconfiguration risk that has bitten this project three times is
carried by THOL's validation rather than by my guess at their CLI.

`token-optimizer-mcp` is added ONLY for Q4, on `report-pdf` alone, because it is
already known to be worse on every axis and full coverage would buy nothing.

## Tasks and reps

- **Fixed task list**, the same 16 for every arm. No arm may be scored on a
  subset. The last campaign compared a 17-run arm against a 48-run arm and the
  cheap tasks were over-represented in the smaller one, which made `assist` look
  9% cheaper when the per-task paired figure was ~3%.
- **3 reps per (arm, task)**, and a cell with fewer than 3 completed reps is
  **excluded from every arm** rather than averaged as-is.
- 5 arms x 16 tasks x 3 reps = **240 runs**.

## Arm order — the confound being fixed

THOL currently runs arms in fixed order within each (task, rep): control, then
mcp, then proxy, 60-170s apart. Every treatment run therefore systematically
follows a control run, and this project has already retracted a result for
exactly this class of error ("arms alternated, treatment ran second, inheriting
the control's cache").

**Mechanism, now verified rather than assumed.** `runner.py` builds its plan as

    plan = [(c, t, rep) for rep in range(1, reps+1) for t in task_names for c in comp_names]

so competitors are the INNERMOST loop and their order is exactly the order given
to `-c`. There is no shuffle flag and no seed. `runner.py` cannot be patched:
THOL is pinned by `THOL_REV` precisely so results stay comparable across
campaigns, and editing it would silently start an incomparable campaign.

So the design is COUNTERBALANCING, not randomisation: one campaign invocation
per rep, each passing a different `-c` order, recorded here in advance.

| rep | `-c` order |
| --- | --- |
| 1 | control, assist, proxy, headroom, rtk |
| 2 | rtk, headroom, proxy, assist, control |
| 3 | proxy, control, rtk, assist, headroom |

No arm is systematically last, which is the specific bias that invalidated an
earlier result here. This is weaker than per-cell randomisation -- three orders
out of 120 possible -- and that limitation is stated rather than hidden. If a
cache-order effect survives counterbalancing it will show up as rep-to-rep
spread, which the per-task ranges will expose.

## Metrics and denominators

| metric | denominator, named |
| --- | --- |
| cost | USD per run, as the provider reports it |
| turns | `num_turns` per run |
| score | the task's own verifier, 0..1 |
| cache split | `cache_creation_tokens` and `cache_read_tokens`, reported separately, never summed |
| fire rate | compressed requests / total requests, from each proxy's own log |

## Statistics

- **Per-task paired ratios**, never a run-weighted mean across arms. Report the
  mean ratio, the median ratio, and the range.
- **Bootstrap 95% CI** over tasks for every headline ratio. A ratio whose CI
  spans 1.0 is reported as "no detectable difference", not as a direction.
- Report **n per cell**. Any comparison with a cell below 3 reps is labelled
  underpowered in the same sentence as its number.

## Estimated cost

240 runs at roughly $0.21 mean = **~$50**, plus ~$3 for the Q4 `report-pdf`
cells. The previous campaign's 144 runs cost about $11 on the cheaper task mix,
so this is an estimate with real uncertainty, not a quote.

## What would invalidate the whole thing

- THOL's `headroom` pin (0.27.0, verified 2026-06-26) has drifted from what the
  package does today, so a verified-then arm is misconfigured now. Checked by
  reading its setup rc and fire rate in the first segment, not assumed.
- Host memory exhaustion killing runs mid-campaign, as it did twice today.
