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

| arm | total cost | total-cost ratio | **task-mean ratio** | avg turns | tool calls (ours) | avg score |
| --- | --- | --- | --- | --- | --- | --- |
| control | $3.566 | 1.000 | 1.000 | 12.6 | 222 (0) | 0.994 |
| enforcing (shipped default) | $6.017 | 1.687 | **1.633** | 20.9 | 304 (115) | **0.956** |
| `MODE=off` | $3.225 | 0.904 | **0.928** | 13.1 | 194 (8) | 0.994 |

Both aggregations are shown because both appear in this document; §2.0 defines
them and states that the **task-mean ratio is the figure of record**.

Three conclusions.

**Enforcement is what loses.** At a task-mean 1.633 the shipped default ranks
last of fifteen against the published board recomputed over these 16 tasks —
below `headroom` at 1.471. It lost on 13 of 16 tasks, worst case
`code-settings-inventory-django` at 4.44×.

**Enforcement also degrades correctness.** 0.956 against 0.994. It is not
merely expensive; it makes tasks fail. Any framing that treats this as a
cost/benefit trade is wrong — there is no benefit column.

**Everything else is already competitive.** `MODE=off` at a task-mean 0.928
ranks second of fifteen, behind `tokenade` (0.810) and ahead of
`claude-token-efficient` (0.952) — though §2.1 records what that arm actually
was.

### 2.0 Two aggregations, and which one to use

Two numbers appear for the same arm throughout this document. They are not a
contradiction, but leaving them undefined would make the result irreproducible,
so:

| name | definition | `off` | `enforce` |
| --- | --- | --- | --- |
| **total-cost ratio** | `Σ(arm cost) / Σ(control cost)` over the 16 tasks — one pooled number, so expensive tasks dominate | 0.904 | 1.687 |
| **task-mean ratio** | geometric mean of the 16 per-task ratios `cost(arm,t) / cost(control,t)` — every task weighs the same | **0.928** | **1.633** |

**The task-mean ratio is the figure of record**, for two reasons: it is what
THOL publishes, so it is the only one comparable to a competitor; and a pooled
total lets one expensive task carry the verdict, which is how a tool that helps
only on huge sessions can look good everywhere.

Every comparison, target and projection in this document therefore uses the
task-mean ratio — the 0.810 threshold, the 0.777 path, and M4/M5's exit
criteria. Total-cost ratios appear only in the §2 arm table, which reports what
the campaign actually spent, and are labelled there.

Tokenade likewise appears as two figures: **0.768** is its published aggregate
over THOL's full 17-task battery, **0.810** the same aggregation recomputed over
only the 16 tasks we ran. Comparisons here use 0.810, because comparing across
different task sets is not a comparison.

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
  it. This is the worst case for the graph, not a measurement of it.

- **`MODE=off` is a kill switch, not "enforcement minus refusals".** Found while
  implementing the flip, and it corrects an earlier version of this document.
  `hooks-core/adapter.mjs` runs `if (mode() === MODE_OFF) process.exit(0);`
  before any event handling, and `hooks-core/stop-harvest.mjs` returns early on
  the same check. Only `policy.mjs`'s `enforce()` treats OFF as the narrow
  "allow instead of deny". So the arm measured at 0.904 was **the product almost
  entirely disabled** — MCP tool schemas still registered, everything else dead —
  which is why it made only 8 voluntary smart-tool calls. Proof: flipping the
  default to off turned 90 tests across 20 suites red, and the failures were in
  harvest, injection, staleness and seen-state suites, not in refusal suites.

  0.904 therefore remains a valid measurement of *a shippable configuration*,
  but it is **not** a measurement of "our product without enforcement", and
  shipping it as the default would ship a product with no knowledge graph.

## 3. Goals and non-goals

**Goals.**

1. **Rank first.** Aggregate cost ratio below **0.810** — tokenade's figure on
   our 16 tasks — measured with **enforcement ON**, not off. Second place is not
   the target; parity is not the target.
2. A verified, published row on THOL demonstrating it.
3. A multi-session benchmark we own and publish, measuring the cross-session
   value THOL structurally cannot see.
4. A benchmark harness living in this repo, so a behaviour change and its
   measured effect can land in the same commit.
5. Stop shipping a default that is measurably worse than not installing us,
   while the work in goal 1 lands.

Goal 1 is the constraint the rest of the design serves. Enforcement is the
mechanism that solved the adoption failure which left 9 of 12 THOL tools
indistinguishable from doing nothing; winning *without* it would mean winning
without our differentiator.

