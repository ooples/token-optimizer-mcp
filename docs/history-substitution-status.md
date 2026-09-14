# History substitution — where it stands

One page, kept current, because the work spans many sessions and the phase
numbering alone stopped saying anything useful. Every claim here names the
commit or the instrument it came from.

**The goal.** Send the model what its history was *carrying* instead of the
history itself. History is ~65% of a live request and the only part that grows
every turn.

**Status in one line.** The transform is built, deployable behind a flag, and
measured offline at 0.90–0.73 of control depending on conversation length. The
one thing still unmeasured is whether it costs the model anything — and no
offline instrument can answer that.

---

## Phases

| # | What | State | Evidence |
| --- | --- | --- | --- |
| −1.1 | Carry `scope` so a shared graph stops asserting other trees' facts | **done** | `6e178984` |
| −1.2 | Measure the knowledge budget instead of guessing | **instrument built; sweep not run** | `80c35405`, `bench/compression/knowledge-budget.mjs` |
| −1.3 | Refresh findings instead of reading once per process | **done** | `bb6213cb` |
| −1.4 | Recompute the knowledge block mid-conversation | **deliberately not done** | cache rules forbid it; reasoning in `bb6213cb` |
| −1.5 | Stop the harvest firing on a session's emptiest turn | **done** | `6b035a7b` |
| −1.6 | Stop staleness discarding transferable lessons | **done** | `4bac541f` |
| 0 | Does the API accept removing signed thinking? | **answered: yes** | `d7288056` |
| 1a | Tool results compressed in history | **done, marginal** | adds 0.6–0.8pp; see below |
| 1b | A removal primitive | **superseded** | substitution in place removes the need — `src/compress/history.ts` |
| 1c | Drop thinking, keep the model's own text | **measured, negative, kept off** | `c7a5b7c0` |
| 2 | Separate project knowledge from session state | **done** | the digest *is* the session distillation |
| 2b | Make the amortisation gate proportional | **blocked** | contradicts the STEADY gate; see below |
| 3 | `v4-substitute`, behind a flag | **done and reachable** | `TOKEN_OPTIMIZER_PROXY_SUBSTITUTE` |
| 4 | Campaign | **not run, deliberately** | see "Why no campaign" |

---

## What the transform does

`src/compress/history.ts`. Two regions, one rule.

- **Reasoning** (52% of history) — each message's `thinking` blocks are replaced,
  in place, by a digest built from that same message's own `tool_use` calls:
  `[earlier reasoning elided; this turn called Edit(src/cache.ts)]`.
- **Tool results** (36% of history) — compressed in place by a compressor the
  caller vouches is pure.

**The rule that makes it free:** transform every message the first time it is
seen, and never reconsider. The output for message *i* depends on message *i*
and nothing else — no floor, no turn count, no conversation state. So the prefix
only ever grows, the provider's cached copy keeps matching, and there is no
rewrite to amortise.

Two things the plan expected to pay for and we did not:

- The 1:1 message-count invariant holds, so the three tests that encode it needed
  no weakening.
- The plan's break-even arithmetic (`11.5 × after / removed` turns) does not
  apply at all. It priced a rewrite; there is no rewrite.

That second point also voids the plan's finding A, which concluded the feature
"stands or falls entirely on removing thinking" because tool-results-only would
need ~36 turns to repay. Under the append-only rule it repays immediately — it is
just small.

---

## What it costs, measured

`bench/compression/session-replay.mjs` — prices a whole session with the cache
model: per turn, the longest byte-identical leading run charged at 0.1×,
everything after at 1.25×.

Effective input vs control, one real session capped at each length:

| turns | 10 | 20 | 40 | 100 | 200 | 721 |
| --- | --- | --- | --- | --- | --- | --- |
| reasoning only | 0.901 | — | 0.776 | — | 0.735 | 0.719 |
| + tool results | 0.901 | 0.810* | 0.768 | 0.731* | 0.729 | 0.714* |
| v1-frontier (today) | 1.000 | 0.992 | 0.992 | — | 0.994 | 0.996 |

\* measured before the two halves were separable; the combined figure.

**The value scales with conversation length**, because reasoning accumulates.
This is the single most important fact about the feature.

Also visible: **v1-frontier is nearly inert on real sessions** (0.992–1.000).
The compression shipping today barely touches this traffic.

---

## Why no campaign

Two independent reasons, both measured rather than asserted.

**THOL measures this where it is worth least.** Its tasks run 8–26 turns. The
table above says that is the low end of the curve. A null there is not evidence
about a real session.

**The last campaign could not have resolved the effect anyway.** Its per-task
`cache_read` ratios against control were 0.47, 1.04, 0.44 and 2.38 at n=1 —
variance several times larger than the ~11% input saving being looked for. More
arms do not fix that; only reps, or a lower-variance metric.

Resolved along the way: the replay and the campaign appeared to contradict each
other (0.659 vs 0.885). They did not. They were run two orders of magnitude apart
in conversation length. Capped at the benchmark's own length the replay reports
0.886 against the campaign's 0.885. Three competing explanations were tested
against the campaign's run database and all three failed — output tokens *fell*
(0.827), tool calls per turn were unchanged, and the arm had never actually lost
to control (mean per-task cost 0.94; it loses to *deferral*).

---

## Open, in priority order

1. **Quality.** Does the digest lose something the model needed? Nothing offline
   can answer this. It is the only thing between here and a decision.
2. **A longer-session instrument**, since THOL cannot judge this feature.
3. **Phase 2b** needs a decision, not code: the plan's proportional gate permits
   an upfront cost that the STEADY gate forbids. Either the invariant stands and
   2b is wrong, or the gate is the thing to change. Not resolvable by weakening
   the gate.
4. **The knowledge budget sweep** — instrument ready, needs a seeded graph and
   real spend.
5. **The five losing tasks** — still unexplained, and out of scope for this
   feature by its own arithmetic.

---

## Known flake, unidentified

A single test in `tests/unit/compress` fails intermittently. Seen twice: the
full suite reported 4,268 passed on one run and 4,269 on the next with the same
total, and the compress subset reported 450 then 451. Nine isolated runs of that
subset have all passed, so it is not reproducible on demand and the failing test
has never been named in output.

Both observed failures occurred immediately after `npm run build` or
`prettier --write` had rewritten files, which suggests a test reading a
partially-written `dist/`. That is a hypothesis and nothing more — it has not
been tested, and it is recorded here so the next person to see a one-test
discrepancy does not start from zero.

Do not treat a green run as proof this is gone.
