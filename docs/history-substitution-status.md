# History substitution — where it stands

One page, kept current, because the work spans many sessions and the phase
numbering alone stopped saying anything useful. Every claim here names the
commit or the instrument it came from.

**The goal.** Send the model what its history was *carrying* instead of the
history itself. History is ~65% of a live request and the only part that grows
every turn.

**Status in one line.** The transform is built, deployable behind a flag, and
measured offline on the WHOLE request at **0.953 of control at 10 turns and
0.915 at 20, cheaper on 4 of 4 independent sessions** — beating the shipping
compressor (0.999) and plain thinking removal (0.916), conservative because
deferral is not modelled, and a lower bound because transcripts store no
reasoning text. The one thing still unmeasured is whether it costs the model
anything, and no offline instrument can answer that.

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
| 1a | Tool results compressed in history | **done, marginal** | adds 0.6–0.8pp at 40–200 turns |
| 1b | A removal primitive | **superseded** | substitution in place removes the need — `src/compress/history.ts` |
| 1c | Drop thinking, keep the model's own text | **measured, negative, kept off** | `c7a5b7c0` |
| 2 | Separate project knowledge from session state | **done** | the digest *is* the session distillation |
| 2b | Make the amortisation gate length-aware | **done, by a different route** | `assumedSessionTurns` dial; see below |
| 3 | `v4-substitute`, behind a flag | **done and reachable** | `TOKEN_OPTIMIZER_PROXY_SUBSTITUTE` |
| 4 | Campaign | **not run, deliberately** | see "Why no campaign" |

---

## What the transform does

`src/compress/history.ts`. Two regions, one rule.

- **Reasoning** (52% of history) — each message's `thinking` blocks are removed
  in place. Nothing is written back where the message still shows what it did:
  the `tool_use` blocks naming the tool and target are kept, and so is the
  model's own `text`. A `[reasoning elided]` marker is written **only** when
  removal would leave an empty message, which never occurred in 412 real
  messages but is a 400 if it does.
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
model: per turn, the longest byte-identical leading run charged at 0.1x,
everything after at 1.25x.

**Four independent real sessions, at THOL's own conversation lengths.**
Two denominators, because only one of them is the bill.

| turns | history region only | **whole request** | cheaper on |
| --- | --- | --- | --- |
| 10 | 0.826 | **0.953** | **4 of 4** |
| 20 | 0.772 | **0.915** | **4 of 4** |

The whole-request figure is the one to quote. A transcript records only
`messages`, so a replay over one prices history against history — while the real
bill also carries a system prompt and a full tool schema this transform never
touches. That region is measured, not assumed: on a first turn the conversation
is a single short prompt, so a first-turn request is essentially system + tools,
and across the ledger's 20 first-turn requests the median was 115,476 bytes
(~28,869 tokens). It is written once and re-read at 0.1x thereafter, identically
in every arm.

Per session at 20 turns, history region only: 0.631, 0.891, 0.849, 0.802.

**The whole-request figure is conservative in a known direction.** It does not
model deferral, which is on by default and shrinks the tool schema for our arm
and not for control. The deployed number therefore sits somewhere between the
two columns, nearer the right-hand one.

Against the other arms at 20 turns: `drop-thinking-all` 0.774, `v1-frontier`
0.997, and `drop-thinking-keep-newest` **1.141 — a loss**, which is the churn
mechanism showing up at benchmark length too.

Longer, on one session: 0.749 at 40 turns, 0.710 at 200, against
`drop-thinking-all`'s 0.757 and 0.716. **Substitution beats plain removal while
preserving the message structure removal destroys.**

**The value scales with conversation length**, because reasoning accumulates.
This is the single most important fact about the feature.

Also visible: **v1-frontier is nearly inert on real sessions** (0.997–1.000).
The compression shipping today barely touches this traffic.

### These are lower bounds

Session transcripts store `thinking: ""` — Claude Code keeps only the ~480-byte
signature and discards the reasoning text. So a replay over transcripts prices
the removal of **signatures**, not of reasoning. Live requests carry the text as
well, and the plan's own measurement put reasoning at 52% of history. Every
figure above therefore understates production by an unknown but positive margin.

### What these numbers still are not