### 3.1 The quantified path to first place

Modelled on the measured per-task data (§2), holding everything else constant:

| scenario | aggregate | vs tokenade 0.810 |
| --- | --- | --- |
| today, `MODE=off` | 0.928 | behind |
| close the debug-loop gap only | 0.811 | dead heat |
| remove small-session overhead only | 0.872 | behind |
| **both** | **0.777** | **first, by ~4%** |
| both, debug gap only half closed | 0.831 | still behind |

Two conclusions that set the roadmap. **Both levers are required** — either alone
leaves us behind. And **the debug-loop gap must be substantially closed, not
partially**: halving it lands at 0.831, still behind. This is why §6.3 reorders
the levers away from what was originally proposed.

The 0.777 figure assumes enforcement is cost-neutral, which §6.2 is what makes
true.

**Non-goals.**

- Winning every task. Some tasks are too small to discriminate.
- Replacing THOL. We compete on their board *and* publish ours.
- A general-purpose agent benchmarking framework. This measures this product.

## 4. Decisions, and what was rejected

| decision | rejected alternative | why |
| --- | --- | --- |
| Compete on THOL **and** publish our own multi-session benchmark | THOL only; or ours only | THOL alone grades us on a race that excludes our differentiator. Ours alone is a benchmark run by the vendor it flatters — exactly the credibility problem THOL's own charter names. |
| A new **routing-off, retrieval-on** posture as the interim default; enforcement returns ON once it is cost-neutral | `MODE=off` as the interim default; delete enforcement; ship off permanently; keep it on untouched | `MODE=off` was the original plan and is wrong: it exits the hook process, so it would ship with no knowledge graph (§2.1). The posture we want is not expressible today — every experiment arm with retrieval also has routing — so it has to be built. Deleting enforcement discards the mechanism that solved the adoption failure killing 9 of 12 THOL tools; keeping it on untouched ships a 1.687 default. |
| `MODE_OFF` keeps meaning "disable everything" | Re-point `MODE_OFF` at the new posture | It is documented as the one-variable escape hatch and users rely on it. Re-pointing it would leave no complete off switch, which is a worse failure than an extra posture. |
| Default to `off`, not `advise` | `advise` as the middle ground | `off` is the configuration measured at 0.904. `advise` was never measured and spends `additionalContext` tokens on every matched call, so it is plausibly harmful. It stays available, opt-in. |
| Harness in the main repo under `bench/` | Separate public repo; keep external rig | Versioned with the code it grades, so CI and reviewers can reproduce any published claim, and a rule change ships with its number. Excluded from the npm `files` list so users never download it. |
| Our benchmark measures **derive-then-reuse** | Compaction survival; long-lived project simulation; cross-client transfer | Directly isolates what the graph is for, and the control arm is honest: a competitor without memory re-derives and pays. Cross-client transfer is a real moat but a benchmark only we can pass reads as self-serving. |

## 5. Architecture: `bench/`

```text
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

```text
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

### 6.1 The default flip needs a posture that does not exist yet

The original plan — default `TOKEN_OPTIMIZER_MODE` from `enforce` to `off` — was
written believing that only the refusal would stop. §2.1 shows that is false:
`off` exits the hook process, taking the graph, injection and harvest with it.

The posture we actually want is **routing off, retrieval and harvest on**. It
cannot be expressed today, by either control:

- `MODE_OFF` exits before any feature check runs.
- The experiment arms in `hooks-core/experiment.mjs` are strictly cumulative —
  `baseline` `{routing:false, retrieval:false, harvest:false}`, `optimizer`
  `{routing:true, retrieval:false}`, `retrieval` `{routing:true,
  retrieval:true}`, `full` `{routing:true, retrieval:true, harvest:true}`.
  **Every arm with retrieval also has routing.** There is no
  `{routing:false, retrieval:true}`.

So this milestone grows a code change it did not have: add that combination as a
first-class posture, and make it the default. `MODE_OFF` keeps its documented
meaning as the one-variable escape hatch that disables everything — users rely
on that, and re-pointing it would remove the only complete off switch.

**And it must be measured before it ships.** 0.904 is the kill switch's number.
The new posture carries the graph's overhead with the refusals removed, so its
cost sits somewhere between 0.904 and 1.687 and is currently **unknown**. M3
measures it; M1 ships only once that number is in hand.

