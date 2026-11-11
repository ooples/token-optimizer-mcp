# How Token Optimizer compares

Measured head-to-head results against Alternative A, what this optimizer does that others do not, and where it loses. Back to the [README](../README.md).

## The short answer

**Does Token Optimizer win?** Yes, in every head-to-head below: it saves the most.
It also loses in a few specific places, listed under "Where it loses".

### Against other optimizers, on real coding tasks

Each product was installed and given the same coding tasks: 1,050 runs, measured
2026-09-03. Lower cost is better. Raw data and method:
[bench/ledger/RESULTS-COMPETITORS.md](../bench/ledger/RESULTS-COMPETITORS.md).

| Optimizer                      | Cost vs. plain Claude Code | Result                                   |
| ------------------------------ | -------------------------- | ---------------------------------------- |
| **Token Optimizer**            | **33.6% cheaper**          | ✅ **Best**                              |
| Tokenade (its rules text only) | 22.9% cheaper              | Their product needs an account, so only their rules text was tested |
| tokenjuice                     | 13.6% cheaper              | Real saving, about two-fifths of ours    |
| claude-token-optimizer         | No measurable change       | Its hooks did not run on Claude Code 2.1.251 |

### Against Alternative A, on compressing tool output

<!-- ALT-A-CORPUS:START -- every figure between this marker and the next
     CORPUS:END must appear in `totals` of
     `bench/compression/alt-a/results/head-to-head.json`. Guarded by
     `node bench/compression/readme-alt-a.check.mjs`; do not hand-edit. -->

Alternative A is a widely used compression proxy. It was run on its own fixtures
with its own harness, so this is its home benchmark. **The proxy removes 91.5% of
the tokens; their best setting removes 61.4%.** The proxy is also cheaper on
**18 of 18** workloads when nothing it moved out is read back, and on 17 of 18
when all of it is. ✅ **Win.**

<!-- ALT-A-CORPUS:END -->

### What else it does for you

