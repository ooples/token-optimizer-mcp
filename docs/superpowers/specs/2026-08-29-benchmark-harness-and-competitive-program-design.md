# Benchmark harness and competitive program — design

**Date:** 2026-08-29
**Status:** approved design, pending implementation plan
**Author:** brainstormed with the maintainer; all measurements taken this session

---

## 1. Why this exists

Two things happened on 2026-08-29 that this design responds to.

First, a competitive analysis found that an independent, reproducible benchmark
for this category now exists — the Token-Harness Optimizer Leaderboard (THOL) —
that `token-optimizer-mcp` is registered in its Tier 1 table as a "manifest
stub", and that it has therefore never been run. The category's marketing
numbers ("−90% tokens", "95%+ reduction") are measured at the tool boundary;
THOL measures cost per *solved* task end to end, and almost nothing survives the
translation. Of twelve tools measured, one beat the control with a confidence
interval excluding 1.0, nine were indistinguishable from doing nothing, and two
were measurably worse.

Second, and more importantly, a real defect was found **by accident**: a 39 KB
`Write` was refused by our own hook, and satisfying the refusal cost a second
copy of the file. A benchmark owned by this project would have found that
deliberately. That is the argument for this work.

## 2. What we measured

A local screening campaign was run against the real THOL harness in Docker.

- **Battery:** 16 of THOL's 17 tasks (`web-research-oss-inventory` excluded — at
  ~$5.01/run it is over half the battery's cost and adds little discrimination)
- **Arms:** 3 — `control` (vanilla Claude Code), `token-optimizer-mcp`
  (shipped default, enforcing), `token-optimizer-mcp-off`
  (`TOKEN_OPTIMIZER_MODE=off`, identical in every other respect)
- **Runs:** 48, all completing `ok`
- **Pinned:** product 6.0.2, Claude Code 2.1.251, `claude-sonnet-4-6`

| arm | total cost | ratio vs control | avg turns | tool calls (ours) | avg score |
| --- | --- | --- | --- | --- | --- |
| control | $3.566 | 1.000 | 12.6 | 222 (0) | 0.994 |
| enforcing (shipped default) | $6.017 | **1.687** | 20.9 | 304 (115) | **0.956** |
| `MODE=off` | $3.225 | **0.904** | 13.1 | 194 (8) | 0.994 |

Three conclusions.

**Enforcement is what loses.** At 1.687 the shipped default would rank last of
thirteen on THOL's published aggregate — below `headroom` at 1.557. It lost on
13 of 16 tasks, worst case `code-settings-inventory-django` at 4.44×.

**Enforcement also degrades correctness.** 0.956 against 0.994. It is not
merely expensive; it makes tasks fail. Any framing that treats this as a
cost/benefit trade is wrong — there is no benefit column.

**Everything else is already competitive.** `MODE=off` at 0.904 would rank
second on THOL's aggregate, behind `tokenade` (0.768) and ahead of
`claude-token-efficient` (0.952).

The mechanism is legible in the turn counts. Enforcement added ~107 tool calls
and took turns from 12.6 to 20.9 — approximately **one extra turn per refusal**.
A refusal that redirects costs a round trip; the tokens it "saves" are smaller
than the turn it spends.

### 2.1 What this measurement does *not* establish

Stated here so it is never over-claimed downstream:

- `--reps 1`, so there is no confidence interval. This is a **screen**, not a
  publishable number. The effect size (87% relative between our two arms) is far
  outside plausible sampling noise and is mechanistically explained, which is why
  it is strong enough to act on.
- Run on our harness at Claude Code 2.1.251, not THOL's published 2.1.206
  campaign. Rows are not directly comparable to the published board; the
  comparisons above are to *our own* control arm, which is the valid comparison.
- **The knowledge graph scored nothing, by construction.** Every THOL run gets a
  throwaway `HOME` and a fresh workspace, so the graph began empty on all 48
  runs, and a finding harvested at `Stop` cannot help the session that produced
  it. The graph therefore carried its full overhead with structurally zero
  payoff — and `off` still beat control by 9.6%. This is the worst case for the
  graph, not a measurement of it.

## 3. Goals and non-goals

**Goals.**

1. A verified, published row on THOL — the board buyers actually compare.
2. A multi-session benchmark we own and publish, measuring the cross-session
   value THOL structurally cannot see.