**Positioning consequence, named plainly.** "Enforced by default" is the
README's headline claim and a badge. It must go. The replacement claim is
*measured, not enforced* — which is more defensible and is the one thing no
competitor in this category can currently say.

### 6.2 Making enforcement cost-neutral — the root cause

Enforcement is not inherently expensive. Its cheap path exists and is dead in
production.

The design already has a **zero-turn refusal**: `refusalPayload` is meant to
return the answer *inside* the refusal — "unchanged since you last read it",
the diff when a snapshot is held, otherwise an annotated skeleton — so the model
never makes a second call. The measurement shows it is not happening: 115 of our
own tool calls and +8.3 turns across 16 tasks means refusals were **redirecting**
("call `smart_read` instead"), each costing a round trip.

`hooks-core/staleness.mjs` states the cause in its own comment:

> the zero-turn refusal, the headline of P4, **never fired outside tests that
> hand-wrote the snapshot themselves**

`refusalPayload` needs a snapshot on the file node to build a `before` side.
Without one it returns null for every real file, and the refusal degrades to a
redirect. So the fix is not to remove refusals — it is to **make the snapshot
exist for the files we refuse**, bounded by the existing `snapshotLimit()` so
the graph does not become a second copy of the repository.

A second, related failure is documented in `hooks-core/policy.mjs`: subagents
inherit the parent session id and shared one `seen` set, so an agent was told a
file was "UNCHANGED since you last read it" when a *different* agent had read
it — and it fell back to Bash, which "defeats the optimizer and costs more than
the read it replaced."

**The invariant this design adopts.** Enforcement ships on only when, against
the `assist` arm of the same campaign, all three hold:

1. **task-mean cost ratio ≤ 1.00** — the binding gate;
2. **turns and `own_tool_calls` do not rise** — the mechanism check;
3. **mean `score` does not fall** — because 1.687 came with correctness at
   0.956, and a cheaper arm that answers worse is not a win.

**Cost is the gate; the call counts are diagnosis.** An earlier version of this
invariant used only turns and `own_tool_calls`, which is unsound: input, output,
cache tokens or injected hook text can all grow while both counts stay flat, so
a refusal family could pass and still cost more. The counts are kept because
they say *why* a family passed or failed — a family that satisfies the cost gate
while raising turns is getting its win from something other than the mechanism
we think, and that is worth knowing before shipping it.

The same three conditions gate M7's return to enforcement by default, so a
family cannot be admitted individually and then collectively lose.