- ✅ **Subscription plans go further.** It detects whether you pay per token or by
  subscription. On a subscription it optimizes for finished work per unit of quota.
  It spends leftover 5-hour capacity only while your week is on pace. Limit monitors
  show your usage; this acts on it. Details: [quota pacing](#learned-cost-control-pruning-loop-guard-holdout-and-the-quota-you-actually-pay-with).
- ✅ **Remembers what earlier sessions worked out**, so the agent does not re-derive it.
- ✅ **Re-reading an unchanged file returns only what changed.**
- ✅ **MIT licensed, 16 clients, nothing leaves your machine.** See [the table at the end](#honest-comparison).

### Where it loses

- ⚠️ **Without the proxy**, the compressor removes fewer tokens than Alternative A
  on 8 of 18 workloads. On those, Alternative A moves content out of the request
  instead of shrinking it. The proxy does the same, and wins.
- ⚠️ **In the four-product run, most of the saving came from the rules file.** The
  hooks added no measurable cost saving on top of it.
- ⚠️ **Every sample is small.** Treat the figures as directions with intervals,
  not guarantees.

Everything below is the full detail behind these answers.

## How it compares to Alternative A

Providers cache the prompt prefix: cached tokens re-read at **0.1x**, rewritten
ones bill at **1.25x**. Most compressors optimise bytes removed and ignore that
multiplier. This one optimises the bill.

**Measured against their real implementation, on their own fixtures.** Not a
reimplementation and not our fixtures: their harness compresses the payload,
dumps it, their resolver redeems their own markers, and ours is handed the
identical bytes. Their column is the best of the nine configurations that
capture holds, row by row.

Two of our arms are in the table, and they answer different questions. **`ours`**
is the block engine with nowhere to move a block, which is how the MCP tools and
the hooks run: everything it removes, it removes by compressing, and nothing
leaves the request. **`ours, proxy`** is the proxy a Claude Code session runs
through, which also moves a block it could not compress out to a file and
leaves a marker naming the path -- the same kind of trade their content-cache
reference makes. `ours, preset` is the block engine with that move switched on
at `spillWholeBlockBelow: 0.9`.

<!-- ALT-A-TABLE:START -- every figure below must appear in
     `bench/compression/alt-a/results/head-to-head.json`. Written by
     `node bench/compression/readme-alt-a.render.mjs` and guarded by
     `node bench/compression/readme-alt-a.check.mjs`; do not hand-edit.
     Each figure cell is `characters / tokens` removed, tokens counted by
     Anthropic's tokenizer over both arms' real output. `zero-turn ids` is
     `ours / theirs / preset`: of the identifiers planted in that workload,
     how many the agent can have without spending a turn -- in the text, or
     rebuilt from the text alone.
     -->

| workload             | payload |        theirs |          ours |   ours, proxy |    ours, preset |    zero-turn ids |
| -------------------- | ------: | ------------: | ------------: | ------------: | --------------: | ---------------: |
| agentic-conversation | 244,908 | 37.3% / 33.4% | 42.9% / 30.8% | 52.4% / 49.0% | 100.0% / 100.0% |  2099 / 2099 / 0 |
| agent-loop           | 170,938 | 42.2% / 54.3% | 69.3% / 59.1% | 92.0% / 94.1% |   93.6% / 94.3% |   185 / 185 / 52 |
| agent-loop-logs      | 327,500 | 51.5% / 53.0% | 61.9% / 58.1% | 88.7% / 91.5% |   96.2% / 97.0% | 2034 / 2034 / 81 |
| api-responses        |  49,127 | 88.2% / 89.3% | 66.6% / 59.1% | 96.4% / 96.8% |   96.6% / 96.8% |    699 / 98 / 23 |
| browser-session      | 781,774 | 21.7% / 13.1% | 93.7% / 26.5% | 55.5% / 90.2% |  100.0% / 99.9% |    334 / 334 / 0 |
| code-search          | 131,264 | 47.4% / 59.7% | 81.8% / 70.8% | 97.7% / 97.9% |   95.7% / 96.1% |   201 / 201 / 43 |
| database-rows        |  45,929 | 88.6% / 89.2% | 65.6% / 56.5% | 92.4% / 93.1% |   92.6% / 93.4% |    590 / 78 / 49 |
| codebase-exploration | 137,961 | 99.7% / 99.7% | 16.0% / 12.7% | 99.6% / 99.6% |  100.0% / 99.9% |      540 / 3 / 0 |
| grep-output          |  75,219 | 99.6% / 99.6% | 56.1% / 51.9% | 99.5% / 99.6% |   99.9% / 99.9% |     1005 / 3 / 0 |
| log-entries          |  91,385 | 80.8% / 83.2% | 63.5% / 52.0% | 95.4% / 95.7% |   95.5% / 96.0% |  1180 / 237 / 46 |
| human-authored-json  |  37,425 | 30.6% / 30.0% | 66.6% / 66.0% | 81.6% / 83.7% |   96.7% / 96.9% |   154 / 154 / 11 |
| issue-triage         | 109,354 | 53.1% / 55.2% | 88.1% / 85.7% | 97.2% / 97.6% |   95.1% / 95.7% |     59 / 59 / 21 |
| rag-conversation     | 171,913 |   0.0% / 0.1% | 84.6% / 83.2% | 99.1% / 99.4% | 100.0% / 100.0% |      42 / 42 / 0 |
| raw-build-log        | 158,057 | 99.8% / 99.8% | 70.6% / 48.2% | 99.7% / 99.8% | 100.0% / 100.0% |      430 / 3 / 0 |
| relevance-probe      |  49,157 | 64.1% / 71.0% | 82.4% / 77.2% | 97.1% / 97.8% |   95.8% / 96.6% |   225 / 225 / 13 |
| search-results       |  96,647 | 95.0% / 95.4% | 74.3% / 59.4% | 96.5% / 96.5% |   96.6% / 96.6% |    505 / 62 / 34 |
| repeated-reads       | 158,285 | 37.4% / 30.4% | 71.7% / 68.5% | 99.5% / 99.6% | 100.0% / 100.0% |    394 / 388 / 0 |
| sre-debugging        | 312,276 | 88.4% / 89.9% | 67.4% / 62.4% | 98.5% / 98.7% |   97.1% / 97.5% |  3116 / 506 / 82 |

Recorded 2026-10-17 at `b1231a8c`, by the command in the
record's `regenerate` field, over Alternative A's own fixtures and harness. That arm runs
Alternative A itself, so CI does not re-derive it -- it checks these figures and
this provenance against the record instead.

<!-- ALT-A-TABLE:END -->

<!-- ALT-A-CORPUS:START -- every figure between a CORPUS:START and its CORPUS:END
     must appear in `totals` of
     `bench/compression/alt-a/results/head-to-head.json`. Guarded by
     `node bench/compression/readme-alt-a.check.mjs`; do not hand-edit. -->

Over the corpus the proxy removes **82.5%** of the characters and **91.5%** of
the tokens; their best configuration removes 51.5% and 61.4%. It is cheaper than
their best arm on **18 of 18** rows when nothing is ever fetched back, which is
the end of the range their markers are built for, and on 17 of 18 when every
moved block is fetched back. The block engine alone removes
72.0% and 55.9%: more of the characters than theirs, fewer of the tokens.

<!-- ALT-A-CORPUS:END -->

**Where they still win, and why.** On `codebase-exploration`, `grep-output`,
`raw-build-log`, `sre-debugging` and the four raw-data rows their best arm takes
83.2-99.8% off the tokens and the block engine 12.7-62.4%. Their number there is
a **content-cache reference**: the block is not made smaller, it is taken out of
the request, put in a store, and replaced by a `<<ccr:hash,kind,size>>` marker.
An engine with nowhere to put a block cannot match that, so on those rows the
`ours` column loses on reduction, and on cost when nothing is fetched back. The
proxy makes the same move: it is ahead of them on five of those eight rows, level
on `grep-output` and `raw-build-log`, and a tenth of a point behind on
`codebase-exploration`. The one row where the proxy costs more than they do is
`agentic-conversation`, and only when every block it moved is fetched back:
they move none of that conversation out, so they cost the same at either end,
while the proxy moves part of it and pays a retrieval for each part it wants
back.

<!-- ALT-A-CORPUS:START -->

**The other column is a turn.** A marker is not the content: to read what it
stands for, the agent spends a request. Of the 13,792 retention units planted in
the corpus, the block engine keeps 5,223 in the text and 8,569 more rebuildable
from the text alone, so every one of them is there with no extra turn; theirs
keeps 6,711 in the text and 7,075 behind its store, one retrieval call away.
**0 are unrecoverable on our side and 6 on theirs.** Their best arms force 17
round trips across the corpus to get their content back; the block engine
forces 0. The proxy, like theirs, trades a turn for every block it moves, and
that turn is what the fetch-rate end of the cost model prices.

<!-- ALT-A-CORPUS:END -->

**What their marker costs is priced, not just its size.** Their marker is only
redeemable because their proxy also sends a `alternative_a_retrieve` tool with the
request -- on by default (`ccr_inject_tool`), and on every later request once a
session has used it -- so every row where their best arm leaves a marker is
charged for that tool's definition as well, recorded from their own package by
`bench/compression/alt-a/ccr-tool.py`. The turn that first adds the tool also
rewrites the whole cached prefix behind it; that is not charged, which errs in
their favour. Ours needs no tool: our marker names a path the agent opens with
the `Read` it already has, and the path is priced at the length the proxy really
writes (`<home>/.tok/<pid>/<15 digits>`, src/compress/spill-path.ts) rather than
a shorter invented one.

**`browser-session` is mostly the fixture.** This payload holds four images, two
of them distinct, and the base64 in them is generated rather than photographic:
one distinct image alone folds from 160,032 characters to 5,572, which no real
PNG would do. What carries over to a real session is the duplication -- half the
image bytes are a second copy of an image already in the request, which is
44.3% of the whole payload. The run the marker names is still in the output
above it, so the reader rebuilds it without asking for anything, which is why
the characters fall much further than the tokens: the image tokens are counted
from pixels on both arms either way.

Reproduce the whole table:

```bash
python bench/compression/alt-a/run-theirs.py <alt-a-clone> <out-dir>

python bench/compression/alt-a/resolve-theirs.py <alt-a-clone> <out-dir>
node bench/compression/head-to-head.mjs <out-dir>
```

### Against their published design

A second arm reimplements their published design from their own benchmark
generator's definitions — opaque hash markers, history compressed, a retrieval
tool and system message injected — so the four workloads with a published
comparator can be checked without their clone. `node bench/compression/proof.mjs`:

<!-- PROOF-TABLE:START -- every figure below must appear in the output of
     `node bench/compression/proof.mjs`. Guarded by
     `node bench/compression/readme-table.check.mjs`; do not hand-edit. -->

| workload             | payload | theirs |  ours | verdict |
| -------------------- | ------: | -----: | ----: | ------- |
| code-search          |   17765 |  92.1% | 97.8% | ours    |
| sre-debugging        |   65694 |  92.2% | 98.6% | ours    |
| issue-triage         |   54174 |  72.8% | 97.5% | ours    |
| codebase-exploration |   78502 |  47.4% | 54.7% | ours    |

<!-- PROOF-TABLE:END -->

Four workloads, because those are the four this arm has a published comparator
for. The head-to-head harness scores eighteen; the other fourteen are not in
this arm, and are scored against their real implementation in the table above.

**`codebase-exploration` was theirs and is now ours, by 7.3 points.** An earlier
version of this table claimed 61.3% for us on that row, then parity, then a
published loss at 46.0% against their 47.4%. The first two were figures from a
branch rather than from here; the third was true on this tree when it was
written; four `log` engine commits then moved it to 54.2%, masking an interior
hashbang so a concatenated block still parses moved it to 64.9%, and
authenticating every marker with a six-character stamp took 0.2 of a point
back, and naming a spilled file by a digest of its contents, the way the proxy
sink really names it, instead of by its position in a counter, took another
half point, to reach 64.2%. Then the currency stopped being an estimate: every
figure in the table above is now the count Anthropic's own tokenizer returns
for the text, recorded into a committed fixture so this stays offline, and
under it the row reads **53.7%**, and pricing the path the proxy's sink really
writes -- content-addressed and decimal, where this arm had invented a 32-digit
hex name -- moved it to **54.7%**. That is the largest move in this history and
the only one that is not about the engine at all. Dividing characters by four
had been charging the control's hex markers too much and our own stamp far too
little -- the stamp was six characters of a vowelless base-31 alphabet then,
and a random string over a large alphabet is close to the worst case a BPE
tokenizer has, so it cost a measured 5.52 tokens where chars/4 billed 2. Those
three are the only figures here that moved the wrong way, and none of them is a
regression: each is the harness charging us for something it had been leaving
out. Being able to see that cost is what paid for the next move: the stamp is
now nine decimal digits, which carry slightly more entropy than those six
characters did and cost 4 tokens on every draw rather than a mean of 5.52 that
ranged from four to seven. Measured against the old stamp on this row -- the
same tree, the same fixture, only the stamp pinned back to its base-31 form --
that bought **a tenth of a point**, and a tenth is the honest size of it: a
marker got better than a quarter cheaper, but markers are a small part of what
the engine emits, so the headline moves far less than the per-marker saving
suggests. A
number in prose is a fact about the tree it was measured on, which is why
`bench/compression/readme-table.check.mjs` re-derives every figure in the block
above from the harness rather than trusting it.

Against the four comparators in this reimplemented arm: **ours on all four.**
Against their real implementation the answer is the table at the top of this
section, and it is a split rather than a sweep: the proxy is cheaper than their
best arm on every row when nothing is fetched back and takes more of the tokens
overall, while the block engine alone keeps every identifier without a turn and
loses on reduction wherever their best arm moves a block out of the request.

The two columns come from different arms of the same engine, and that is the
point. `v3-history` compresses history too and matches them byte for byte;
`v1-frontier` leaves the cached prefix alone and wins the invoice by 11–42%.
Maximising bytes removed is available and is not the default, because on a
cached prefix it costs money.

The competitor arm is this repository's reimplementation of their published
design — opaque hash markers, history compressed, a retrieval tool and system
message injected — not their binary, and it is held to the same signed-content
guard we hold ourselves to.

### On whole sessions

`node bench/compression/session-replay.mjs` replays real recorded conversations
turn by turn and prices each the way a provider does. Four independent sessions,
whole request including system prompt and tool schema, against no proxy:

| conversation length | **ours**   | cheaper on |
| ------------------- | ---------- | ---------- |
| 10 turns            | **0.953x** | **4 of 4** |
| 20 turns            | **0.915x** | **4 of 4** |

This is the region nothing else touches: conversation history is ~65% of a live
request and the only part that grows every turn. The saving grows with session
length, because model reasoning accumulates.

### On end-to-end agent tasks

THOL, 16 real tasks against a no-proxy control:

- **cheaper on 11 of 16 tasks**
- **median cost 0.926x**, **median turns 0.671x**
- **zero quality cost**: mean score **0.994** against control's **0.994**,
  lower on **0 of 16 tasks**

One run per task, so the aggregate interval still spans 1.0; the per-task tally
and the score parity are the solid parts. Every figure here is regenerated from
the committed benchmarks, which ship in this repository.

## What it does that other optimizers do not

### Compression that does not break the cache, or lose the needle

An optional local proxy compresses tool results, search output, logs and
conversation history on the way to the model. A hook cannot do this: the
`PostToolUse` output schema is `{hookEventName, additionalContext?,
classifierContext?}` and `updatedOutput` occurs nowhere in the client, so a hook
can add context but never replace a result. The proxy never tries to -- it
rewrites the outbound request, where those results already sit as history.

Two things make it different from simply compressing harder.

**It never rewrites cached content.** A cached prefix bills at 0.1x and a cache
write at 1.25x, so compressing history can cut tokens while multiplying the
bill. Measured on our own benchmark: compressing behind the cache breakpoint
removes more raw tokens on every workload and costs more money on every
workload. Compression stops at the frontier, and cache-weighted tokens are
reported beside raw ones so the trap is visible rather than inferred.

<!-- PROSE-CLAIMS:START -- every percentage in the prose between this marker and
     its END must also appear inside a guarded block above, or be declared in the
     registry in bench/compression/readme-prose.check.mjs saying where it comes
     from. Run `node bench/compression/readme-prose.check.mjs`. -->

**It keeps the rows that matter.** Eliding a long array after the first few rows
scored 95.7% on a search payload here and destroyed both the UUID record and the
error record planted in it -- the only two rows anyone would have searched for.
The engine now keeps every row that departs from the shape, wherever it sits:
92.4% with the needles intact. A gate in the benchmark fails the build if a
planted needle disappears, because a size metric alone cannot tell compression
from truncation.

Reduction over the content each strategy is permitted to rewrite, on fixtures
matching the four workloads Alternative A publishes, is the guarded table earlier in
this section -- 97.5%, 97.8%, 98.6% and 54.7% against their 72.8%, 92.1%, 92.2%
and 47.4%. It is stated once and checked there rather than restated here, which
is how this copy came to claim 98.9%, 98.2%, 92.8% and 61.3% long after the
tree had moved.

<!-- PROSE-CLAIMS:END -->

These are not their corpora, which are unpublished; the code workloads read real
files out of this repository and the rest are generated to the shape and scale
of their published ones, from their own benchmark generator's definition.

**Reduction is not the bill, and the two disagree.** Cache changes the
arithmetic: a cached prefix is re-read at 0.1x and a rewritten one is charged at
1.25x, so an arm can remove more bytes and still cost more. Run
`node bench/compression/proof.mjs` and that is exactly what happens -- the
Alternative A-style arm removes a larger share of every workload and loses on
cache-weighted effective tokens on all of them:

| workload        | raw reduction, ours / theirs | effective tokens, ours / theirs |
| --------------- | ---------------------------- | ------------------------------- |
| code search     | 84.6% / **95.8%**            | **999** / 1,383                 |
| SRE debugging   | 86.2% / **97.1%**            | **1,833** / 2,261               |
| issue triage    | 89.2% / **95.3%**            | **812** / 1,277                 |
| grep output     | 45.9% / **51.9%**            | **7,146** / 9,514               |
| raw build log   | 54.7% / **59.4%**            | **14,448** / 16,769             |
| browser session | 45.7% / **49.4%**            | **11,398** / 14,685             |

The competitor arm is this repository's own reimplementation of their published
design -- opaque hash markers, history compressed, a retrieval tool and system
message injected -- not their binary. It is implemented to win where it can: the
raw column is theirs on six of six.

**On whole sessions.** `node bench/compression/session-replay.mjs` replays real
recorded conversations turn by turn and prices each one the way a provider does,
charging the longest byte-identical leading run at 0.1x and everything after at
1.25x. Four independent sessions, whole request including system prompt and tool
schema, against no proxy at all:

| turns | Alternative A's design | ours (v4-substitute) | cheaper on |
| ----- | ----------------- | -------------------- | ---------- |
| 10    | 1.000x            | **0.953x**           | 4 of 4     |
| 20    | 0.999x            | **0.915x**           | 4 of 4     |

The replay uses stored transcripts, which discard reasoning text while retaining
signatures. Its savings therefore do not establish that useful reasoning survives
compression. It also uses our reimplementation of the competitor's design;
these are offline estimates, not results from their shipped proxy.

**Live comparison against Alternative A's shipped proxy.** The balanced four-arm run
recorded in commit `f712b4ec` used `bench/live/ab.sh`, rotated each arm through
every position, and re-ran pytest independently after each task:

| arm                                                      | mean weighted input tokens | tests passed |
| -------------------------------------------------------- | -------------------------: | -----------: |
| uncompressed control                                     |                    134,706 |          4/4 |
| Token Optimizer, previous 1,500-character deferral floor |                    100,818 |          4/4 |
| Token Optimizer, zero floor (now the default)            |                     49,053 |          4/4 |
| Alternative A shipped proxy                                   |                     48,626 |          4/4 |

Weighted input is `input + 1.25 * cache_creation + 0.1 * cache_read`; it excludes
output cost. Both zero-floor Token Optimizer and Alternative A reduced that measure
by about 64% versus control. Token Optimizer used about 0.9% more than Alternative A.
This small arithmetic repair task does not establish superiority across tasks,
compression quality, or total cost. Rotation balances run position, but does
not guarantee that shared provider-cache effects disappear.

**Codex three-task comparison against Alternative A (2026-09-18).** Three
synthetic controlled-read tasks, three repetitions, three arms, every arm in
every position. All 27 runs returned the correct answer, so this compares cost
at equal correctness rather than accuracy. Alternative A ran in `--mode token`, its
compression-first setting, not the `cache` default that exists to freeze the
cache hit rate.

| arm                             | mean input tokens | of which cached | output | requests | agent seconds |
| ------------------------------- | ----------------: | --------------: | -----: | -------: | ------------: |
| uncompressed control            |            55,632 |          43,079 |    200 |      3.0 |          19.1 |
| Token Optimizer                 |            42,468 |          33,052 |    189 |      3.0 |          17.3 |
| Alternative A, `--mode token` |            71,626 |          51,897 |    285 |      4.3 |          27.3 |

Input reduction against the control was 22.7% on the log task, 34.3% on the JSON
task and 11.5% on the code search; against Alternative A, 54.9%, 10.0% and 42.2%.
Every task favoured this proxy on both comparisons, and the JSON column is where
Alternative A is strongest and the margin thinnest.

The mechanism is visible in two numbers that move independently. Mean input per
REQUEST was 14,156 here against Alternative A's 16,529 and the control's 18,544 --
both proxies compress, and this one compresses harder. Mean requests per RUN was
3.0, the same as the control, against Alternative A's 4.3. A compressor that elides
content the agent then has to read back spends a turn recovering it, and on
these workloads a turn costs more than the elision saved; that is the failure
this project's own deferral floor exists to avoid, and it is what the extra
1.3 requests are.

WHAT THIS DOES NOT SHOW. These are token counts, not dollar costs, and
`bench/live/report-codex.mjs` deliberately declines to price them. Three short
synthetic workloads do not establish a universal win. Each task ran in a fresh
temporary workspace with no knowledge graph, so graph injection contributed
nothing and this measures compression alone. Cached tokens are a subset of the
input column, not an additional charge. Alternative A's compression is scored from
provider usage rather than byte counts recorded at our own listener.

Reproduce with `ALT_A_MODE=token node bench/live/codex.mjs`, then
`node bench/live/report-codex.mjs <evidence-dir>`; the figures above were read
only after that reporter returned `valid: true` with `balanced: true` and no
failures. Four earlier campaigns were discarded rather than published: one ran
without Alternative A's `[proxy]` extra so every Alternative A run errored before
readiness, one ran Alternative A in its `cache` default, one was voided by the
reporter for an incomplete request capture, and one died on `ENOSPC` with the
host disk full.

The subsequent Claude Code default-versus-aggressive confirmation hit Claude's
weekly usage limit and is incomplete. Its missing usage cannot count as a win.
Codex validation runs independently through the Responses API.

**Latest Codex joint confirmation (2026-09-16).** The frozen twelve-family study
completed 120 pairs against installed Alternative A. Our proxy passed 119/120
attempts; Alternative A passed 120/120. One local allocation crash left unknown usage.
There were **77 strict joint wins** (passing, cheaper, and faster), 20 cost-only
losses, 12 speed-only losses, nine losses on both measures, one equal-time pair
that cost more, and the failed attempt. Across the **119 fully measured pairs
only**, estimated token cost was 26.9% lower and agent time 30.1% lower. JSON
agent time was 5.6% higher. Only logs and refactoring met the simultaneous
per-family criteria; the complete-study superiority gate failed. These results
do not establish that every task is cheaper or faster. The measured build
preserves explicit nulls, retains complete numeric tables, and avoids copying
unchanged payloads. See the [full results, every loss, and retained crash](../bench/live/evidence/joint-confirmation-2026-09-16/README.md).

**Earlier expanded local Codex confirmation.** A preregistered seven-family study ran
70 pairs / 140 attempts against installed Alternative A. Our frozen proxy
passed 70/70; Alternative A passed 69/70 with one upstream HTTP 503 and missing usage.
The complete-ledger gate therefore failed: **superiority was not established**.
Across the 69 fully measured pairs only, descriptive totals were 25.7% lower
estimated cost, 38.9% lower input, and 30.0% lower agent time for our proxy.
JSON remained a loss (35.1% higher estimated cost). See the
[protocol, all attempts, and limitations](../bench/live/evidence/confirmation-2026-09-15-v2/README.md).

A subsequent rare-string-group fix targets that JSON loss. In three fully measured
fresh pairs, input fell 17.7%, estimated cost 13.4%, and agent time 13.6% versus
Alternative A, with three requests each. A fourth pair had a retained upstream 503 on
our arm; one measured pair still cost more. These are development results, not
confirmation of the new build or an all-workload win. See the
[complete screen and exclusions](../bench/live/evidence/json-categories-2026-09-16/README.md).

**Current amended Codex study.** The next fixed 70-pair schedule completed:
our proxy passed 69/70 and Alternative A 70/70. Our remaining attempt hit an upstream
503 with unknown usage, so strict superiority was not established. Across the
69 fully measured pairs only, estimated cost was 27.9% lower, input 44.2% lower,
and agent time 31.7% lower. Every family's mean cost favored our proxy, including
JSON at 27.5% lower, but 13 individual pairs still cost more. The run includes a
disclosed repair to a between-case file-hashing failure; the original product and
schedule stayed fixed. See the [full results, amendment, and retained failure](../bench/live/evidence/confirmation-2026-09-16-v3-continuation/README.md).

**Exact search rows, subsequent development.** Factoring shared declaration syntax
while preserving every identifier and value closed the code-size gap: 37.5% fewer
bytes than archived Alternative A on the original 40 losing inputs. Eight fresh local
cases also sent fewer bytes. Four balanced live pairs all passed their audits;
our estimated token cost was 50.1% lower, input 44.8% lower, and agent time 51.1%
lower. This is a small development follow-up, separate from the broader study.
See the [captured bodies, reconstruction checks, and live evidence](../bench/live/evidence/search-columns-2026-09-16/README.md).

**Cost-loss follow-up (2026-09-16).** We investigated all 13 losing pairs and
implemented exact ID-prefix factoring plus support for records inside truncated
shell envelopes. A fixed follow-up of those 13 cases passed all 26 attempts;
12 pairs favored our proxy, with 33.4% lower total estimated cost. The remaining
loss exposed the outer-envelope bug. After fixing it, two balanced controlled
pairs both favored our proxy: all four attempts passed, estimated cost was 34.3%
lower, and input was 15.9% lower. These development runs retain every original
loss; cache and model variation also affect results. See the [case-by-case audit,
fixes, exact replay, and live evidence](../bench/live/evidence/cost-losses-2026-09-16/README.md).

**Local proxy performance (2026-09-16).** Against installed Alternative A,
2,160 completed local-upstream requests covered repeated and unique logs, JSON,
and code-search output in three rotated arm orders. Our mean latency and process
CPU were lower in all six groups. Sampled peak process-tree private memory was
80.0 MiB versus 1,909.9 MiB; this is footprint, not allocation volume. Unique
code still forwarded 5.7% more bytes. Alternative A's rate limit was disabled for this
throughput measurement; compression settings stayed default. These measurements
do not measure model quality or billed cost. See the
[raw samples, reproduction commands, and limitations](../bench/live/evidence/local-proxy-performance-2026-09-16/README.md).

**Live Codex comparison (2026-09-15).** Local Codex CLI 0.154.0, `gpt-6-astra`,
and installed Alternative A completed a balanced 27-run campaign. All three
arms passed all nine tasks; every initial read was complete, and all provider
ledger totals matched Codex's reported usage.

| workload            | mean input, ours | mean input, Alternative A | reduction vs Alternative A |
| ------------------- | ---------------: | -------------------: | --------------------: |
| JSON outlier lookup |           39,318 |               44,043 |                 10.7% |
| code search         |           44,427 |               82,697 |                 46.3% |
| log diagnosis       |           39,203 |               84,308 |                 53.5% |

These counts include cached input and extra retrieval turns; they are not raw
compression percentages or dollar costs. Output tokens did not improve on every
workload. See the [Codex evidence and limitations](../bench/live/evidence/codex-2026-09-15/README.md)
and [reproduction instructions](../bench/live/README.md). These three synthetic tasks
do not establish superiority across all workloads.

A separate **27-run natural-workflow development screen** passed all runs and
measured 35.5%, 43.5%, and 16.6% less total input than installed Alternative A for retry
bug fixes, multi-file refactors, and configuration refreshes. These are small
synthetic repositories with natural tool selection. Uncached input and latency
have separate results; see the [workflow evidence and limitations](../bench/live/evidence/codex-workflows-2026-09-15/README.md).

The proxy is enabled by default and binds loopback only.

**It is now on without launching anything through us.** Until 7.1.0 the only way
to be routed was to start the client through our wrapper, so anyone who installed
with `/plugin` and then opened Claude Code from a shortcut, an IDE or the desktop
app saved nothing -- and the doctor reported that as a broken installation rather
than as a feature that never applied. Installation now writes the endpoint into
Claude Code's own `settings.json`, which is the one thing a session we did not
start will read, and a small background proxy serves it. Four rules make that
safe to switch on:

- **Recorded.** Every value written is stored with whatever was there before.
  `token-optimizer-uninstall --apply` restores it exactly, and refuses when the
  value is no longer the one we wrote -- if you change it, it is yours again.
- **Never written on hope.** The entry appears only after the proxy has actually
  served the route. A settings file naming a dead port does not degrade politely:
  the client cannot reach its provider at all.
- **Self-healing.** The check runs again at every session start, before the first
  model request, and removes the entry the moment the route cannot be served.
- **Hands off what is not ours.** A client already pointed at another local proxy
  is left alone, and a settings file we cannot parse is never rewritten.

Set `TOKEN_OPTIMIZER_DEFAULT_ROUTING=0` to keep the wrapper-only behaviour, or
`TOKEN_OPTIMIZER_PROXY_AUTOSTART=0` if you do not want a local background service
at all. Either one also undoes an entry already written.

**Managed commands.** Global npm installs activate Claude hooks and wrap the
client commands you actually have -- `claude`, `codex`, `gemini`, `opencode`,
`qwen`, `crush`, `droid`, `cn` (Continue), `copilot` and `amp` -- in Command
Prompt, PowerShell, Bash, and Zsh when lifecycle scripts are enabled. Only
commands already on your PATH are wrapped, so installing this does not claim a
name for a client you have not installed; `TOKEN_OPTIMIZER_MANAGED_CLIENTS` takes
a comma-separated list (or `all`) when a client lives somewhere PATH cannot see,
and `0` skips shell activation entirely. Windows installs add owned `.cmd`
launchers to the User PATH, so profiles and PowerShell execution-policy changes
are not required. For local installs or disabled lifecycle scripts, run
`token-optimizer-install`. Reopen the terminal to load the updated PATH and shell
activation. Each managed session starts its own proxy, registers the packaged
core MCP tools (including wiki), and shuts the proxy down on exit.
`token-optimizer-run <client> ...` works without shell activation.

**Which clients can be routed, and which cannot.** Ten have a supported way to
redirect model traffic and are listed above. Claude Code and Gemini have exactly
one provider each, so they are routed on installation. The rest choose a provider
in their own configuration, and are routed once that configuration names an
endpoint -- because forwarding on a guess would deliver one provider's
credentials to another company. Six clients cannot be routed at all: Cursor,
Cline, Windsurf, Kilo, Roo and Zed run the assistant inside the editor process
and expose no documented redirect. Everything else -- the optimizer tools, the
graph, the hooks -- still applies to them, and the doctor states the limitation
instead of counting it as a failure.

`token-optimizer-route` shows what is running and what configuration has been
written on your behalf. Zed is the one client that can be routed and cannot be
routed for you -- its provider is a named entry you pick inside the editor, and
only you know which endpoint and model it should use:

```bash
token-optimizer-route                                                  # what is routed right now
token-optimizer-route zed --upstream https://api.openai.com/v1 --model gpt-4o
token-optimizer-route zed --remove
```

Zed's provider schema here comes from its published settings documentation and
has not been exercised against an installed Zed in this repository. It is
written into a file the command can take back out, and nothing is written unless
the route is already being served.

Existing custom provider authentication stays in the client, and your own
endpoint stays yours: the proxy is inserted in front of whatever you configured,
never in place of it. `TOKEN_OPTIMIZER_PROXY=0` disables routing and
`TOKEN_OPTIMIZER_MODE=off` disables optimization. npm lifecycle scripts may be
blocked, so package installation alone is not proof that activation ran.
OpenCode's session plugin uses its resolved configuration and project directory;
account credentials and provider files stay in place. Unsupported endpoints and
provider modes retain native routing. Claude routing controlled by local
managed-policy files or Windows registry policy also stays native. Remote/MDM
policy can arrive after launch; the launcher reports observed model traffic, not
just listener startup.
`doctor` checks routing configuration.
Request-body capture is opt-in via `TOKEN_OPTIMIZER_PROXY_CAPTURE`; when enabled,
it writes plaintext request content to the named directory.
Capture queues are bounded to 128 requests and 16 MiB of queued snapshots and
metadata. Excess captures are rejected with a warning while requests continue;
live audits reject incomplete capture evidence. See the
[allocation hardening and follow-up results](../bench/live/evidence/allocation-hardening-2026-09-16/README.md)
for the reproduced OOM fix, constrained-memory replay, and remaining cost losses.

Your provider key is forwarded in the request headers and is never read, stored
or written by the proxy. That is a narrower claim than "nothing sensitive is
written", and the difference matters: the proxy does write _message content_ to
disk, described next, and it does not inspect that content for secrets. If a
secret is in your conversation, it can reach a spill file the same way any other
text does.

It will not reach an unencrypted network, though: an upstream that is neither
`https` nor loopback is refused rather than forwarded to, and with no upstream
configured the proxy serves only Anthropic's own routes -- so a client for a
different provider is told to name its provider rather than having its key sent
to the wrong company.

**It does write some payload to disk, and you should know exactly when.** An
elision has to name a way back to what it removed, and content that arrived in a
tool result has no file of its own -- so that content is written to a _spill
file_ and the marker names its path. This happens only when an engine actually
elides something recoverable-by-path: a JSON array tail, a set of function
bodies, a passage of prose. Requests below the size floor, requests nothing
claims, and every elision that is lossless are all written nowhere.

Spills go under your OS temp directory in `token-optimizer-spill/`, one file per
distinct content, created `0600` (owner read/write only) and named by an HMAC of
the content under a salt generated fresh in each proxy process -- so the name
discloses nothing and two runs do not collide. They are never read back by us;
the agent reads them with the `Read` tool it already has, which is the whole
point of a path instead of a hash.

They are **not** deleted while the proxy is running, and that is deliberate: a
marker whose spill has been swept is exactly the dangling reference this design
exists to avoid, and the agent may follow a path many turns after it was
written. So retention within one run is bounded only by the distinct content you
elide -- there is no quota, and a very long session that elides constantly can
accumulate.

When the proxy stops, its spill directory is removed. Each proxy process gets
its own directory under `token-optimizer-spill/`, so stopping one never sweeps
another's live paths, and the moment it stops is also the moment no agent can
still be following one of them. If a run ends without that cleanup -- a kill
signal, a power cut -- the directory is left behind in your OS temp directory
and is safe to delete by hand. Running with the proxy off writes no spills at
all.

### The main switches, and what each one trades

| variable                               | default    | what it does                                                                |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `TOKEN_OPTIMIZER_PROXY`                | on         | the compression proxy itself; set `0` to opt out                            |
| `TOKEN_OPTIMIZER_COMPRESSION`          | `balanced` | `balanced`, `aggressive`, `conservative`, `lossless`                        |
| `TOKEN_OPTIMIZER_PROXY_KNOWLEDGE`      | on         | put what this project already learned in the cached prefix                  |
| `TOKEN_OPTIMIZER_PROXY_NET_SAVING`     | off        | never send upstream more bytes than the client gave                         |
| `TOKEN_OPTIMIZER_PROXY_REPO_PACK`      | on         | one shared snapshot of the repository for every agent on it                 |
| `TOKEN_OPTIMIZER_PROXY_REPO_PACK_TASK` | off        | also pack a subagent's task repository when the session runs outside a repo |
| `TOKEN_OPTIMIZER_PROXY_TRIM_SUBAGENTS` | on         | drop the memory index, skill text and unused tool lists from subagents      |
| `TOKEN_OPTIMIZER_PROXY_READONLY_ROUTE` | off        | `down`: declared read-only subagents one model tier down (measured to cost more) |
| `TOKEN_OPTIMIZER_PROXY_REPO_PACK_POSITION` | `first` | the pack right after the first cached system block; `last` appends it       |
| `TOKEN_OPTIMIZER_PROXY_PREFETCH`       | off        | fetch the issue or PR a subagent is assigned before its first turn          |
| `TOKEN_OPTIMIZER_PROXY_WORKER_TERSE`   | on         | ask subagents for short reports (output is billed 5x input)                 |
| `TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES`| off        | server-side clearing of old tool results; measured to cost more (see below) |
| `TOKEN_OPTIMIZER_PROXY_COMPACT`        | off        | server-side compaction past `_TRIGGER` input tokens (min 50,000)            |
| `TOKEN_OPTIMIZER_REPEATS`              | on         | a re-run shell command returns only what changed                            |
| `TOKEN_OPTIMIZER_BLACKBOARD`           | on         | a subagent's briefing lists read-only commands its siblings already ran     |
| `TOKEN_OPTIMIZER_LEAN_HANDOFF`         | off        | a subagent's report over 4,000 characters reaches the lead lean; also needs `Agent\|Task` in the PostToolUse matcher |
| `TOKEN_OPTIMIZER_REPO_ASK`             | off        | a `repo_ask "<question>"` shell command for agents, named in their briefing |
| `TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX`   | on         | a cache marker before each subagent's task, so siblings share their prefix  |
| `TOKEN_OPTIMIZER_PROXY_HOIST_CONTEXT`  | on         | opening-context paragraphs an earlier session already sent move into the shared cached prefix; a new session's first request wrote 4,301 tokens to cache, now 508 (same project); across 5 projects, about 6,800 to 3,000 once the ledger has seen 2-3 sessions |
| `TOKEN_OPTIMIZER_PROXY_COLD_GATE`      | on         | a sibling's first request waits (up to 12 s) to read the first one's cache   |
| `TOKEN_OPTIMIZER_PROXY_KEEPWARM`       | on         | a capped read-back ping keeps a large conversation's cache warm when idle   |
| `TOKEN_OPTIMIZER_OUTPUT_COMPACT`       | on         | Bash and Grep results over 6 KB compacted, Grep grouped by file; full text kept |
| `TOKEN_OPTIMIZER_QUIET_ENV`            | on         | quiet defaults (pagers, progress bars, telemetry banners) for agents' shells |
| `TOKEN_OPTIMIZER_COMPACT_WINDOW`       | `400000`   | `autoCompactWindow` written to Claude Code settings when absent; `off` removes ours |
| `TOKEN_OPTIMIZER_HARVEST_TURN`         | off        | `1` restores the Stop hook's separate harvest turn                          |
| `TOKEN_OPTIMIZER_BATCH_GUIDANCE`       | off        | a batching instruction in every request's system prompt                     |

### Upgrading from 7.6.0

7.7.0 changes these defaults. Each can be switched back, and each was measured
before it shipped (see #523, #525 and #526).

**New and on by default**
- **Subagents.**
  - A cache marker before each subagent's task (`TOKEN_OPTIMIZER_PROXY_SHARE_PREFIX=0` turns it off).
  - A short wait on a sibling's first request so it reads the first one's cache (`TOKEN_OPTIMIZER_PROXY_COLD_GATE=0`).
  - The memory index, skill text and unused tool lists trimmed from subagents (`TOKEN_OPTIMIZER_PROXY_TRIM_SUBAGENTS=0`).
  - Subagents asked for short reports (`TOKEN_OPTIMIZER_PROXY_WORKER_TERSE=0`).
- **Repository pack.** A shared repository snapshot in the cached prefix, built only for directories under a trusted root (`TOKEN_OPTIMIZER_PROXY_REPO_PACK=0`).
- **Tool output.** Bash and Grep results over 6 KB are compacted, with Grep results grouped by file. The full output is stored, and the notice names the file to Read (`TOKEN_OPTIMIZER_OUTPUT_COMPACT=0`). A re-run shell command returns only what changed (`TOKEN_OPTIMIZER_REPEATS=0`).
- **Siblings and shells.**
  - A subagent's briefing lists read-only commands its siblings already ran (`TOKEN_OPTIMIZER_BLACKBOARD=0`).
  - Agents' shells get quiet tool defaults (`TOKEN_OPTIMIZER_QUIET_ENV=0`); a value the user sets always wins.
- **Long sessions.**
  - A capped keep-warm ping holds a large conversation's cache across idle gaps (`TOKEN_OPTIMIZER_PROXY_KEEPWARM=0`).
  - The Stop hook's harvest no longer takes a turn of its own (`TOKEN_OPTIMIZER_HARVEST_TURN=1` restores it).

**Written to Claude Code's settings**
- `autoCompactWindow: 400000`, only when the key is absent. It is recorded, and removed again only while it still holds the value we wrote (`TOKEN_OPTIMIZER_COMPACT_WINDOW=off`, or mode `off`).
- The record of this and of default routing now sits beside the settings file it describes (`token-optimizer-compact-window.json`, `token-optimizer-routing.json`), not in the optimizer home. A record a 7.6.0 install left in `~/.token-optimizer` is still read, and moved on the next write.

**Changed for a Claude Code plugin install**
- The MCP server no longer tells agents to load its tools with ToolSearch for ordinary reads and searches, because the hooks already compact that output. Other clients keep the routing policy.
- The post-call hook no longer runs on Read, Agent or Task (it runs on Grep, Bash, PowerShell and edits).

**Built but off by default**, because measuring showed they cost more or never fired:
- read-only model routing (`TOKEN_OPTIMIZER_PROXY_READONLY_ROUTE=down`);
- issue/PR prefetch (`TOKEN_OPTIMIZER_PROXY_PREFETCH=1`);
- server-side clearing and compaction (`TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES=1`, `TOKEN_OPTIMIZER_PROXY_COMPACT=1`);
- lean handoffs (`TOKEN_OPTIMIZER_LEAN_HANDOFF=1`, which also needs `Agent|Task` in the PostToolUse matcher);
- `repo_ask` (`TOKEN_OPTIMIZER_REPO_ASK=1`);
- the batching instruction (`TOKEN_OPTIMIZER_BATCH_GUIDANCE=1`).

Both of the `on` rows said `off` here until 7.1.0, which was wrong about the
shipped code rather than a change of default: an unset value has always meant
enabled, and `0`, `false`, `no` and `off` are what turn either one off.

`TOKEN_OPTIMIZER_PROXY_NET_SAVING` is off because the knowledge block is supposed
to grow the request: it is charged once as a cache write and then read at 0.1x for
the rest of the session, which pays on a long conversation and does not on a short
one. Turn it on and the block is dropped on any turn where sending it would hand
upstream more bytes than the client handed us -- the wire never inflates, and the
prefix knowledge is what you give up for that.

`TOKEN_OPTIMIZER_PROXY_CLEAR_TOOL_USES` is off because the client re-sends its
whole history every turn: once a conversation passes the trigger, every request
clears, and the boundary moves forward with each new tool use, re-writing the
cache from there each time while the model re-reads what was cleared. On the
long single-agent benchmark the run that crossed the trigger cost about 1.5x the
runs without clearing. `TOKEN_OPTIMIZER_REPO_ASK` is off because agents offered
it never used it (0 calls across about 230 benchmark subagents); the briefing
line was a cost on every agent. `TOKEN_OPTIMIZER_PROXY_PREFETCH` is off because
on the 10-agent campaign replay the workers fetched their issues themselves
anyway, and runs with it cost about 10% more than runs without.
`TOKEN_OPTIMIZER_PROXY_READONLY_ROUTE` is off because the routed subagents
searched in many more, smaller calls and every call re-reads the whole context:
on the exploration benchmark Claude Code reported $0.349 per run routed against
$0.255 unrouted.

### Rollout channels

Each switch above is its own decision, which is fine until there are ten of them.
A channel is one decision instead: `stable` is what is on by default today, and
each wider channel carries everything the narrower ones do plus the features still
being measured.

| variable                           | default  | what it does                                                |
| ---------------------------------- | -------- | ----------------------------------------------------------- |
| `TOKEN_OPTIMIZER_ROLLOUT_CHANNEL`  | `stable` | `stable`, `beta`, `canary`, `dev`                           |
| `TOKEN_OPTIMIZER_FEATURES`         | unset    | a comma list of feature names to turn on within the channel |
| `TOKEN_OPTIMIZER_DISABLE_FEATURES` | unset    | a comma list to turn off, whatever else is set              |

`beta` turns on install self-repair; `canary` adds compact tool definitions. Those
two are staged: the channel is what enables them.

Everything else a wider channel reaches is request-only, and a channel never turns
one on for you -- it only lets you ask. `beta` makes the output shaper and the
shared knowledge graph askable, `canary` adds identifier substitution and
thinking-block dropping, and `dev` holds nothing back. Each of those either changes
what the model writes or forces an answer the code otherwise works out from the
directory it is running in, which is a decision worth naming rather than inheriting:

```
TOKEN_OPTIMIZER_ROLLOUT_CHANNEL=canary TOKEN_OPTIMIZER_FEATURES=substitution
```

A variable you already set still wins over the channel. If
`TOKEN_OPTIMIZER_PROXY_SUBSTITUTE=1` is in your settings, substitution is on even
on `stable`, because that switch shipped before channels existed and moving you to
a channel is not supposed to quietly turn your own configuration off.
`TOKEN_OPTIMIZER_DISABLE_FEATURES` is the one thing nothing overrides.

A name this does not recognise turns nothing on, and a value it cannot read is not
treated as yes. Both are reported rather than guessed at:

```
npm run doctor           # the channel and what it turned on
npm run doctor -- --features   # every feature and the reason for each
```

### The telemetry switches

| variable                       | default            | what it does                                           |
| ------------------------------ | ------------------ | ------------------------------------------------------ |
| `TOKEN_OPTIMIZER_TELEMETRY`    | off                | aggregate counts into a file in your home directory    |
| `TOKEN_OPTIMIZER_BEACON`       | off                | upload that file; requires the one above as well       |
| `DO_NOT_TRACK`                 | unset              | overrides both, whatever else is set                   |
| `TOKEN_OPTIMIZER_BEACON_URL`   | project            | send somewhere else, for a fork or a self-hosted table |
| `TOKEN_OPTIMIZER_BEACON_KEY`   | packed             | the key to send with; empty in a build without one     |
| `TOKEN_OPTIMIZER_BEACON_TABLE` | `telemetry_events` | the table to insert into                               |
| `TOKEN_OPTIMIZER_UPDATE_CHECK` | on                 | ask npm for the latest version, in `doctor` only       |

The key is not in this repository. It is public and the package is published, so
a committed key would be handed to everyone who runs `npm view` and could not be
rotated out of the copies already installed; the release workflow stamps it into
the tarball instead. A build without it still works and still aggregates locally
-- it just cannot upload, and `install_doctor` prints `packed without a key`
rather than letting an opt-in look like it is working.

`lossless` is worth knowing about: it forbids every transform that removes
something the output cannot reconstruct -- function bodies, array tails,
lower-signal prose -- and keeps the ones that can, which is whitespace, null
keys, folded duplicate lines with their timestamps listed, repeated path
prefixes, and back-references to content still in the request. Measured on the
codebase-exploration workload it still removes 12.2%, with **zero** lossy
elisions. For review or audit work where "the model can read the path" is not
an acceptable answer, that is the setting.

Presets are a starting point, not a ceiling: the library takes a
`CompressionOptions` object layered over the preset, so "aggressive, but keep
six head rows" is expressible.

### The graph, in the cached prefix

**The expensive failure here is turns, not tokens.** This project measured a
posture that cut nothing and cost 1.471x through extra turns alone. So a
finding that prevents one wasted turn pays for a great deal of context.

The knowledge graph knows things that would prevent them, but until now it
reached the model two ways and both arrive too late or too dear: a SessionStart
index chosen once from the opening task text, and a `PreToolUse` advisory that
fires _after_ the model already decided to make the call it is advising about --
so acting on it costs the very turn it was meant to save.

Verified project findings enter the **cached prefix** by default, with a
2,000-character budget. The proxy freezes the selected block for a conversation
to preserve the cache; new sessions can select newly recorded findings. This
includes the Codex Responses API path. Shared graphs exclude project-specific
claims. Set `TOKEN_OPTIMIZER_PROXY_KNOWLEDGE=0` to disable injection.

Added knowledge is reported separately as `injectedChars`. It adds input tokens;
net cost improvement requires measuring whether it prevents enough work.
Earlier head-to-head results do not establish that the newly enabled combination
wins every workload.

### Images

An image block was invisible to all of this until recently -- every walker keyed
on `block.text`. That matters because an image costs about `width * height /
750` tokens, so one 1456x816 screenshot is roughly 1,585, re-sent as history on
every later turn. A browser-driving agent sends the same frame repeatedly, and
those repeats now collapse to a reference to the copy already in the request.
Dimensions come from the file header, so there is no codec dependency; resizing
is deliberately not done for the same reason.

### Relevance: BM25 by default, a model if you want one

Retention is ranked by BM25, which is why this needs no Python, no model
weights and no RAM floor, and why it is deterministic enough to keep a cached
prefix byte-stable. Lexical has a ceiling, though: "the database ran out of
handles" shares no token with "connection pool exhausted", and worse, BM25
does not go quiet on that question -- it confidently picks the wrong line.

So there are two ways to do better. `registerRanker` installs any synchronous
ranker. Or supply a `SemanticEncoder` and let the proxy warm an embedding
cache: a request-level async pre-pass embeds the candidate units in one batch,
and the engines then read vectors synchronously, exactly as before. An
`onnxruntime-node` adapter is included, loaded dynamically so the runtime is
never a dependency of this package.

Anything the pre-pass did not see falls back to BM25 rather than scoring zero
-- a missing vector is our omission, not evidence about the line.

The adapter is verified against **real inference**, not mocked:
`npm run verify:onnx` runs nine checks against a 2.3 KB ONNX graph with real
weights, committed alongside the generator that builds it. It is a script
rather than a jest test because onnxruntime checks `instanceof Float32Array`
in native code and jest's per-suite VM realm has its own typed arrays; CI
installs the optional runtime and runs it.

**Not claimed:** that an embedding model actually beats BM25 on these
workloads. The mechanism is proved and the measurement is not done.

### Compaction is consolidation, not loss

Everyone else checkpoints and restores what you _had_ — which spends the
scarcest budget in the session replaying context you already paid for.

Selection here is **derived**, not a category list: `cost-to-rederive ×
irrecoverability × reuse-probability`, with dead ends and decisions on a floor,
because cheap-to-find is not the same as cheap-to-find-_again_. Restoration then
adapts to the situation — mid-problem, cold resume, or in-flow — within a
measured budget:

> **Where you were:** does clock skew explain the 401s?
> ruled out: token signing, clock drift on the client
> untested: NTP skew on the server

That is resuming a thought. A summary describes one.

### Progressive disclosure that knows what you asked

A large tool result becomes a preview chosen by the **session's actual
question**, after parsing the output's shape (test report, diff, stack trace,
log, JSON) — not the first 40 lines because they are first.

```
[selected against: "which shard fails?"]
--- failures ---
  FAILED  DBNetTests.BceOnRelu -- expected 0.0 got NaN
  FAILED  TftGradientFlow -- gradient did not reach the encoder
---- omitted: 1,760 lines of passing tests (expand 8bb6bd66) ----
```

Every cut is **named**, because a model reasoning over a silent truncation
cannot know it is missing anything. `expand` serves from a content-addressed
store — it never re-runs your test suite — and expanding both teaches the next
preview and promotes what you needed into the graph, so the second expansion
never happens.

### Prompt-cache economics, measured from your own transcript

Provider caches are billable and provider-specific; a cache hit is not a free
input token. For example, Anthropic publishes separate cache-read and
cache-write multipliers, while OpenAI and Gemini expose their own cached-input
usage and pricing rules. Token Optimizer reads native cache fields when the
client supplies them and keeps reads, writes, uncached input, and output
separate. It never applies one provider's cache multiplier to another client.
The attribution view then does the part a hit rate cannot:

```
! CLAUDE.md:2 has an embedded timestamp, invalidating everything after it
    about 329,421 tokens re-written per session
```

Attributed to a line, priced by what sits _behind_ it. Keep-warm is decided by
expected value from your observed gaps, per TTL tier — and when neither tier
pays, it says so.

### Model routing decided by outcomes, not by task size

Everyone guesses from task shape and never checks. This reads which model ran
each episode and what happened — retries, errors, turns — and prices **both**
mistakes: what an overpowered model wastes, and what an underpowered one costs
in retries. A tier that needs a retry in more than half its episodes is excluded
at any price, because four cheap turns that fail are not cheap.

### Learned cost control: pruning, loop guard, holdout, and the quota you actually pay with

Four controls learn from this repository's own finished sessions. They act on
what a session *loads* and *how it fails*, which the compression above does not
reach. None of them needs a model call to work.

**Tool pruning.** A tool unused for 10 prompts across 2 or more sessions (or for
5 sessions) is written as a bare-name `permissions.deny` rule into the project's
`.claude/settings.local.json`. That removes its definition from every later
request (verified on Claude Code 2.1.319: 173 tools to 171). The list is written
only after the repository's other sessions have been idle for 60 minutes. A
deny rule reaches sessions that are already running, so writing it while a
warm session is mid-flight would make that session re-write its cache. The
file and shell tools, AskUserQuestion, plan mode, ToolSearch, Skill, WebFetch,
WebSearch and this package's own tools are never pruned. A pruned web tool would
never be asked for, so the automatic restore below could never bring it back.
Rules you wrote are never removed or adopted.

Pruning is reversible without a command. A session whose model reaches for a
pruned tool, or whose user names one, gets it back at the next fold, and that
tool is never pruned again.

The `Agent` tool is prunable. Claude Code 2.1.3xx already defers almost every
other tool, and `Agent` was the largest definition still sent inline with every
request: 5,189 characters, about 1,250 tokens. Once pruned, the model cannot
reach for it, and people ask for "agents", not `Agent`. So the Stop hook reads
the turn's prompt whenever `Agent` is pruned. If the prompt asks for agents
("use two agents", "spawn a sub-agent"), the hook restores the tool at once and
continues the turn, so the request is served in the same turn. A bare "in
parallel" does not count: a wrong match would cost a turn and the prune.

The catalog of tools a session loads is read in the
background from `claude -p`'s init event. The process is killed before any model
call, so the read costs no money or quota. Sessions launched outside a
repository, such as from a home directory, get their own store keyed on the
launch directory.

**Codex.** Codex has capability switches instead of a per-tool deny list. On
the same evidence rule, read from Codex's own session logs in `~/.codex/sessions`,
it switches off the capabilities a repository never uses: the sub-agent tools
(`features.multi_agent`, `agents.enabled`), image viewing (`features.view_image`),
the advert for uninstalled plugins (`features.tool_suggest`), ChatGPT apps
(`features.apps`) and the sleep tool (`features.sleep_tool`).
The switches go in a marked block at the top of that repository's
`.codex/config.toml`. Measured on codex-cli 0.167.0, the sub-agent switch alone
cut each request's standing prompt from 72,078 to 60,579 bytes (−16%). In a trusted
project's config, the last three together cut it another 7.3% (71,768 to 66,550 bytes).
`features.plugins` is never touched, because it also removes the skills
instructions. Codex
reads project config only for projects it trusts, so an untrusted repository
stays a proposal. The file is left alone when it is tracked by git, or when it
already defines a `[features]` or `[agents]` table (writing it twice would stop
Codex starting). The global `~/.codex/config.toml` is never written. Asking for
sub-agents in so many words, or attaching a screenshot, gives the capability
back for good. Undo: `token-optimizer-learned toolprune restore --codex`.

**GitHub Copilot CLI.** Copilot's tool list can only be cut with a launch flag:
`--excluded-tools` has no setting a repository or hook could write. So the
managed `copilot` command adds it. On the same evidence rule, read from
Copilot's own session logs (`~/.copilot/session-state/*/events.jsonl`, or
`$COPILOT_HOME`), it leaves out the built-in tools a repository never used,
such as image generation, dynamic workflows, the session SQL tools and the
GitHub MCP server's search tools. Measured on Copilot CLI 1.0.107, leaving out
20 of the 28 tools cut a session's first request from 26,748 to 12,762 input
tokens, and its AI credits from 7.04 to 3.43. Every persisted Copilot setting
moved it by 560 tokens at most. The shell, file and search tools, the
sub-agent tools, `web_fetch` and `skill` are never left out, and nothing is left
out when you pass `--available-tools` or `--excluded-tools` yourself. A tool
that is left out cannot be called, so the restore signal is asking for it:
typing its name, or for example "generate an image" or "Copilot Spaces". That
gives it back for good. A Copilot started without the managed command keeps
every tool, and its sessions still count as evidence. Status:
`token-optimizer-learned status`. Undo: `token-optimizer-learned toolprune
restore --copilot`.

Four Copilot user settings (`askUser`, `connectors`, `contextManagementTools`,
`imageGeneration`) together cost those 560 tokens per request. They are your
user-level settings, not a repository's, so they are only reported by
`token-optimizer doctor` unless you opt in with
`TOKEN_OPTIMIZER_COPILOT_LEAN_SWITCHES=write` (default `off`). Then the managed
`copilot` command writes `false` for each one still unset in
`$COPILOT_HOME/settings.json`. It never overrides a value you set (so
`copilot config imageGeneration true` keeps it on for good) and never touches a
file that is not strict JSON. `token-optimizer-learned toolprune restore
--copilot` undoes it: the original file byte for byte if you have not edited it
since, otherwise only the switches it wrote. After that they are not written
again.

**Loop guard.** On a failed call (`PostToolUseFailure`), the guard looks at the
current turn. The same failure signature four times in one turn, or a turn
churning past 2.5x this repository's usual length, is redirected at once. Three
repeats, or many failures in a long turn, count as suspect. A suspect turn is
redirected straight away, or sent to an optional judge
(`TOKEN_OPTIMIZER_LOOPGUARD_JUDGE=on`, run through your own `claude` CLI and
accounted). The redirect names the failure, and it carries what the knowledge
graph already holds about the files involved: the dead ends and working commands
an earlier session recorded. Each turn gets one redirect. After that, the person
sees one line saying how to interrupt the turn; the guard never stops a turn
itself. It acts from the first session, since identical repeated failures are a
loop in any repository.

**Injection holdout.** Every kind of context these hooks inject is billed on
every later request of the session. One session in ten withholds exactly one
class (session index, standing rules, graph findings, advisories, guidance, and
so on). Its cache-aware cost per prompt is then compared against ordinary
sessions with a permutation test. A class that sessions are measurably cheaper
without is gated. The test keeps running in reverse, so a wrong gate undoes
itself. The tool policy, crash notices and anything else a session needs to work
are never withheld. Set `TOKEN_OPTIMIZER_INJECTION_HOLDOUT=off` to opt out; a
benchmark arm turns it off automatically.

**Billing mode and quota pacing.** Billing mode is detected per client, without
opening a credential file. Claude Code's non-secret `oauthAccount.billingType` is
the signal, alongside API-key and cloud-provider environment variables;
`TOKEN_OPTIMIZER_BILLING` overrides it. API users are optimized for cache-aware
cost per task. Subscription users are optimized for finished work per unit of
quota. Under the default `TOKEN_OPTIMIZER_SUBSCRIPTION_POLICY=pace`, leftover
capacity is spent (by continuing with a queued backlog task) only when **both**
of these hold:

- the 5-hour window is under 90% used;
- the week is on pace (weekly use is no more than the share of the week
  elapsed).

Capacity "left over" today is otherwise taken from later in the week. The
numbers come from Claude Code's own status-line payload (`rate_limits`), which
hooks never see. Run `token-optimizer-learned statusline install` to record
them; it wraps any status line you already have. With no data it holds rather
than guesses. `suggest` and `report` turn pacing off.

`pace-verify` adds one continuation per session that asks the model to run the
tests after unverified edits. It is opt-in. In a 15-pair learned SWE-bench
pilot it fired in 8 of 13 sessions and added 33% turns and 29% cost. It changed
no outcome: both arms resolved the same 12 of 15.

```
token-optimizer-learned status                   # all four, with evidence
token-optimizer-learned toolprune restore [Tool] # give tools back
token-optimizer-learned statusline install       # let pacing see real quota
```

What is verified and what is not: the mechanisms are covered by tests and by the
probes named above. Their effect on end-to-end task cost has **not** been
measured yet. The holdout exists to measure exactly that on your own sessions,
and it reports "collecting" until it has enough of them.

### Waste detection that becomes a ratchet

A report is read once and forgotten. Here a detection produces a **durable,
measured, reversible fix** — a skip rule, a composite touch — plus a ~50-token
session-start briefing so the waste never starts. Detectors are a shipped floor
_plus_ patterns derived from your project's own history, each carrying what it
has actually saved:

```
generated/schema.d.ts: read in 9/9 sessions, never the source of a finding
    3,400 tokens/session; cost equivalent not priced; apply: waste_audit action="apply"
```

Anything that touches **your** files is proposed as a diff and never applied.

### One audit across every project

`fleet_audit` ranks your whole machine by measured cost, and does something a
per-project scanner cannot: a fix proven in one project is offered to the others
containing the **same file contents**, carrying the evidence from where it was
measured. Matching is by content hash, never by filename.

It also runs the natural experiment nobody else can — enforcing clients versus
directive ones — and reports it whichever way it falls, with the confound
stated.

### It learns from what already went wrong, offline

Every failed tool call you have already paid for is sitting in your agent's own
transcripts. `npx token-optimizer-learn` reads them locally, groups the failures
that keep repeating, and writes the ones worth remembering into the instructions
file that agent already reads -- `CLAUDE.md` for Claude Code, `AGENTS.md` for
Codex.

```bash
npx token-optimizer-learn                  # what it found, printed, nothing written
npx token-optimizer-learn --projects       # which projects have transcripts
npx token-optimizer-learn --since 14 --write
```

`--agent <claude|codex|auto>`, `--project <path>`, `--since <days>`,
`--max-sessions <n>`, `--json`. **Nothing is written without `--write`**, and a
block it writes is delimited, so running it again replaces its own advice instead
of appending another copy -- nothing outside those markers is ever touched.

Three things it refuses to do, because each one produced a confidently wrong rule
on a real corpus:

- **It does not blame a chained command line.** A transcript records the line and
  the exit code, not which of `cd X && git grep a && ls b` failed, so those are
  counted as unattributable and reported as a number rather than pinned on the
  first command.
- **It does not turn your failing build into advice.** A failing test or compile
  is the work going wrong, not a habit to avoid.
- **It says what it could not read.** Transcripts it could not parse and failures
  it could not categorise are printed as counts, because they bound how much of
  the result to believe.

It reads local files only -- no network, no upload -- and reduces your home
directory to `~` before any recommendation text is written. `TOKEN_OPTIMIZER_LEARN_PLUGINS`
takes a comma-separated list of module specifiers to add another agent's format;
nothing is discovered or imported unless you name it.

---

## Honest comparison

|                              | Token Optimizer                                                      | Typical alternatives                                 |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| **License**                  | MIT — commercial use fine                                            | Often noncommercial-only; check before using at work |
| Default behaviour            | Refuses the wasteful call                                            | Suggests a better tool                               |
| Re-read of an unchanged file | Returns a diff                                                       | Returns the file again                               |
| Savings figure               | Direct before/return ledger; causal graph effect separately held out | Computed from the tool's own assumptions             |
| Cross-session memory         | Findings, decisions, dead ends                                       | Usually none                                         |
| Compaction                   | Consolidation, ranked by cost-to-rederive                            | Checkpoint and replay                                |
| Cache economics              | Measured from the transcript, attributed to a line                   | Rarely addressed                                     |
| Model routing                | Measured from episode outcomes                                       | Guessed from task size                               |
| Cross-project                | Fixes transfer by content hash                                       | Per-project only                                     |
| Clients                      | 16                                                                   | 3–6 typical                                          |
| Telemetry                    | None                                                                 | Varies                                               |

---
