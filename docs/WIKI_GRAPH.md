# The project wiki graph

**Derived-Knowledge Retrieval (DKR)** — a living, per-project knowledge graph the
agent writes as a side effect of working, and reads instead of re-deriving.

## The claim, stated precisely

Classic RAG lowers the cost of **finding** information. This lowers the cost of
**having already understood** it. Those are different quantities, and for a
coding agent the second one dominates the bill.

A finding costs ~100-200 tokens to carry. Re-deriving it — reading the files,
running the searches, following the call graph, reasoning — costs 5k-50k. The
economics are lopsided by two orders of magnitude *if the hit rate is real*.
That "if" is the whole risk, and it is measured, not assumed (see Metrics).

## Why this is not RAG

| Classic RAG | DKR |
|---|---|
| Retrieves **evidence**; the model re-derives meaning each time | Retrieves **verdicts**; the reasoning already happened |
| Index built by a **batch ingestion job** over the whole corpus | Index accretes from **real agent traffic**, so coverage follows attention |
| **Similarity** search — semantically nearby | **Traversal** — this symbol *and its callers*. Causally correct |
| Model must **formulate a query** | Retrieval fires when the model **reaches for a file**. No query to get wrong |
| Staleness **invisible**; serves rotted chunks confidently | Staleness **computed** from content hashes on file/symbol nodes |
| Index is **read-only** at inference | **Write-back**: every conclusion updates the graph |
| Can only return what is **in the documents** | Returns **negative results** — dead ends that exist nowhere in the source tree |

The last row has no RAG equivalent. "We tried this and it failed because X" is not
in your repository; it exists only because an agent once burned tokens finding out.

## The sensor network is already installed

DKR needs no new instrumentation. The enforcement layer
([`docs/CLIENT_SUPPORT.md`](./CLIENT_SUPPORT.md)) already routes every read,
search and edit through our own MCP tools. We see the traffic; the graph is
built from what we are already intercepting.

This is why the two pieces of work are one product and not two features.

## Nodes

Four first-class kinds. Files and symbols are **nodes, not attributes** — that is
what lets staleness propagate along real edges rather than being bolted onto
findings.

| Kind | Holds | Source |
|---|---|---|
| `file` | path, content hash, language | structural, free |
| `symbol` | name, kind, file, span, hash of its span | structural, free |
| `task` | what was being attempted, session, prompt, outcome | structural, free |
| `finding` | a claim, confidence, and what it was derived from | harvested |

`finding` subsumes several shapes worth naming because they are retrieved
differently:

- **decision** — a choice *and its rejected alternatives*, so they are not
  re-proposed next session
- **failure** — a dead end and why. The highest-value kind, because nothing else
  in the repository records it
- **command** — an invocation that worked, with its result
- **map** — how a subsystem fits together

### Edges

`derived_from` (finding → file/symbol), `contains` (file → symbol), `imports`,
`calls`, `supersedes`, `contradicts`, `answers`, and `related` — a weak,
behaviour-derived edge between files worked on together, which is what gives
traversal-only retrieval a semantic neighbourhood without an embedding model.

`contradicts` is an edge rather than an overwrite on purpose: when a belief
changes, the graph should record *that it changed and why*, not silently present
the new one as if it had always been true. It is written, and it is disclosed:
a served finding that something disputes carries `contradicted: true` and, when
the other end resolves to a node, `contradictedBy` naming its key
(`hooks-core/staleness.mjs`, `disputeOf`). Dispute is tracked separately from
staleness — a finding can be disputed without being stale, and stale without
being disputed.

`answers` links a finding back to the task that produced it. Its attribution is
deliberately narrow: absent an explicit task id, the target is derived by
session-scoped traversal that requires the task to have touched *every* one of
the finding's anchors, and only when an authoritative session id is present.
**It does not fire on a default install.** `wiki_write` never supplies an
authoritative session id, so the model-invoked path never produces the edge; the
only producer today is the harvest worker, which runs only when the semantic
harvest is enabled (`hooks-core/harvest-write.mjs`).

## Harvest — structural free, semantic at boundaries

**Structural (zero cost, always on).** Hooks record what was touched: files read,
symbols edited, commands run and their exit codes, tests and their results. This
layer is never wrong, costs nothing, and builds the anchor skeleton that makes
invalidation computable.

**Semantic (cheap model, at boundaries).** At `Stop` and `PreCompact`, a
background pass over the *transcript delta* extracts findings, decisions and
dead ends. It runs **out-of-band** — a separate cheap-model call that never
enters the working context, so the harvest cost is not paid by the session doing
the work.

Model-invoked `wiki_write` exists for the agent to record something deliberately,
but nothing depends on it. The lesson of the enforcement redesign is that
anything opt-in does not happen.

