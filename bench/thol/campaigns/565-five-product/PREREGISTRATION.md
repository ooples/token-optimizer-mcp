# Five-product campaign (#565): pre-registration

Fixed on 2026-11-14, before any paid run. A change to anything below after the
first paid run is a protocol deviation and is reported as one, with its reason.

## Purpose

This is a **development campaign**, not the published board. Its job is to find:

- broken arms;
- token savings we miss;
- places where a competitor is cheaper.

Fixes follow from what it finds. Its losses are published as the "before fixes"
figures. The full THOL board then runs on the fixed build. That board includes a
held-out task set this campaign never touches, so the board tests whether the
fixes generalise and not only that they fit these tasks.

## Arms (8)

Every competitor version was checked against its registry on 2026-11-14 and is
the latest published.

| arm | product | configuration |
| --- | --- | --- |
| `control` | Claude Code 2.1.325, no optimizer | THOL's control |
| `token-optimizer-mcp` | ours, 7.11.0 (the packaged tree) | default posture, MCP server and hooks |
| `headroom-cache` | Headroom 0.44.0 | `headroom wrap claude`, default mode (cache), retrieve MCP declared |
| `headroom-token` | Headroom 0.44.0 | as above, `HEADROOM_MODE=token` (compression-first) |
| `tokenade-product` | Tokenade 2.0.9 | vendor installer, `tokenade install --only claude-code --yes` |
| `tokenjuice` | tokenjuice 0.11.0 | vendor installer, `tokenjuice install claude-code` |
| `cto` | claude-token-optimizer 2.3.20, as shipped | `cto init --yes --hooks`, plus its printed settings block |
| `cto-patched` | the same, with 3 hooks patched to read `tool_name` from stdin | reported beside `cto` |

The rationale for each configuration is in that arm's
`bench/thol/manifests/<arm>/manifest.json`.

Model: `claude-sonnet-4-6`, THOL's default. Campaign label:
`2.1.325 (Claude Code)`.

### Arm checks done before spend (zero cost, mock API)

Every arm was run through the real `runner.py run` path against a scripted local
mock of the Messages API. The script was one Bash call, then a 42 KB Read, then
an answer. In every arm the task prompt reached the model, and each product's
effect was visible:

| arm | effect seen by the mock |
| --- | --- |
| tokenjuice | compacted the Bash output, 2713 to 817 chars |
| Tokenade | compacted the Bash output, 2713 to 1075 chars |
| ours | outlined the Read, 47193 to 1501 chars |
| Headroom | proxied the request; its retrieve tool was present |
| cto-patched | its guards blocked a 92 KB Read and `find /` (exit 2), where the shipped hooks exited 0 |

**Defect found and fixed by this check.** THOL's own `headroom` entry passes
`-p ${PORT}` to `headroom wrap claude`. On 0.44.0 that is not a port flag, so
Claude Code received the port number as its prompt. The agent never saw the task.
The `headroom-*` arms here use `--port`.

## Tasks

All 17 tasks are THOL's own battery (pinned rev `5ee6ea7f`). We wrote none of
them.

- **Development set (this campaign), 12 tasks:**
  - code-bugfix-py, code-comprehension-django, code-debug-pipeline-py,
    code-feature-validate-py
  - code-iterate-tests, code-migration-py, code-migration-py-xl,
    code-overview-cobra
  - code-refactor-split-py, code-settings-inventory-django, log-needle-zh,
    seo-audit
- **Held-out set (full board only), 5 tasks:**
  - code-debug-cascade-py, code-debug-ledger-py, code-feature-js, report-pdf;
  - web-research-oss-inventory (held out for cost: about $5 per run).

  The four drawn tasks were not chosen. They are the four lowest
  `sha256("thol-holdout-2026-11-14:" + task)` among the 15 tasks left after
  excluding the bias control and web-research. Their transcripts, scores and
  costs are not opened until the full board.
- **Bias control: code-bugfix-py.** It is THOL's shortest task (control: $0.092,
  18 s). A short task is dominated by fixed overhead: our SessionStart context
  and MCP instructions are paid in full while there is almost nothing to
  compress. It is chosen because it disfavours our design, and that reason was
  fixed before any result existed.

## Design

- n = 3 repetitions × 12 tasks × 8 arms = **288 runs**, serial.
- Arm order per repetition is rotated and committed in `arm-order.json`
  (sha256 `883c60c5…` as generated). The entrypoint refuses a changed order for
  the same campaign label.
- Segments are cheapest first, with credentials re-staged between segments:
  - `SEG_1` code-bugfix-py, code-refactor-split-py, log-needle-zh,
    code-iterate-tests
  - `SEG_2` code-migration-py-xl, code-migration-py, code-feature-validate-py,
    seo-audit
  - `SEG_3` code-overview-cobra, code-settings-inventory-django,
    code-comprehension-django, code-debug-pipeline-py

## Endpoints

- **Primary: cost.** For each arm, the per-task mean `total_cost_usd` divided by
  control's on the same task. These ratios are summarised as mean and median,
  with a 95% bootstrap CI over tasks (`bench/thol/analyse-campaign.py`, seed
  20260913). "Cheaper" is claimed only when the CI excludes 1.0. The count of
  tasks on which the arm is cheaper is reported alongside.
- **Quality guard: score.** Paired score ratio and the per-task score. An arm
  whose mean score is lower on a task is reported as a quality loss on that task,
  whatever its cost.
- **Secondary:** turns, wall time, input/output/cache tokens, setup time.
- **Failures:** every non-`ok` run is reported by arm, task and error. The ratios
  above use `ok` runs only, so the failure table is part of the result and not an
  appendix.

## What happens with the results

1. Publish every arm's per-task table, including every loss and failed run, as
   "before fixes".
2. Read the transcripts of the development tasks, and only those, for:
   - broken arms;
   - savings a competitor achieves that we do not (already seen on the mock:
     tokenjuice and Tokenade compact small noisy Bash output that our bound
     leaves alone, by design, below 30 KB);
   - places where a competitor is cheaper.
3. Fix them, each with its own evidence.
4. Run the full board, all THOL competitors and all 17 tasks, on the fixed
   build. The held-out tasks are its generalisation test.

## Spend estimate

These are THOL's published control means for Sonnet 4.6 on CC 2.1.206 (n=10 per
task). The development set costs **$2.74** per control pass. In THOL's
2.1.206 results, Headroom averaged 2.76× control, so both Headroom arms are
priced at that. The other arms are priced at control's cost.

| | per repetition | 3 repetitions |
| --- | --- | --- |
| control-equivalents | 6 × 1.0 + 2 × 2.76 = 11.5 | |
| cost | about $32 | **about $95** |
| wall time, serial | about 2.4 h | **about 7 h** |

The rig authenticates with the host's Claude Code login, as the user approved
for this rig only. So the dollar figure is what the API would charge; on a
subscription it is drawn from usage limits rather than billed.
