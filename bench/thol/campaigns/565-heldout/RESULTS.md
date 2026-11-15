# #565 held-out check: results

The pre-registered design ran as written (`PREREGISTRATION.md`, ac3ae488): 4
held-out tasks × 8 arms × 3 repetitions. **96/96 runs ok, $28.05.** Our arm ran
the packed tree `152076f2` (head 534ce0f4), which carries the smart_grep and
disclose fixes.

## Failures

The run used one segment, so credentials were staged only once. The OAuth session
expired after run 61, and the next 5 runs failed on their first turn with
`OAuth session expired and could not be refreshed`, after which the rig aborted. They were:

- report-pdf r2: cto, cto-patched, control;
- code-debug-cascade-py r3: headroom-cache, headroom-token.

They cost $0 and all five re-ran ok on resume. The resume used one segment per
task, so credentials were re-staged at each task boundary. Rig instructions for
any later campaign: never run a multi-hour list as one segment.

## Cost relative to control, paired by task (4 tasks)

| arm | `total_cost_usd` mean | 95% CI | `cold_start_cost_usd` mean | 95% CI |
| --- | ---: | --- | ---: | --- |
| **ours** | **0.843** | [0.643, 1.029] | **0.839** | **[0.687, 0.970]** |
| tokenjuice | 0.948 | [0.650, 1.160] | 0.955 | [0.717, 1.124] |
| tokenade | 0.950 | [0.696, 1.125] | 0.956 | [0.753, 1.097] |
| headroom-token | 1.010 | [0.773, 1.211] | 0.955 | [0.777, 1.111] |
| headroom-cache | 1.021 | [0.937, 1.132] | 0.945 | [0.892, 0.994] |
| cto | 1.205 | [0.775, 1.820] | 1.168 | [0.819, 1.669] |
| cto-patched | 1.376 | [0.971, 1.781] | 1.301 | [0.977, 1.624] |

On the primary endpoint our CI spans 1.0, as the pre-registration expected with
4 tasks, so "cheaper" is not claimed there. On the secondary endpoint it
excludes 1.0. Turns: ours 0.847× control, CI [0.707, 0.987].

**Quality:** every arm's score equals control's on every task. report-pdf
scored 0.90 for all 8 arms (n=3 each), so the 0.1 shortfall belongs to the
task, not to any arm.

## Per task (mean of 3 repetitions, ratio to control)

| task | control $ | ours | tokenjuice | tokenade | headroom-cache | headroom-token | cto | cto-patched |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| code-debug-cascade-py | 0.351 | 1.09 | 1.00 | 0.98 | 1.18 | 1.08 | 2.10 | 1.89 |
| code-debug-ledger-py | 0.324 | 0.57 | **0.51** | 0.57 | 0.98 | 0.67 | 0.68 | 0.94 |
| code-feature-js | 0.150 | **0.86** | 1.07 | 1.07 | 0.91 | 1.01 | 0.97 | 1.00 |
| report-pdf | 0.283 | **0.86** | 1.21 | 1.17 | 1.01 | 1.28 | 1.07 | 1.67 |

## Reading

Per the pre-registration: our arm came in under control with no quality loss.
So the #565 fixes did not overfit the development set. That does not show the
fixes helped. Neither smart_grep's large-result path nor the disclose envelope
path fired on these tasks.

**The one loss is variance, not a mechanism.** We lost on code-debug-cascade-py
(1.09×), and the whole gap is one repetition:

- Reps 1 and 2 cost $0.318 and $0.357, against control's $0.331–0.367.
- Rep 3 took 32 turns and cost $0.469.

Our arm called no MCP tool on this task, and its tool results are the same size
as control's (24.8k against 24.2k characters a run). Rep 3's transcript has no
hook refusal, rewrite or compacted result. The model took a longer route: 31
calls, against 22 in rep 1, re-reading `fx.py` and `interest.py`. No product
change is indicated.

The held-out transcripts were opened only after every run above was recorded.
They are now development data, so a later confirmation needs a fresh untouched
set. web-research-oss-inventory is the remaining unopened held-out task.