**What a default install actually produces is the structural graph.** The
semantic pass needs a model to call: it is off with no credential
(`off:no-key`), runs against a local endpoint if one is configured, and is
disabled outright by `TOKEN_OPTIMIZER_HARVEST=0` or `TOKEN_OPTIMIZER_MODE=off`
(`hooks-core/harvest.mjs`, `harvestMode`). So findings — and everything that
depends on them, including the `answers` edge and the hit-rate numbers below —
accrue only where the harvest or a local model endpoint is in play. Nothing
below should be read as describing verdicts that accrue on their own.

## Retrieval — traversal and lexical, no embeddings

Retrieval is graph traversal plus BM25 for fuzzy lookup. **No embedding model,
no vector index.**

BM25 is implemented in [`hooks-core/lexical.mjs`](../hooks-core/lexical.mjs) and
is shared by both surfaces that search findings: the `wiki_query` tool's `search`
operation and the dashboard's `/api/wiki/search` route. It replaced a substring
`includes()` filter, which could not rank — and ranking is the whole value under
a token budget, because the budget otherwise keeps whatever happened to match
rather than what matched best.

Three properties of that matching are worth stating exactly, because "lexical
search" is easy to read as more than it is:

- **Compound identifiers are split.** The tokenizer emits each alphanumeric run
  whole *and* its camelCase / letter-digit parts, so `skipLibCheck` also yields
  `skip`, `lib`, `check`, and `TS2345` also yields `ts`, `2345`.
- **Query terms of three or more characters also match by prefix**, at a flat
  sub-1.0 term-frequency credit so a prefix hit can never outscore an exact one.
  `custom` finds `customer`; `skip` finds `skipLibCheck`.
- **Infix does not match.** `tomer` does not find `customer`. That is a real
  recall gap against the old substring filter, accepted rather than papered
  over.

A query that tokenizes to nothing — empty, whitespace, or punctuation only —
does not return nothing. Both surfaces fall through to the unranked pool ordered
by `confidence x origin weight x pinned`, so a blank search box and an omitted
`query` argument both mean "no filter".

One consequence to expect on the dashboard: `total` counts BM25-scored matches,
and `rank` omits findings no query term matched at all, so it can be smaller
than the count a substring filter would have reported for the same query.

That is a deliberate trade. Embeddings would add semantic recall for findings
with no structural path to the current work — and would reintroduce exactly the
drift, dependency and rebuild problems DKR claims to solve. Traversal is
deterministic, instant, dependency-free, and explainable: every retrieval can
show the path it came down.

The known cost: a finding unreachable by any edge is invisible to traversal.
Lexical search is the mitigation. If measurement shows real recall loss,
embeddings can be added later as *one more edge type* — never as the mechanism.

## Injection — both layers, hard budget

**SessionStart** injects a compact index: titles and ids only, so the model knows
what exists and can ask for it.

**Just-in-time** is where the win lands. `PreToolUse` sees a read of `auth.ts`
and injects the findings anchored to it. The model receives what it previously
spent 20k tokens deriving, for ~150 — *and never had to know to ask*.

**A hard token budget per touch** (default 500 tokens,
`TOKEN_OPTIMIZER_TOUCH_BUDGET`), ranked by `confidence x recency`, with
everything else reachable through `wiki_query`. This bound is not a detail:
without it, the most heavily-worked files accumulate the most findings and
become the most expensive to touch, and the optimizer becomes its own token
problem.

### `wiki_query` — the escape hatch, and it exists

`wiki_query` is what makes "everything else reachable" true. It is advertised in
the core tool profile, dispatched, and argument-validated, and it has **six**
operations:

| Operation | Returns |
|---|---|
| `get` | one finding by key, served through the staleness path |
| `search` | findings matching terms, BM25-ranked |
| `node` | a node and its immediate neighbours |
| `audit` | findings needing attention |
| `balance` | what the graph has cost and saved |
| `overview` | node counts, densest anchors, stale and total findings |

There is deliberately **no `anchor` operation**. `wiki_read` already owns
anchored retrieval — "what does the graph know about this file" — and two tools
offering the same operation costs the model tokens deciding between them.

Every call records a `kind: 'query'` metrics event, which is the numerator
`indexBudget` needs to earn the session index its allowance. That does not by
itself demonstrate the metric: `sessionIndex` returns `null` when it has nothing
to list, so on a graph with no findings the denominator is zero too. The budget
cannot be shown moving until findings exist.

## Staleness — flag and serve, with the diff

When a file or symbol node's content hash changes, findings `derived_from` it
become **stale**. Stale findings are **served, marked, and accompanied by the
diff that invalidated them**.

**How a change is noticed.** There are two paths, and the distinction matters
because one of them is the only thing that works for edits the agent made
itself:

