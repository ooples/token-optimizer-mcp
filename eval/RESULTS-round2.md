# Rounds 1–2 — control vs possession, 2 repeats per cell

20 valid trials. Two were voided and re-run: I populated worktree graphs while arm A
trials were still in flight, and the metrics log showed one `inject` event in each of
`libuv-abort` and `registry-422`. Subagents inherit the parent sessionId, so the arm
that received it could not be identified — both controls were discarded and re-run
with every graph moved out of the worktrees.

## Accuracy: no effect whatsoever

**20 of 20 correct, in both arms.** Not one trial in either arm reached a wrong cause,
and none took a documented dead-end. Several controls went further than required: one
reproduced the libuv abort from scratch and cited the upstream fix; one queried live
npm and found the single published version lacking `mcpName`; one measured the V8
argument cliff at 125k/130k directly.

The graph cannot be shown to make the agent more correct on this corpus, because the
agent is already correct without it.

## Cost: a real but modest saving, with one outlier doing the work

| task | class | A tokens | B tokens | Δ | A calls | B calls |
| --- | --- | --- | --- | --- | --- | --- |
| grep-path-file | derivable | 63,298 | 65,068 | **+2.8%** | 13.0 | 11.5 |
| gh-token-suppression | derivable | 65,055 | 53,936 | **−17.1%** | 10.5 | 4.5 |
| libuv-abort | external | 70,459 | 63,530 | **−9.8%** | 18.5 | 13.5 |
| v8-spread | external | 78,061 | 77,241 | **−1.0%** | 19.5 | 21.5 |
| registry-422 | external | 68,526 | 66,766 | **−2.6%** | 14.0 | 11.5 |
| **overall** | | **69,080** | **65,308** | **−5.5%** | | |

By pre-registered class: derivable −7.3% (n=2), external-knowledge −4.4% (n=3). **The
split the experiment was designed around does not appear.** The saving is concentrated
in one task, `gh-token-suppression`, which is in the class predicted to show *least*
benefit — and which is only in that class because the dot-directory bug corrupted its
original classification.

Removing that outlier leaves roughly −1% to −3% across the rest, which two repeats
cannot separate from noise.

## Injection cost, measured directly

Deterministic, no model involved: the tokens the graph spends handing a finding over.

| task | injected | anchored file | injection as % of file |
| --- | --- | --- | --- |
| libuv-abort | 165 tok | 2,038 tok | 8.1% |
| v8-spread | 113 tok | 5,556 tok | 2.0% |
| gh-token-suppression | 120 tok | 2,375 tok | 5.1% |
| registry-422 | 101 tok | 228 tok | 44.3% |

101–165 tokens per injection. Cheap against a large file, expensive against a small
one — `server.json` costs 44% of its own size to annotate.

## What still is not measured

- **Arm C (live retrieval) is unrun.** Arm B is handed the right finding directly.
  That is the upper bound, not the product. Nothing here says the graph would have
  surfaced the correct finding on its own.
- Repeat 3, and the three untouched tasks (`nested-array-type`, `manifest-drift`,
  `pin-vs-latest`).
- Blind scoring. All 20 verdicts were unambiguous — every trial named the documented
  mechanism — so scoring was not the bottleneck, but it has not been done blind.

## Reading

On this corpus the graph does not make the agent smarter, and saves about 5% of
tokens, driven mostly by a single task. That does not support replacing CLAUDE.md,
the memory system, or RAG. It is consistent with a narrower, real claim: **a finding
that lets the agent stop investigating early saves substantially** (10.5 tool calls to
4.5), and one that invites verification does not.