Transmission cost, on one axis, with behaviour held fixed. They price only
`messages` — not tool definitions, not the system prompt — carry no
`cache_control`, and say nothing about whether the model still does the job.

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
3. ~~**Phase 2b**~~ — **done**, see below. It needed neither a decision nor a
   weakened gate; the plan had simply picked the wrong input.
4. **The knowledge budget sweep** — instrument ready, needs a seeded graph and
   real spend.
5. **The five losing tasks** — **answered offline**, see below.

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

---

## The five losing tasks — answered

Settled from the campaign's own database and ledger, with no new spend.

**They are the short tasks.** Control turns for the five losers are
[6, 8, 8, 10, 11], median 8; for the ten winners [10, 11, 13, 15, 17, 19, 19,
19, 24, 27], median 18. Rank correlation with the cost ratio (n=15,
`code-comprehension-django` excluded — its control ran only 2 turns, so every
ratio against it is unstable):

| predictor | Spearman |
| --- | --- |
| cache-write ratio | **+0.868** |
| task length in turns | **−0.668** |
| turn ratio | +0.546 |

**The mechanism is a large upfront cache write that short tasks cannot
amortise.** Excess cache writes against control, by task length:

| control turns | ≤8 | 10–11 | ≥13 |
| --- | --- | --- | --- |
| excess writes | **+9,352 to +13,953** | +1,210 to +3,101 | −14,029 to +1,693 |

The ledger locates it: `first-turn` requests carry a 45.3% write share against
3.8% for `left-alone`, and account for roughly 65% of every cache write in the
campaign. Over 13+ turns that is repaid by 0.1x reads. Over 6 it is not.

**So this is the same fact as the substitution result.** The proxy's entire
economics are length-dependent — it buys cheap reads later by paying an
expensive write now. The plan's hypothesis F was right: on a short conversation
the proxy should do LESS, not more.

### Two leads this turned up

**Byte accounting cannot see deferral.** `deferTools` adds `defer_loading: true`
rather than removing definitions — correct for the Anthropic beta, where the
server declines to place them in context — so the request GREW on 20 of 20
first-turn requests (+369 bytes of flags) while deferral reported saving 36,753
chars. `beforeBytes`/`afterBytes` therefore understates deferral to zero, and
any figure derived from them is wrong about it.

**Conversations re-classified as new — investigated, NOT a defect.** The ledger
showed 20 `first-turn` decisions in a 16-run campaign with 4 consecutive pairs,
which looked like a conversation being counted as new on its second request.
Replaying two real conversations turn by turn through `anchorDecision` gives
exactly **one** `first-turn` each, followed only by `extended` and
`already-anchored` — continuation is recognised correctly. The ledger is
append-only across runs and carries no run identifier, so an adjacent pair is
indistinguishable from the last request of one run followed by the first of the
next, which is what it almost certainly was. Closed.

---

## Phase 2b — the gate is length-aware, and the plan's route was wrong

The plan said to replace `MIN_PREFIX_REWRITE_SHARE`'s fixed 12.5% with the
break-even relation compared against **turns already observed**. Implemented,
that broke the STEADY gate on three of six workloads — re-anchoring COSTING
tokens on code-search (1066 vs 871), sre-debugging (2139 vs 1795) and
raw-build-log (17936 vs 15949).

**The cause was not the arithmetic. It was the input.** `steadyTokens` prices
turn two, and its cache hit requires turn two's prefix to be byte-identical to
turn one's. A threshold computed from turns-so-far necessarily differs between
two consecutive turns, so a conversation near the boundary declines the rewrite
on one turn and accepts it on the next — and that flip re-sends the entire
prefix at 1.25x instead of re-reading it at 0.1x. Any length-*derived* threshold
does this. The gate was enforcing the same append-only discipline the
substitution rests on, one level up.

**So the length-awareness moved to where it is stable**: `assumedSessionTurns`,
a tuning dial fixed for the life of a proxy like every other. The share is
`1.25 / 0.1 / assumedSessionTurns` — 12.5% at the default 100, and **96% at 13**,
which is the honest answer for a short workload: do not rewrite the prefix at
all. That is exactly what the five-losing-tasks analysis independently
concluded.

All four proof gates pass. 8 tests pin the arithmetic, the monotonicity, the
fallback for a nonsensical prior, and the safety property directly — that the
threshold is a function of configuration alone, so nothing a growing
conversation does can move it.