1. **Queued at write, applied at the next graph read.** The post-tool hook
   already holds the write's evidence, so it appends one record to a pending
   queue and exits (`hooks-core/pending.mjs`, `queueInvalidation`); it does not
   load the graph, because loading a megabyte of JSONL on the return path of
   every write is the cost this shape exists to avoid. The next graph read —
   `forTouch`, `forCommand`, `sessionIndex`, `standingRules` — drains the queue
   **before serving anything** (`hooks-core/inject.mjs`, `withPendingApplied`).
2. **Lazy comparison at serve time**, which compares the anchor's stored hash
   against disk and so still covers changes the hooks never observed.

Path 1 is not an optimisation of path 2. The lazy check cannot see the session's
own writes at all: `indexFile` re-points a file node's stored hash at the bytes
just read, so by the next retrieval the anchor already agrees with disk and a
finding derived from the old content is served clean. Lazy catches what we never
saw; only the queue catches what we did.

**Two grades of evidence.** A queued record carrying both sides of the write
yields a symbol-precise diff. A record carrying only a path — a whole-file write,
or content past the snapshot cap — yields a hash comparison with no diff. In
that case the served finding says so (`stale` with `staleEvidence: false`)
rather than rendering an empty diff as though nothing had changed.

**Diffs are bounded three ways** — lines (40), characters per line (200), and
total UTF-8 bytes (4,000) — and every truncation is announced in the output. The
line bound covers the whole body, elision markers included, so the output is at
most 40 lines plus one final notice when the byte cap dropped lines: 41 in the
worst case, which is what the test asserts. The
byte bound is not redundant with the line bound: with only the line cap in
force, two 200,000-character single-line inputs produced 2 lines and 400,005
bytes, and that output goes straight into model context
(`hooks-core/staleness.mjs`, `diffLines`).

**A separate, narrower check: `derivationCheck`.** A finding may record the
anchor hashes that were in force when it was claimed, together with the file
operations that matched it. `derivationCheck` compares those hashes against the
anchor node's **last-indexed hash — not against disk** — which is why the served
finding carries `derivationCheckedAgainst: 'index'` rather than leaving a
consumer to infer it from a field name. It catches the case node-level staleness
cannot: a file changed, then re-indexed by some later unrelated write, so `stale`
reports fresh while the bytes this claim was derived from are gone. The disk
comparison is already owned by `stale`; this is complementary, not a second
opinion on the same question.

The derivation record also marks its own incompleteness (`operationsComplete`,
`operationsScope`). The join is file-scoped: command, build and test outcomes
are permanently unjoinable against a file-path anchor, and the record says so
rather than implying it captured them.

Not deleted, and not withheld. Re-verifying a conclusion against a known diff is
dramatically cheaper than re-deriving it from nothing, and that saving is the
entire reason the graph is worth keeping across a refactor. Deletion throws it
away; withholding declines to spend 200 tokens to save 20k.

The exposure is real and should be stated: this depends on the model heeding the
flag. A stale finding served without its diff would be worse than no graph at
all, so the diff is mandatory, not decorative.

## Storage

Per-project, `.token-optimizer/wiki/` by default, **gitignored**. The path is
user-configurable so teams can point it wherever they wish, including somewhere
committed — the default is local because findings are unreviewed agent output,
and automatically committing them puts unreviewed analysis into git history.

An append-only JSONL log plus a derived index, so concurrent sessions cannot
corrupt it and the whole graph can be rebuilt from the log.

Records are version-stamped. `load()` accepts a *range* of schema versions
(`SUPPORTED_VERSIONS`) and upcasts in memory; nothing on disk is rewritten, and a
record's own `v` is carried rather than restamped. `GRAPH_VERSION` is still `1`
because no record shape has changed. A future bump must add its upcast step
**and** its `SUPPORTED_VERSIONS` entry in the same change, or older logs stop
loading (`hooks-core/wiki.mjs`).

The core is vendored rather than imported: `scripts/sync-hook-core.mjs` copies
`hooks-core/` into **eleven** client integration directories, so counting the
source there are twelve copies of each module — twelve `inject.mjs` files carry
the injected text. `npm run sync:hooks:check` fails the build if any copy has
drifted.

## Browsing

The existing dashboard (`npm run dashboard`, `src/dashboard`) gains a graph view:
traverse nodes, follow edges, see what is stale and why, and read the provenance
of any finding — which session established it, from what, and when.

## Metrics — this must justify itself

The system reports, per session:

- **hit rate** — retrievals that were injected and then actually used
- **tokens injected** vs **estimated tokens avoided**
- **staleness rate** — the fraction of served findings that were flagged
- **harvest cost** — what the out-of-band semantic pass spent

A wiki that cannot show a positive balance on these numbers is overhead wearing
a knowledge-graph costume. The metrics ship with the feature, not after it.