3. A benchmark harness living in this repo, so a behaviour change and its
   measured effect can land in the same commit.
4. Stop shipping a default that is measurably worse than not installing us.

**Non-goals.**

- Winning every task. Some tasks are too small to discriminate.
- Replacing THOL. We compete on their board *and* publish ours.
- A general-purpose agent benchmarking framework. This measures this product.

## 4. Decisions, and what was rejected

| decision | rejected alternative | why |
| --- | --- | --- |
| Compete on THOL **and** publish our own multi-session benchmark | THOL only; or ours only | THOL alone grades us on a race that excludes our differentiator. Ours alone is a benchmark run by the vendor it flatters — exactly the credibility problem THOL's own charter names. |
| Default `MODE=off`; re-admit enforcement rules **on measured evidence** | Delete enforcement; or keep it on and re-tune | Deleting discards the one mechanism that solved the adoption failure killing 9 of 12 THOL tools. Keeping it on ships a 1.687 default. Off-by-default stops the loss now; per-rule re-admission preserves the idea and makes it earn its place. |
| Default to `off`, not `advise` | `advise` as the middle ground | `off` is the configuration measured at 0.904. `advise` was never measured and spends `additionalContext` tokens on every matched call, so it is plausibly harmful. It stays available, opt-in. |
| Harness in the main repo under `bench/` | Separate public repo; keep external rig | Versioned with the code it grades, so CI and reviewers can reproduce any published claim, and a rule change ships with its number. Excluded from the npm `files` list so users never download it. |
| Our benchmark measures **derive-then-reuse** | Compaction survival; long-lived project simulation; cross-client transfer | Directly isolates what the graph is for, and the control arm is honest: a competitor without memory re-derives and pays. Cross-client transfer is a real moat but a benchmark only we can pass reads as self-serving. |

## 5. Architecture: `bench/`

```
bench/
  lib/       sandbox construction, credential staging/segmentation,
             results schema, stream-json extraction
  thol/      external board: Dockerfile, entrypoint, orchestrator,
             our manifest + control arm
  recall/    derive-then-reuse benchmark: task pairs + verifiers
  README.md  how to run; what each number means and does not mean
```

### 5.1 One row shape

Both benchmarks emit identical rows so they share a renderer and nothing is
comparable-looking but incompatible:

```
{ campaign, arm, task, rep, cost_usd,
  tokens { in, out, cache }, turns, tool_calls, own_tool_calls,
  score, wall_ms, fixture_hash, product_version, client_version }
```

`own_tool_calls` is the adoption signal; `score` is the correctness gate;
`fixture_hash` is what makes a run attributable to an input set.

### 5.2 Lessons encoded rather than rediscovered

Each of these cost real time this session and is written into the harness:

- **All three fixture generators run.** THOL's `CONTRIBUTING.md` documents only
  `generate_fixtures.py`; without `gen_longtasks.py` and `gen_megatasks.py` the
  selftest aborts with `fixture 'cascade-debug' missing`.
- **Fixtures are generated once, content-hashed, and reused.** THOL's fixtures
  are *not* reproducible despite fixed seeds — repeated runs in one image
  produced `cascade-debug` at 30/44, then 25/44, then 30/44. Within one segment
  every arm sees the same files; across segments they would not, which would
  quietly make arms incomparable. `PYTHONHASHSEED=0` is pinned as well.
- **`/results` is a Docker named volume, never a Windows bind mount.** Deep
  trees (a django checkout) could not be deleted through a bind mount even from
  inside a Linux container. The volume is created root-owned and must be
  chowned to the container's non-root user.
- **Credentials re-stage between segments.** `runner.py` copies
  `~/.claude/.credentials.json` into a throwaway per-run `HOME`, so a token
  refresh inside a sandbox dies with it; a 4–6h battery outlives a ~2.5h access
  token.
- **Containers are named** so a stray one can be found and killed. An unnamed
  container outliving its wrapper produced two phantom "failures" and held a
  directory lock.
- **The MCP manifest needs an `mcpServers` wrapper.** Without it every run dies
  in ~1s with `Invalid MCP configuration`.
- **Version pinning requires a pre-seeded runtime.** `launch.mjs` on a cold
  runtime serves whatever the npx cache holds. Addressed in product by PR #349
  (`TOKEN_OPTIMIZER_VERSION`); the harness pins with it.