Refusal families are individually switchable so the invariant can be checked per
family: R1 large first `Read`, R2 repeat `Read`, R3 `Grep`/`Glob` bounding,
R4 Bash content dumps, R5 large `Edit`. `Write` is already removed (PR #348).
A family is enabled only when it satisfies the invariant and does not lose
correctness.

**The sweep's arm matrix, since the earlier count omitted its baseline.** The
invariant compares each family against `assist`, so `assist` must be *in the
sweep* rather than borrowed from an earlier campaign — a ratio is only valid
against a control measured in the same campaign, on the same THOL revision and
client version.

| arm | why |
| --- | --- |
| `control` | required by §5.3, and the denominator of every ratio |
| `assist` | the baseline each family is judged against |
| R1 … R5 | one arm per family, `assist` plus that family's refusals |

7 arms × 16 tasks × 3 reps = **336 runs ≈ $95** at the observed ~$0.28/run
average. The earlier "80 runs ≈ $22" figure counted the five family arms alone,
at one rep, with no baseline — which would have produced ratios against nothing.

At that size the sweep is a milestone-boundary activity, not something to run
casually. A cheaper screen at `--reps 1` (112 runs ≈ $31) can triage which
families are obviously negative before spending on the full sweep.

### 6.3 Levers, reordered by measured value

**This ordering replaces the one first proposed.** L1 and L4 below were
originally ranked first on the strength of THOL's published token composition;
the per-task measurement in §2 says the two levers that actually decide first
place are the ones that were ranked third and not at all. The evidence outranks
the prior.

- **P0 — Bash and test-output compaction in `PostToolUse`.** Debug loops are our
  worst family (1.248) and tokenade's best (0.611); a debug loop reruns a test
  suite and each run dumps a wall of output. tokenade compacts `Bash` output in
  a hook at zero turn cost; we *refuse* dumping commands instead, which costs a
  turn and pushes the agent to another route. Closing this gap alone moves the
  aggregate 0.928 → 0.811. **Required, and must be substantially closed** —
  halving it lands at 0.831, still behind.
- **P1 — Suppress fixed overhead on small sessions.** The cheap band is 1.170
  while the expensive band is 0.620 against a leader at 0.618. A fixed
  per-session cost — MCP tool schemas re-sent every turn, hook banners,
  SessionStart injection — is negligible on a $0.38 session and dominant on a
  $0.13 one. Costs no capability to fix; moves the aggregate to 0.872 alone and
  is required to reach 0.777 together with P0.
- **P2 — Make the zero-turn refusal actually fire** (§6.2). This is what lets
  enforcement be on at all, so it gates goal 1 rather than adding to it.
- **P3 — CLAUDE.md terseness scaffold.** Output tokens were the winner's largest
  single lever (−26.9%) and a rival that is *only* a CLAUDE.md file ranks third
  on our board. Unquantified for us, so it is upside beyond 0.777 rather than
  part of the path to it.
- **P4 — compaction window and cache economics.** Cache fell 21.8% for the
  winner. `keepwarm.mjs` exists but no setting reaches the client.
- **P5 — statusline.** Visibility, not cost.

P0 needs a feasibility spike first: `anthropics/claude-code#32105` means a hook
cannot replace a built-in tool's result. Bash output is the case that matters
most for debug loops and is reachable via `PostToolUse`, but `Read`/`Grep`
coverage must be established, not assumed.

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
| M0 | Build the routing-off/retrieval-on posture (§6.1) — it does not exist today | The posture is selectable and the graph still runs with refusals disabled |
| M2 | `bench/` landed: `lib/` + `thol/`, migrated from the external rig; `bench:screen` and `bench:confirm` | A maintainer reproduces §2 from a clean clone |
| M3 | Measure the new posture; graph-disabled arm; `--reps 3` confirmation on the decisive tasks | The interim default has a number, which 0.904 is not; graph overhead known |
| M1 | Ship the new posture as the default; positioning rewrite; patch release | Released, on a measured number rather than an assumed one |
| M4 | **P0** — Bash/test-output compaction (spike first) | Debug family ≤ 0.70; aggregate ≤ 0.82 |
| M5 | **P1** — small-session overhead suppression | Cheap band ≤ 1.00; **aggregate < 0.810 → first place** |
| M6 | **P2** — zero-turn refusal fires; families R1–R5 checked against the invariant | Every enabled family satisfies §6.2's three conditions against `assist` |
| M7 | Default returns to **enforcing**; THOL manifest PR upstream | A verified first-place row, measured with enforcement on |
| M8 | `bench/recall/` built and published | Calls-avoided measured; multi-session benchmark public |
| M9 | P3–P5 (terseness, cache, statusline) | Upside beyond 0.777, each with its own delta |

**The order changed.** M1 was going to ship first as a one-line flip; it now
depends on M0 (the posture did not exist) and on M3 (its number does not exist).
So the sequence is M0 → M2 → M3 → M1, and the interim safety measure is no
longer free. Anyone who needs relief before M1 has `TOKEN_OPTIMIZER_MODE=off`
today, at the cost of the graph.

**`assist` is the only arm that may justify the flip, and its number does not
exist yet.** The 0.928 attributed to `MODE=off` is not a proxy for it: that arm
ran with retrieval, injection and harvest dead (§2.1), so it measured a
different product. `assist` carries the graph's overhead with the refusals
removed, which places its true cost somewhere between 0.928 and 1.633 —
unknown until M3 measures it. If `assist` does not beat `control`, M1 does not
ship and this document is wrong somewhere; that outcome gets published rather
than re-run.

M2 gates everything after it, because from M4 onward every exit criterion is a
number the harness produces. **M4 and M5
together are the path to first place; M6 and M7 are what let us hold it with the
differentiator switched on.** M8 runs in parallel from M3. M9 is upside.

The ordering is deliberate: we reach first place *with enforcement off* at M5,
then re-enable enforcement at M6–M7 under an invariant that forbids it from
costing what it cost before. That way the headline claim is never waiting on the
riskiest work, and enforcement returns as a measured feature rather than a
restored article of faith.

**Decomposition.** This is a program, not one plan. The first implementation
plan covers **M0, M2, M3 and M1, in that order** - build the posture, land the
harness, measure the posture, then ship it as the default on the number that
measurement produces. M4 onward each
get their own plan, because each is gated on a number the harness has not
produced yet: writing detailed steps for the debug-loop fix today would be
inventing them before the spike says what a hook can rewrite.

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
