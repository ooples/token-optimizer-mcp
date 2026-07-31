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
`calls`, `supersedes`, `contradicts`, `answers`.

`contradicts` is an edge rather than an overwrite on purpose: when a belief
changes, the graph should record *that it changed and why*, not silently present
the new one as if it had always been true.

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

## Retrieval — traversal and lexical, no embeddings

Retrieval is graph traversal plus BM25/keyword for fuzzy lookup. **No embedding
model, no vector index.**

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

**A hard token budget per touch** (default ~500), ranked by `confidence x
recency`, with everything else reachable through `wiki_query`. This bound is not
a detail: without it, the most heavily-worked files accumulate the most findings
and become the most expensive to touch, and the optimizer becomes its own token
problem.

## Staleness — flag and serve, with the diff

When a file or symbol node's content hash changes, findings `derived_from` it
become **stale**. Stale findings are **served, marked, and accompanied by the
diff that invalidated them**.

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