### 5.3 Impartiality by construction

Borrowed from THOL's charter, because a benchmark run by its beneficiary is
worthless without it:

- Arms are configurable **only** by manifest — never by special-casing in the
  harness.
- Verifiers are frozen before any competitor run and score task outcomes, not
  tool behaviour.
- A control arm is always present.
- **All** raw per-run rows are published, including unfavourable ones.
- Cost is never published without its paired correctness score.

### 5.4 Cost containment

A 48-run screen is ~$13 and about an hour, so the harness does not run in CI by
default. Instead:

- `npm run bench:screen` — local, `--reps 1`, the triage tool.
- `npm run bench:confirm` — `--reps 3` on a named task subset, for claims.
- A manual/nightly workflow for full campaigns.
- **Policy gate:** a PR that changes hook decision logic must attach a bench
  delta. This is the rule that would have caught the `Write` defect by design.

## 6. Product changes

### 6.1 The default flip

`TOKEN_OPTIMIZER_MODE` defaults from `enforce` to `off`. Everything except the
refusal survives: the MCP server and tools, the knowledge graph, `SessionStart`
guidance, and harvest. That is exactly the configuration measured at 0.904, and
it still made 8 voluntary smart-tool calls.

**Positioning consequence, named plainly.** "Enforced by default" is the
README's headline claim and a badge. It must go. The replacement claim is
*measured, not enforced* — which is more defensible and is the one thing no
competitor in this category can currently say.

### 6.2 Re-admission protocol for enforcement

Since the cost is the refusal round-trip, the design rule is: **a refusal is
viable only if it answers in the refusal rather than redirecting.**

Rules become individually switchable and are measured as five families, one arm
each:

| family | rule | prior |
| --- | --- | --- |
| R1 | large first `Read` | costs a turn — likely negative |
| R2 | repeat `Read` (already carries the diff) | zero-turn — most likely net-positive |
| R3 | `Grep`/`Glob` bounding | costs a turn |
| R4 | Bash content dumps (`cat`/`head`/`grep -r`) | costs a turn |
| R5 | large `Edit` | costs a turn |

