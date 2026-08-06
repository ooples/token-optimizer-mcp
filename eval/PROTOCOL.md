# Does the knowledge graph make the agent smarter, and cheaper?

Two separate claims needing two separate experiments. The repository already had a
rig for the second one and nothing for the first.

## What was already true before this eval

Measured, not assumed:

| | |
| --- | --- |
| structural graph | working — 851 nodes, 6,516 edges, 0 dangling, current |
| semantic layer | **1 finding**, written by hand; auto-capture merged but not yet released |
| injections ever fired | **1**, in 549 metric rows (548 `read`, 1 `inject`) |
| holdout rig | built (`metrics.mjs`, stratified by file+epoch) — **1 arm sample** |

So there was no data from which to claim either efficiency or intelligence. The rig
was not broken; it had never had findings to serve.

## Design

Three arms, because two would not tell the two failure modes apart:

| arm | receives | isolates |
| --- | --- | --- |
| **A** control | task only | baseline competence |
| **B** possession | task + 1 relevant + 2 distractor findings | is the knowledge worth having? |
| **C** retrieval | task, graph populated, hooks live | does retrieval actually surface it? |

`B > A` means the findings carry value. `C ≈ B` means retrieval works. `C ≈ A` while
`B > A` means retrieval is broken — and a two-arm design would have hidden that
behind a null result. For a "replaces RAG" claim, that distinction *is* the product.

**Distractors are mandatory in arm B.** In production the graph injects the top few
findings by relevance, not the one perfect answer. An arm handed only the correct
finding measures possession, not retrieval, and overstates the result.

5 tasks × 3 arms × 3 repeats = 45 trials. Repeats because model output varies run to
run; a single trial per cell measures luck.

## Two flaws caught before running, either of which would have invalidated the result

**1. The merged fixes contain the answers.** Every task comes from a real PR, and
those PRs are merged — so the current tree explains each cause in code comments
(`a glob rooted AT a file matches nothing`, `confident zero`). A control agent would
have read the answer and scored near 100%, and the experiment would have measured
nothing at all.

Every trial therefore runs against a **pre-fix worktree**, where the bug is live and
the explanatory comments do not exist:

| task | tree | verified state |
| --- | --- | --- |
| grep-path-file | `a6fa649` | `cwd: options.path ?? ...` live; `search-scope.ts` absent |
| nested-array-type | `04d6983` | `isArray = /type:\s*'array'/.test(block)` live |
| libuv-abort | `dc39357` | `isFsSafePath` absent |
| manifest-drift | `843c1e9` | `server.json` 5.1.1 against package 5.4.3 |
| pin-vs-latest | master | answer is in repo history *by design* — see below |

`nested-array-type` was initially pointed at the PR's parent commit, where the file
under test did not yet exist, so the task premise could not hold. It targets the
commit where that defect was actually live.

`pin-vs-latest` deliberately runs against master: the correct answer *is* discoverable
by reading the repo, so a control agent that finds it is a fair result. That item asks
whether the graph beats simply reading the code — which is the RAG comparison.

**2. Worktrees isolate the graph, which the control arm needs.** A worktree carries
its own `.git`, so `projectRootFor` resolves to it and it gets an empty
`.token-optimizer`. Control arms cannot be contaminated by findings stored against
the main checkout.

## Hooks reach subagents — verified, not assumed

Trials run as subagents, so the whole design depends on hooks applying to them. A
first probe saw no hook output and looked like evidence they do not — but it used a
3 KB read and a non-recursive grep, neither of which is intercepted for anyone. The
decisive probe used calls that are *guaranteed* to be refused:

```
grep -rn ... -> REFUSED: "Recursive shell searches return unbounded output..."
Read decide.mjs (28 KB) -> REFUSED, served the symbol skeleton + git history instead
```

Hooks fire in subagents. Arm C is feasible.

That refusal also confirmed the empty semantic layer from the outside: *"Nothing
learned about this file yet."*

## Scoring

Blind. The scorer sees the task, the documented cause, the documented wrong turns and
the trial's answer — never which arm produced it.

- **correct** — names the actual mechanism, not merely the symptom or the file
- **wrong turn** — took one of the documented dead-ends
- **tokens** — subagent token usage, reported per trial

Ground truth is the `cause` field of `eval/corpus.json`, taken from the PR body
written when the bug was fixed, months before this eval existed.

---

## Pre-registration (fixed before any further trials)

The pilot's control arm solved `grep-path-file` unaided, and the arm carrying the
finding spent 3.9% MORE tokens for the same answer:

| arm | verdict | tokens | tool calls |
| --- | --- | --- | --- |
| A control | correct, high confidence, reproduced empirically | 63,726 | 15 |
| B possession | correct, same mechanism | 66,209 | 13 |

That is a ceiling effect, not a broken harness, and it exposed a flaw in the corpus.

**The discriminating axis is not "is the answer written in the repo".** Checked against
each trial's own tree, no task has its answer written down — the pre-fix worktrees
predate the explanatory comments. The axis that matters is whether a competent agent
can **derive** it from the code in front of them:

| class | tasks | expectation |
| --- | --- | --- |
| derivable by reasoning | grep-path-file, nested-array-type, manifest-drift, pin-vs-latest | little or no gain; the control can work it out |
| requires external knowledge | libuv-abort (+3 to be added) | the graph's actual claim |

`libuv-abort` is the only current member of the second class: an upstream libuv
off-by-one cannot be reasoned out of this repository's source at all.

**Nothing is dropped.** `grep-path-file` stays in the corpus and its negative result is
reported. Three further external-knowledge tasks are being added so that class is not
n=1, and results will be reported split by class. This classification is fixed here,
before the remaining trials run, precisely so it cannot be adjusted afterwards to suit
the outcome.

An incidental finding, relevant to the "replaces CLAUDE.md / RAG" question: three
candidate external-knowledge tasks had to be rejected because this repository already
documents those lessons in code comments and tests (`append-all.ts`,
`pinned-spec-tracks-package.test.ts`, `docs/PUBLISHING.md`). A codebase that records
its own hard-won knowledge is itself the graph's main competitor.
