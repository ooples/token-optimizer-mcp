# Head-to-head: two competitors run as products, not as quotations

One build (image `sha256:abfce039` at commit `407baf83`), cold track, fixed n=30
per arm per task, no early stopping, **100% completion on all 28 cells**. Raw
rows: `competitors-v1.jsonl` (840 rows, no duplicates, single build). Spend:
$64.26.

## The result

Cost per unit of work delivered, failures charged, against vanilla Claude Code:

| arm | vs control | | what it is |
| --- | --- | --- | --- |
| **`assist`** | **0.665** [0.624, 0.704] | **-33.5%** | our full product |
| `ours-rules` | 0.677 [0.639, 0.715] | -32.3% | our text alone |
| `tokenade-rules` | 0.759 [0.722, 0.794] | -24.1% | their text alone (see caveat) |
| `tokenjuice` | 0.861 [0.818, 0.905] | -13.9% | their product, installed |
| `cto-patched` | 0.972 [0.928, 1.019] | **not established** | their product, hooks repaired by us |
| `cto` | 0.984 [0.935, 1.036] | **not a measurement** | their product as shipped -- inert |

Against the two competitors that were actually measured, `assist` leads.

## The primary endpoint replicates; the attribution does not survive

**Against the competitor's text, pre-registered as the primary endpoint:**
`assist` vs `tokenade-rules` = **0.876 [0.821, 0.931]**, a 12.4% win over 4 tasks.

That is a genuine replication. The earlier large-context campaign, on a
*different image and a different commit* and with only three tasks, measured
**0.878 [0.831, 0.926]**. Two independent builds, 12.2% and 12.4%. Nothing about
this number depends on a single run.

**Against our own text, which is the attribution that matters:** `assist` vs
`ours-rules` = **0.982 [0.918, 1.050]** -- the interval spans parity, so
**interception adds nothing measurable over shipping our rules file alone.**

| task | assist vs ours-rules | |
| --- | --- | --- |
| noisy-command | 0.883 [0.820, 0.952] | interception helps |
| large-file-defect | 0.964 [0.921, 1.012] | spans parity |
| generation-amid-bulk | 0.950 [0.800, 1.120] | spans parity |
| whole-file-transform | 1.149 [0.962, 1.395] | spans parity, point estimate against us |
| **aggregate** | **0.982** [0.918, 1.050] | **not established** |

This is weaker than the post-fix result in RESULTS-LARGECONTEXT.md, which found
0.942 [0.893, 0.992] and excluded parity. That comparison covered two tasks; this
one covers four, including the two where interception has least to offer. The
honest reading is that **our win is carried mainly by the text**, and the hooks
are not yet earning their place on the cost endpoint.

Read that beside the wall-clock note below before concluding anything about the
hooks: on `large-file-defect` they cost about six minutes per run.

## The finding that took the most work to get right

**claude-token-optimizer's interception never runs on Claude Code 2.1.251.**

Three of its twelve hooks -- `pre-tool-read-guard.sh`, `pre-tool-bash-guard.sh`,
`post-write-token-diff.sh`, which are its entire PreToolUse mechanism -- begin:

```bash
TOOL_NAME="${CLAUDE_TOOL_NAME:-}"
if [ "$TOOL_NAME" != "Read" ]; then exit 0; fi
```

Claude Code does not set `CLAUDE_TOOL_NAME`. It sends `tool_name` inside the
stdin JSON payload. Verified by running a dump hook under a real `claude -p` in
this image: the variable is UNSET, and the payload carries
`{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{...},...}`.
Sent their guard the payload Claude Code actually sends: `exit 0`, no output.
Sent the same payload with `CLAUDE_TOOL_NAME=Read` added: `exit 2`,
`Read blocked: ... is 58KB`.

So the `cto` row above measures an arm whose mechanism never executed. **It is
not evidence that we beat them.** It was very nearly published as if it were.

## Repairing their hooks does not change the answer

`cto-patched` is their product with one change: `tool_name` read from the stdin
payload instead of the environment. Thresholds and blocking logic untouched, and
every patched file carries a header saying the benchmark patched it.

Verified firing during a real run, not merely in a synthetic probe: an
instrumented invocation on `large-file-defect` logged **8 hook invocations (5
Bash, 1 Edit, 2 Read), both Reads on a 350,972-byte file** against their
51,200-byte block threshold -- so by their own code those reads were refused.

Result: **0.972 [0.928, 1.019]**, still spanning parity. Their approach, with its
mechanism demonstrably running, produces no measurable saving on this battery.

**The likely reason, stated as inference rather than measurement.** Their guard
BLOCKS an oversized read; ours substitutes a cheaper answer for it. A refusal
costs a whole turn to redirect, so what is saved by not reading is spent getting
the work done another way. Mean turns bear this out -- `cto-patched` 5.67 against
control 5.57 on `large-file-defect`, while `assist` runs 5.00. This was predicted
in the arm definition before any number existed, and it is the sharpest practical
difference between the two designs.

## tokenjuice is genuine, and internally consistent

`tokenjuice install claude-code` writes only a settings block pointing at its
global binary; its hook rewrites a Bash command to run through its compactor,
confirmed by feeding it the real payload. Its per-task pattern corroborates it:

| task | ratio | |
| --- | --- | --- |
| noisy-command | 0.717 [0.655, 0.782] | large win -- a `pytest -v` command |
| whole-file-transform | 0.745 [0.653, 0.859] | win |
| large-file-defect | 1.001 [0.938, 1.064] | nothing -- Read-heavy |
| generation-amid-bulk | 1.027 [0.917, 1.143] | nothing |

It hooks `Bash` only, and it wins exactly where commands are noisy and does
nothing where the work is reading files. That is what a hook that really fired,
on the surface it claims, looks like.

## A defect this benchmark is structurally blind to

`assist` on `large-file-defect` runs at a median **6.17 minutes per run**. Every
other cell in this campaign is 0.16-0.56. Cost ($0.0721) and turns (5.0) are
normal, so it is not doing more work in token terms -- it is roughly six minutes
of our hooks per run on a 342 KB file.

The endpoint here is dollars, so that stall is **free in the metric** and
miserable for a user. Nothing this benchmark has ever published could have caught
it, and it took looking at `started_at` gaps -- for scheduling reasons, not
scientific ones -- to notice.

It is not a regression from this image: the same cell measured 5.02 and 6.34
min/run on the previous image. It has always been there and was never measured.

## What bounds every number above

- **No adversarial task resolved.** `whole-file-transform` does not converge, and
  `generation-amid-bulk` -- built as a bias control -- turned out to be a task we
  win (see RESULTS-ADVERSARIAL.md). So this comparison has no bias control, the
  harness says so itself, and no figure here should be quoted as though it did.
- **`tokenade-rules` is their text, not their product.** Their CLI needs an
  account. If their hooks contribute materially, that arm understates them.
- **claude-token-optimizer's CLAUDE.md is a template.** It ships saying "Tech
  Stack: Unknown" and "Add your common commands here"; their product expects a
  human to fill it in and nobody does on a generated repo. To that extent both
  `cto` rows understate them.
- **`generation-amid-bulk` is pre-registered at n=60** and ran at 30 here, so its
  contribution to these aggregates is below its own registered power.
- **One client version.** Every statement about `CLAUDE_TOOL_NAME` is scoped to
  Claude Code 2.1.251; an older client may well have set it, which would mean
  these hooks worked once and were broken by a client change rather than shipped
  broken.