`Write` is already removed (PR #348). A family ships enabled only when its arm
beats `off` on cost **and** does not lose correctness. Five families × 16 tasks
≈ 80 runs ≈ $22 per sweep.

### 6.3 Levers, landed one at a time

Each lands as its own change with its own measured delta:

- **L1 — CLAUDE.md terseness scaffold.** Output tokens were the THOL winner's
  largest lever (−26.9%); a tool that is *only* a CLAUDE.md file ranked second
  of twelve. We ship nothing on this axis.
- **L2 — compaction window and cache economics.** Cache fell 21.8% for the
  winner. We set no `autoCompactWindow`; `keepwarm.mjs` exists but no setting
  reaches the client.
- **L3 — PostToolUse rewrite-in-place** on `Read`/`Grep`/`WebSearch`/`WebFetch`.
  The principled replacement for enforcement: same benefit, no turn tax.
  **Requires a spike first** — `anthropics/claude-code#32105` means a hook
  cannot replace a built-in tool's result, so coverage may be limited to Bash
  and MCP results. Establish feasibility before designing around it.
- **L4 — statusline.** An always-visible number. Competitors ship one; ours is a
  dashboard you must open.

## 7. Measuring the knowledge graph

The graph is the largest differentiator and was the least measured. It gets
three measurements, not one.

| measurement | method | why |
| --- | --- | --- |
| **Calls avoided** | `bench/recall/`: session 1 derives a non-obvious conclusion; session 2 starts cold and is asked something depending on it. Compare session 2 cost, tool calls and score, graph on vs off. | A finding carried is calls not made. Tool calls are the term that actually moved in the screen (194 vs 222), so it is the right unit. |
| **Cold-start overhead** | A graph-disabled arm added to the single-shot screen. | Tells us what an *empty* graph costs. Currently unknown and assumed small — and it is the only case THOL will ever see. ~16 runs ≈ $4, so it lands with the first milestone. |
| **Field effect** | The randomized holdout already shipping in-product, which withholds graph delivery on a random subset. | A continuous measurement on real workloads that no competitor has. Cross-validate against the benchmark rather than building something new. |

**Self-check that must be honoured:** if the graph-disabled arm shows the graph
is net-negative single-shot, that result is published and becomes a bug to fix,
not a number to bury.

### 7.1 `bench/recall/` task shape

Each task is a pair plus a verifier:

- `derive.md` — a prompt whose answer requires real work (a root cause, a
  non-obvious constraint) and is not present in the workspace.
- `reuse.md` — a prompt in a **fresh session with cold context** whose correct
  answer depends on what session 1 established.
- `verify.py` — scores session 2 from ground truth never present in the
  workspace, and awards no credit on an empty workspace.

Arms: graph on (session 1 and 2 share a project graph) versus graph off
(sessions fully isolated). The control arm is honest — a memoryless competitor
re-derives and pays, which is the real-world comparison.

## 8. What we publish

The headline claim, if the numbers hold: **cost, correctness, and calls-avoided,
each against a control arm**, where the field number comes from real sessions
and the benchmark number is reproducible by anyone. No competitor publishes two
of those three.

Published artifacts: every raw per-run row; the fixture content-hash; product
and client versions; and the methodology, including these caveats verbatim.

## 9. Sequencing

Approach chosen: **evidence-gated rollout**. The default flip ships first
because it is a one-line change, worth ~45% of session cost, and is already
backed by 48 runs; every subsequent change is then measured against a product
that is not actively losing.

| milestone | contents | exit criterion |
| --- | --- | --- |
| M1 | Default `MODE=off`; README/positioning rewrite; patch release | Released; `off` is what users get |
| M2 | `bench/` landed: `lib/` + `thol/`, migrated from the external rig; `bench:screen` and `bench:confirm` scripts | A maintainer can reproduce §2 from a clean clone |
| M3 | Graph-disabled arm; `--reps 3` confirmation of §2 on the losing tasks | §2 has confidence intervals; graph overhead known |
| M4 | THOL manifest PR upstream, pinned at the default-off release | A verified row appears on the public board |
| M5 | Enforcement families R1–R5 measured; net-positive families re-enabled | Each family has a number; only winners ship on |
| M6 | L3 spike, then L1/L2/L4 landed one at a time | Each lever has its own delta |
| M7 | `bench/recall/` built and published | Calls-avoided measured; multi-session benchmark public |

M1 is independent. M2 gates M3–M6. M7 can proceed in parallel with M5–M6.

**Decomposition.** This is a program, not one plan. The first implementation
plan covers **M1–M3** — the flip, the harness, and the evidence that makes
every later claim defensible — because those are fully specified here and
unblock everything else. M4 (upstream PR), M5 (enforcement families), M6
(levers) and M7 (`bench/recall/`) each get their own spec-and-plan cycle, since
each depends on numbers M2 and M3 have not produced yet. Writing detailed steps
for M5 today would be inventing them: the whole point is that the families are
re-admitted on measurements that do not exist until M2 lands.

## 10. Risks

| risk | mitigation |
| --- | --- |
| The screen is `--reps 1` and could mislead | M3 confirms at `--reps 3` before any published claim. The flip itself is safe regardless: `off` is what users would get by not installing enforcement. |
| Flipping the default reads as capitulation | It is the opposite, and should be framed as such: we are the only tool in the category that measured itself and acted. That story is stronger than the badge it replaces. |
| Our own benchmark is dismissed as self-serving | §5.3, adopted wholesale from THOL's charter. Publish unfavourable rows first. |
| THOL's harness changes and our fork drifts | `bench/thol/` clones THOL pinned at run time and vendors none of its code; our manifest is the only artifact we own. |
| Re-admission sweeps get expensive | Families, not individual rules; reduced task subsets for iteration; full sweeps only at milestone boundaries. |
| L3 may be infeasible | Spike before design. If a hook genuinely cannot rewrite built-in results, L3 narrows to Bash and MCP output and the plan says so. |

## 11. Open questions for the implementation plan

1. Does `MODE=off` disable only the refusal, or also the `SessionStart`
   guidance? The measured arm suggests guidance survives (8 voluntary calls),
   but this must be confirmed in code before the flip.
2. What is the per-rule switch mechanism — env, config file, or manifest — and
   is it user-facing or internal to the harness?
3. Where does `bench/recall/` get deterministic "derivable" fixtures that are
   hard enough to require real work but stable enough to verify?
4. Does the L3 hook constraint (`#32105`) permit rewriting `Read` results at
   all, or only Bash and MCP results?