## Risks

1. **Wrong findings are worse than none.** Mitigated by anchors, computed
   staleness, mandatory diffs, and confidence ranking. Not eliminated.
2. **Graph bloat.** The session-start index grows with the graph; ranking and
   eviction are required, not optional.
3. **Harvest quality.** A cheap model extracting findings from a transcript will
   sometimes extract noise. Confidence scoring plus the hit-rate metric is how
   that gets caught rather than accumulating silently.
4. **Cold start.** The graph is empty on a fresh clone and value ramps over the
   first few sessions. Accepted deliberately: the alternative is indexing code
   nobody will touch, which is the exact waste RAG ingestion is criticised for.

## Verifying it is connected

Every capability in this document can be implemented correctly, tested
thoroughly, and connected to nothing. That is not a hypothetical: it has
happened here repeatedly, and each time the whole test suite was green while the
feature delivered nothing.

- `forTouch` — the just-in-time injection this design calls "where the win
  lands" — had 27 passing tests and zero production call sites.
- `wiki_query` was named in twelve shipped copies of the injected prompt text.
  There was no such tool.
- `kind: 'query'` was read by the index budget and written by nothing except the
  test suite, so the ratio was zero on every project and the budget sat pinned
  at its 150-token floor for the life of the feature.
- `contradicts` and `answers` sat in `EDGE_KINDS` with no write site: the graph
  declared it could record a disputed belief and an answered question, and could
  do neither.
- `contradictionReason`, up to 400 characters explaining why one finding
  disputes another, was written on every `contradict` call and read by nothing.

Unit tests cannot see this, because they call the function directly. **Mutation
testing is actively misleading here:** break an unreachable function and its own
tests fail, so the mutation is scored as caught while the feature still delivers
nothing. Measured on this repository, the suite scored 100% on ten realistic
mutations during a period when two whole features were unreachable.

Three things answer it instead.

**`tests/hooks/reachability.test.mjs`** asks whether an exported name is
referenced by anything that ships, as opposed to only by its own tests. It scans
`hooks-core` and `plugin/hooks` for declarations — functions *and* consts — and
searches all of `hooks-core`, `plugin`, `src` and `scripts` for uses. Comments
are stripped, because prose is not a caller, and import specifiers are
discounted, because an import is not a call. **String literals are deliberately
NOT stripped**: `src/server` dispatches into `hooks-core` through dynamic
`mods.<module>.<fn>` handles, and a scanner that skips strings desynchronises on
the first regex literal containing a quote — measured at 63% of `adapter.mjs`
consumed and eleven live exports reported as orphans. Over-counting a name that
appears in a string is the permissive direction, and permissive is merely
useless where strict fails CI on working code and gets switched off.

**`tests/hooks/census.test.mjs`** counts producers against consumers in four
namespaces the name-based scan cannot model: event kinds, edge kinds, tool names
appearing in injected prompt text, and record fields. It is what would have
caught every example in the list above.

**`npm run wiki:census`** prints what the graph is doing on a real machine —
findings, nodes, edges by kind, and index, query, inject, substitute and
retrieval-decision events. This is not a test and never fails a build. Every
defect listed above passed CI, so a green suite is not evidence that a
capability runs; events in a real log are. A fresh clone is expected to read
zero everywhere, which is the cold start this design accepts deliberately.

**What the guards cannot prove.** A name-based scan shows that a REFERENCE
exists, never that it RUNS. This work produced its own example: `manifestSize`
left the allowlist by acquiring a caller in the doctor's install section, and
that call sits inside `if (resolved.method !== 'plugin')` — so on a plugin
install, which is how this product is actually distributed, it still never
executes. That is correct here, because only the install script writes a
manifest and a plugin install has none to size, but the guard could not have
told the difference. A reference inside a branch that never runs, or behind a
flag nobody sets, satisfies it exactly as well as a live call. That is precisely
why `npm run wiki:census` reads real logs rather than source text, and why a
capability is not considered proven until its events appear in one.

Every assertion in `census.test.mjs` is mutation-tested, and that is not
ceremony. Two of its first drafts could not fail at all: the read side of "read
but never written" was filtered by the write side, so the `query` case it
advertises would have slipped straight through, and "declares every edge kind it
writes" compared a set against a superset it had already been filtered into.
Both were found by deliberately breaking the thing each claimed to detect and
watching the suite stay green. A guard that cannot fail is worse than no guard,
because it is counted.

Two lists are maintained rather than emptied, and both are ratcheted to a
ceiling that can only fall: the reachability allowlist, and the census's record
of orphan writers and unread fields. Every entry names what it is and what it is
waiting on. The distinction from a backlog is the point — an earlier round of
this work parked sixteen findings in a list of accurate descriptions with no
owner, and writing the description down felt like fixing the thing.
