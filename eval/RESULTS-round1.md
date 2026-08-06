# Round 1 — control vs possession, one repeat per cell

10 trials: 5 tasks × 2 arms. Arm C (live retrieval) and repeats 2–3 not yet run.

## Accuracy: no difference at all

| task | class | A control | B possession |
| --- | --- | --- | --- |
| grep-path-file | derivable | correct | correct |
| libuv-abort | external | correct | correct |
| gh-token-suppression | derivable ¹ | correct | correct |
| registry-422 | external | correct | correct |
| v8-spread | external | correct | correct |

**10 of 10 correct, in both arms.** Every control agent diagnosed the true cause
unaided, including the libuv off-by-one — one of them reproduced the native abort
from scratch, and another queried the live GitHub API and found that 87 of 100 runs
on the release branch were parked in `action_required` with zero jobs.

On this corpus the graph did not make the agent more correct, because the agent was
already correct.

## Cost: mixed, high variance, no reliable saving

| task | A tokens | B tokens | Δ | A calls | B calls |
| --- | --- | --- | --- | --- | --- |
| grep-path-file | 63,726 | 66,209 | **+3.9%** | 15 | 13 |
| libuv-abort | 71,332 | 59,225 | **−17.0%** | 17 | 8 |
| gh-token-suppression | 70,512 | 53,825 | **−23.7%** | 16 | 4 |
| registry-422 | 60,634 | 71,021 | **+17.1%** | 6 | 13 |
| v8-spread | 77,561 | 77,845 | **+0.4%** | 19 | 27 |

Mean −3.9%, range −23.7% to +17.1%. With n=1 per cell that spread is not
distinguishable from noise, which is precisely why 3 repeats were specified.

The two large savings share a shape: the finding let the agent stop investigating
early — 8 tool calls instead of 17, 4 instead of 16. The two costs share the
opposite shape: the agent used the finding as a lead and then went and verified it
against live systems, spending more than it would have unaided.

## ¹ A reclassification, in the direction that hurts the graph

`gh-token-suppression` was registered as external-knowledge on the strength of a
search showing the fact absent from its tree. **That search was wrong.** `GITHUB_TOKEN`
appears in four workflow files there; `smart_grep` returned zero because it silently
skipped `.github/` (fixed in #268).

It is therefore reclassified as *derivable*, which removes the graph's second-best
result from the class that was meant to demonstrate its value. Stated plainly because
the correction runs against the graph, not for it — and because a reclassification
after seeing results is exactly the move that deserves scrutiny.

Remaining external-knowledge tasks: n=3.

## What this does not yet show

- Arm C is unrun, so nothing here says whether **retrieval** surfaces the right
  finding. Arm B hands it over directly; that is the upper bound, not the product.
- One repeat per cell. No claim about rates is supportable yet.
- Five tasks, all from one repository, all diagnostic. Nothing about long
  multi-step work, where a graph would plausibly matter more.

## Honest reading so far

The strong claim — that the graph replaces CLAUDE.md, the memory system and RAG —
is not supported by these ten trials, and the ceiling effect is the reason: a
capable agent with the code in front of it solved every one of these unaided. The
defensible claim is narrower and about **cost**: when a finding lets the agent stop
looking, it saves 17–24%; when it prompts verification instead, it costs up to 17%.
