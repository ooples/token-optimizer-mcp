# Closing the wiki-graph gaps (#204)

**Date:** 2026-08-25
**Issues:** #204 (living wiki graph). #311 was in scope at authoring time and is now closed by #313.
**Branch:** `feat/close-wiki-graph-gaps`

---

## 1. Context: what is actually wrong

All six phases of #204 have real implementations. P1 (`wiki.mjs`, 735 lines), P2
(`staleness.mjs`, 525), P3 (`harvest.mjs` + `harvest-write.mjs`), P4
(`inject.mjs`, 669), P5 (`metrics.mjs`), P6 (`wiki-routes.ts` + dashboard). Two
of them exceed the design: staleness gained a lazy path the doc never asked for,
and injection gained zero-turn substitution.

And on this repository's own graph, accumulated 2026-08-04 to 2026-08-25:

```
graph.jsonl    1446 symbol   468 file   45 task   1 finding
metrics.jsonl   857 read   5 substitute   2 inject   0 index   0 query
```

One finding. The product thesis — *retrieve verdicts, not evidence* — has
approximately one verdict to retrieve.

### 1.1 Root cause

Not "unbuilt". The repeating defect is **capabilities that are declared,
documented, tested, and then not connected to anything that runs.** Ten verified
instances, four already fixed (`downstream`, `harvest-write` unimported,
`HUMAN_WEIGHT` unconsumed, `tokensFullFile` unread).

The important part is that **round 1 already built the detector.**
`tests/hooks/reachability.test.mjs` exists, is explicit that this defect
"occurred twice", and correctly identifies why unit tests and mutation testing
cannot see it. It found ~21 instances. Four were wired. **Sixteen were moved to
an allowlist labelled "TRIAGE BACKLOG".**

> **Revised 2026-08-25 against HEAD `d6fcc24`.** The audit behind this spec ran
> against `315e620`; master has since advanced by 21,705 insertions across 115
> files, so every claim was re-verified. Three things changed: **#311 is fully
> closed by #313** (Component H is dropped); the **`PostToolUse` hook now
> exists** (`plugin/hooks/post-tool.mjs`, handled in `adapter.mjs`), reducing
> Component B to the two things still missing; and the **calibration loop was
> wired**, removing four allowlist entries. The list now holds 11 entries, of
> which **9 are real backlog** — `forTouch` is stale (2 live call sites) and
> `policyText` is genuine public API. Everything else was re-confirmed open, and
> one got worse: `contradicts` is now *read* by `curate.mjs:264` while still
> written by nothing, making it a reader-with-no-producer as well as an unwritten
> edge kind.

That allowlist's own documentation says: *"If the reason is 'we might use it
later', the honest action is to delete the function and write it again when that
day comes."* It violated that rule sixteen times at authoring; nine entries remain.

So the disease is not blindness. It is that **an accurate written description of
a defect felt like resolution.** Any fix that closes three instances and leaves
the rest parked reproduces round 1 exactly.

### 1.2 Two structural holes in the existing detector

| Hole | Evidence |
|---|---|
| Comments count as call sites — `usedInShippedCode` bare-word-matches raw text | `invalidateOnWrite`: **1 raw ref, 0 code refs.** Removing it from the allowlist leaves the test passing, because `pretooluse-router.mjs:153` mentions it in prose. Verified by probe. |
| Only `export function` is scanned — 38 exported consts are invisible | `contradicts` and `answers` are declared in `EDGE_KINDS` with **zero write sites**. `contradicts` gets a full paragraph in `WIKI_GRAPH.md` as the design's departure from RAG. |

The detector also cannot see three whole sub-classes: readers with no producer
(`kind:'query'`), producers with no reader (`kind:'lessons'`, written at
`harvest-worker.mjs:113`), and referents with no target (`wiki_query`, named in
twelve shipped copies of injected prompt text).

The allowlist has also already rotted: `forTouch` is listed as pending-wiring but
now has 2 real call sites, so a regression there would be masked.

---

## 2. Non-goals

- No embeddings or vector index. The stance stays, but §7 makes it falsifiable.
- No reranking model. Retrieval mechanics stay deliberately below state of the art.
- No change to the semantic harvest's opt-in default. Privacy and billing consent
  is correct as it stands; §6 makes a default install productive without it.
- No `GRAPH_VERSION` bump (§8).
- Issue #201 is out of scope here and is handled separately (doc status pass, then close).

---

## 3. Decisions

| # | Decision |
|---|---|
| 1 | `wiki_query` ships as the union: `get`, `search`, `anchor`, `node`, `audit`, `balance`, `overview` — `overview` is textual graph shape, not layout coordinates |
| 2 | Real BM25 in `hooks-core/lexical.mjs`, consumed by both `wiki_query` and `/api/wiki/search` |
| 3 | Hit rate = Layer 1 (explicit reference) calibrated against Layer 2 (per-finding causal effect) |
| 4 | Layer 2 on by default, guarded, with an env kill switch |
| 5 | All four cold-graph measures ship |
| 6 | Four local extractors, no model call, redaction mandatory |
| 7 | Dollars only on measured-counterfactual lines, sourced from `pricing.mjs` |
| 8 | Upcaster and range reader built; `GRAPH_VERSION` stays at 1 |
| 9 | `PostToolUse` scoped to write/exec tools, capture-only, invalidation applied at next graph read |
| 10 | The reachability detector's two holes are fixed and its allowlist is emptied to zero backlog entries |
| 11 | `contradicts` is wired, and confidence promotion requires no outstanding contradiction |
| 12 | Held-out retrieval probe measures recall; no embedding baseline |
| 13 | ~~#311 both bugs fixed here~~ — superseded: closed by #313 |
| 14 | One PR, ordered commits |

---

## 4. Component A — Retrieval

### `hooks-core/lexical.mjs` (new)

Pure BM25 over finding `claim` and `key`. No dependency. Exports
`score(query, docs)` and `rank(query, findings, { limit })`.

Why it matters beyond doc-honesty: substring matching cannot rank, so a
budget-capped retrieval currently keeps whatever happened to match rather than
what matched best. `/api/wiki/search` switches to it, removing the divergence
between what the dashboard does and what the doc claims.

Ranking prior: BM25 relevance is combined with the per-finding utility from
Component E where a verdict exists. Implicit relevance feedback from a *causal*
signal is the one retrieval advantage available to us that a search engine
cannot replicate.

### `src/tools/intelligence/wiki-query.ts` (new)

Follows `wiki-write.ts`. Registered in `src/server/index.ts`; schema in
`src/validation/tool-schemas.ts`.

| Operation | Returns |
|---|---|
| `get` | finding by key: claim, confidence, origin, anchors, staleness + invalidating diff, provenance |
| `search` | BM25-ranked active findings, optional `type` filter |
| `anchor` | findings reachable from a file/symbol via `findingsFor` |
| `node` | node plus bounded neighbourhood |
| `audit` | `curate.audit` output |
| `balance` | `metrics.report` output |
| `overview` | counts by kind, densest anchors, most-stale clusters — text |

Every call records `record(dir, { kind: 'query', operation, key })` against the
project resolved by `projectRootFor`, not the session cwd. That single line
resurrects `indexBudget`, which is currently pinned at its 150-token floor for
every project on earth once five index injections have occurred.

Constraint: the tool must satisfy the existing schema-completeness ratchet. Every
option declared, or the argument is silently dropped.

---

## 5. Component B — Capture

### The hook already exists — two things are missing

**Revised.** `plugin/hooks/post-tool.mjs` ships with matcher
`Edit|MultiEdit|Write|Bash|PowerShell|mcp__.*__(?:smart_edit|smart_write)` and is
handled in `adapter.mjs`, which is materially the design below. So this component
is no longer "add a hook". What remains:

1. **Wire `invalidateOnWrite` into the existing post-tool path.** It is still
   prose-only (1 raw reference, 0 code references, verified by probe) and still
   allowlisted, so staleness is lazy-only in production.
2. **Capture exit codes and test results**, which `derive.mjs` (§6) needs and
   which nothing records today — `buildDigest` takes command text from
   `tool_use` and deliberately skips `tool_result`.

The original design, retained because the reasoning still governs both items:

### ~~`plugin/hooks/posttooluse-capture.mjs` (new)~~

`hooks.json` gains `PostToolUse` with matcher
`Bash|Edit|Write|MultiEdit|NotebookEdit`. Read, Grep, Glob and every MCP tool
never invoke it.

The hook appends **one** bounded record and exits: exit code, stdout/stderr
truncated to 4 KB, before/after content hashes, anchor, timestamp. No parsing, no
diffing, no graph load. Fail-open on any throw.

### Pending invalidation, applied at next read

`invalidateOnWrite` is revived — but not called inside the write hook, because
that would load a 1 MB graph on the return path of every write. Instead the
capture record carries the invalidation intent, and the next graph read (the
`PreToolUse` injection path, which already loads the graph) applies pending
invalidations before serving.

Correctness is unchanged: the property that matters is that a stale finding is
never *served* as fresh, and serve time is where that is enforced. This is
strictly fewer graph loads than eager-as-documented, with the same guarantee.

`WIKI_GRAPH.md` is corrected to describe this: PostToolUse on writes and
commands, results derived at Stop, invalidation applied at next read.

Performance budget, measured not asserted, recorded in
`HOOKS-PERFORMANCE-OPTIMIZATION.md`: **zero** added cost on read-path calls (the
matcher means the hook does not run), and **p95 under 50 ms** for the capture hook
itself on write/exec calls. Measured by median-of-9 across multiple process
launches, not a single shot — timing on these machines has roughly 4× run-to-run
variance.

---

## 6. Component C — Production (making a default install produce findings)

### `hooks-core/derive.mjs` (new) — run at Stop, no model call

| Detector | Anchor | Confidence cap |
|---|---|---|
| Command failed then succeeded | command + project | 0.90 |
| Test/build red → green | files edited between | 0.85 |
| User correction detected | files in scope | 0.60 |
| Re-read churn | the file | 0.40 |

All four route through `harvest-write.mjs`'s anchor discipline — `indexFile`
first, refuse anything whose anchors do not resolve — and are stamped
`ORIGIN_HARVESTED`, never `ORIGIN_HUMAN`.

**Redaction is mandatory, not optional.** Captured stderr can contain secrets,
and finding claims are both injected into context and exported to markdown. Claim
text is capped and passed through secret-pattern redaction before storage.

Precision caveat, stated because it is real: "failed then succeeded" does not
prove the second command fixed the first. Confidence caps plus Component E's
utility pruning are what keep low-precision derivations from accumulating.

### The other three measures

- Standing rule nudging `wiki_write`, inside the existing standing budget.
- `localEndpoint()` detection surfaced loudly in `doctor` and at SessionStart
  ("local model found — harvest is on, free and private").
- README, `WIKI_GRAPH.md` and #204 state plainly that a default install without a
  local model ships the structural skeleton, and that verdicts require
  `TOKEN_OPTIMIZER_HARVEST` or a local endpoint.

---

## 7. Component D — Correctness, distinct from usefulness

Component E measures whether a finding *suppresses reads*. A confidently wrong
finding suppresses reads better than a hedged true one, so utility alone
optimises directly against risk 1 ("wrong findings are worse than none").

So:

- **`contradicts` is wired.** When a session re-derives against an anchor and
  reaches a conclusion that disagrees with a served finding, the disagreement is
  recorded as a `contradicts` edge rather than an overwrite — which is what the
  schema declared and nothing ever wrote.
- **`answers` is wired** (finding → task), closing the other dead edge kind.
- **Confidence promotion requires no outstanding contradiction.** Measured utility
  ranks a finding; it never raises its confidence.

This also closes an accidental competitive gap: contradiction modelling is
something Graphiti-class systems do and we declared but never did.

---

## 8. Component E — Measurement

### Layer 1 — explicit reference (independent signal)

For each injection, classify from logged events only:

- `referenced` — a subsequent `wiki_query` or `expand` names that finding
- `not-referenced` — no such call
- `unknown` — the session ended immediately; **excluded from the denominator**

Layer 1 deliberately does **not** use read-suppression. Read-suppression is
Layer 2's estimand, and using it in both would make the calibration loop
circular — it would report a strong correlation between two spellings of the same
quantity and mean nothing.

### Layer 2 — per-finding causal effect

Leave-one-out: for a finding `f`, arm decided by `hash(f.key + sessionId)`, stable
for the session. Effect = mean downstream read cost when `f` was withheld minus
when `f` was served.

Guards:

- Never withhold `pinned` or `ORIGIN_HUMAN` findings. A person asserted it;
  withholding it to run an experiment overrides an explicit human decision. These
  are always served and simply carry no causal score.
- A finding enters the experiment only after **4 ordinary injections**, mirroring
  the threshold `substitutionBudget` already uses before it trusts an arm.
- At most one finding withheld per touch — with two, the effect cannot be
  attributed to either, and the user's worst case stays "one finding missing from
  a served set".
- On by default; `TOKEN_OPTIMIZER_LOO=off` disables it.

Statistics:

- **Empirical Bayes shrinkage** toward the population mean, so a two-observation
  finding cannot post a wild score.
- **FDR control** (Benjamini–Hochberg, **q = 0.10**) on published per-finding
  verdicts, because hundreds of findings tested individually produce false
  discoveries. A verdict is published only when it survives BH adjustment **and**
  has at least 6 served and 3 withheld observations; otherwise the finding is
  reported as "no verdict" rather than given a number.
- **ε-exploration at 10%** — matching the existing holdout fraction — where
  injections ignore the utility ranking, so a finding ranked down still accrues
  observations. Without this, utility feeds ranking feeds injection frequency
  feeds observations, and a low score becomes self-fulfilling.
- **Serving-policy version** logged with each observation, so effects are never
  pooled across policy changes.

### Stated limitations (these go in the report, not just this doc)

1. **Interference.** Withholding `f` can still expose `f`'s information because the
   model reads the file. The estimand is therefore *marginal contribution under
   the current serving policy*, not "the value of `f`". Reported as such.
2. **Power.** Most findings will never see enough injections for a verdict.
   Empirical Bayes handles this correctly by declining to give one; the report
   says how many findings have no verdict rather than implying coverage.
3. **Selection.** The population effect is estimated on non-pinned,
   non-human-origin findings and does not extrapolate to the excluded ones.
4. Arm sizes are reported, so small-sample imbalance is visible.

### Calibration loop

Does Layer 1's `referenced` label predict Layer 2's causal effect? If referenced
findings show no better effect than `unknown` ones, the report says the label is
theatre instead of publishing it — the same discipline `forecast.mjs` already
applies to predictions.

### Reporting

`balanceSheet()` routes into `get_optimization_report`. `approxCost`'s hardcoded
`$3/1M` is replaced by `pricing.mjs`, and a dollar figure appears **only** on
measured-counterfactual lines. Estimated lines show tokens, labelled as
estimates, with no currency.

---

## 9. Component F — Recall, so "no embeddings" is falsifiable

`WIKI_GRAPH.md` says embeddings get added "if measurement shows real recall
loss". Nothing measures recall, which makes the stance unfalsifiable.

Held-out retrieval probe: for each finding, hide it and ask whether traversal
plus BM25 would surface it from its own originating context. Offline,
deterministic, no model call, no embedding dependency. Reported alongside the
balance sheet so the decision stays honest as the graph grows.

---

## 10. Component G — The detector and its allowlist

### Fix both holes in `tests/hooks/reachability.test.mjs`

1. **Strip comments and string literals before matching.** This is the change that
   would have caught `invalidateOnWrite` without an allowlist entry.
2. **Extend beyond `export function`** to four declaration classes:
   - exported consts (38 currently invisible)
   - event kinds — every `kind` read must have a product writer and vice versa
   - edge kinds — every member of `EDGE_KINDS` must have a write site
   - tool names appearing in injected prompt text must exist in the registry

Sub-class coverage after the fix:

| Sub-class | Example | Covered by |
|---|---|---|
| export with no product caller | `invalidateOnWrite` | comment-stripped scan |
| reader with no producer | `kind:'query'` | event-kind census |
| producer with no reader | `kind:'lessons'` | event-kind census |
| declared const never used | `contradicts`, `answers` | const + edge-kind census |
| referent with no target | `wiki_query` | tool-name census |

### Empty the allowlist

All 16 entries get one of two outcomes — wired to a real call site, or deleted.
Nothing stays parked. The allowlist ends at zero backlog entries plus the one
genuine public API (`policyText`).

Expected shape of that work, from the verified 0-reference census:

- **Wire:** the calibration loop (`logForecast`, `observeOutcome`, `forecastPanel`,
  `worthSurfacing`) needs an entry point; keep-warm needs its outcome half
  (`recordRefresh`, `recordRefreshOutcome`) called or it can never learn;
  `invalidateOnWrite` is wired by Component B.
- **Decide per item:** consolidation (`selectForConsolidation`,
  `consolidationRatio`, `contentAnchor`), `cacheOrdered`, `renderStanding`,
  `auditFindings`, `manifestSize`. Several are likely deletions.
- **Remove the stale entry:** `forTouch` has 2 real call sites.

Judgement calls here are brought to the user individually rather than decided
alone.

---

## 11. Component H — Dashboard (#311) — **CLOSED, not in scope**

**Superseded by #313** (merged 2026-08-25T15:29:48Z), verified at HEAD:

- Bug 1: `/wiki` now `res.redirect(302, '/wiki.html')` at `web-server.ts:655`,
  served by the `express.static` path that always worked, with
  `tests/unit/dashboard-web-server.test.ts` asserting the 302 and the 200.
- Bug 2: the `.claude-global` path is now `getLegacyClaudeHooksDataPath()`,
  explicitly marked compatibility-only, with current activity read from the
  cross-client diagnostic ledger via `/api/diagnostics/hooks`.

No work remains here. The original analysis follows for the record.

### ~~Original plan~~

**Bug 1** — `/wiki` 404s. The reporter confirmed the file exists and
`express.static` serves it at `/wiki.html`, so this is a `res.sendFile`
root/absolute-path problem, not a missing asset. Diagnosed rather than guessed.
Regression test fetches `/wiki` and asserts 200.

**Bug 2** — the session widget's hardcoded `~/.claude-global/hooks/data` becomes
the same per-project `.token-optimizer` resolution the hooks use.

---

## 12. Schema compatibility

Nothing in this work changes a graph record's shape: utility lives in metrics,
`contradicts`/`answers` use the existing edge record, extractor fields are
additive. So `GRAPH_VERSION` stays at **1**.

Built anyway, as the safety net for the first change that does need it:

- Version-**range** reader in `load()`, plus a pure per-step `upcast()`.
- **The compaction fix.** `wiki.mjs:346` carries the same
  `v !== GRAPH_VERSION` filter, so a future bump would silently **drop** v1
  records while compacting — a second route to the same data loss. The upcaster is
  wired there too.
- Forward-incompatible records (a v3 from a newer client) are still skipped:
  ignoring the future is safe, ignoring the past is data loss.
- Regression test: a v1 log loads with every node intact.
- The header comment claiming "nothing has been released" is corrected. It ships
  on npm.

---

## 13. Testing

TDD: failing test first for each behaviour. Beyond unit coverage, each resurrected
capability gets a test that drives the **product path**, not the function:

- `wiki_query` callable through the server dispatch, not just the module
- a `query` event present in the log after a `wiki_query` call
- a write marking findings stale via the hook chain, not via a direct
  `invalidateOnWrite` call
- a `contradicts` edge present after a disagreeing re-derivation
- BM25 ranking asserted to order better than substring on a fixture

`npm run sync:hooks` after every `hooks-core` change; CI's `sync:hooks:check`
enforces the eleven vendored copies. `tests/hooks/injection.test.mjs:145` becomes a
real assertion instead of one that locks in a dangling reference.

---

## 14. Acceptance criteria

Deliberately **live-census based, not CI-green based**, because every one of the
ten instances passed CI and was caught by live measurement or code reading.

After the PR merges and one working session on this repository:

| Criterion | Today |
|---|---|
| `kind:'query'` events > 0 | 0 |
| `kind:'index'` events > 0 | 0 |
| declared edge kinds with zero write sites | 2 (`contradicts`, `answers`) |
| findings on a default install (no harvest opt-in) > 0 | 1 total, ever |
| reachability allowlist backlog entries | 9 (11 listed; `forTouch` stale, `policyText` legitimate) |
| dead event kinds (read-no-writer or writer-no-reader) | 2 |
| `/wiki` returns 200 | ~~404~~ closed by #313 |
| `get_optimization_report` shows the graph balance | absent |

A census script reports these, so the state is checkable at any time rather than
re-derived by audit.

---

## 15. Delivery

One PR on `feat/close-wiki-graph-gaps`, closing #204. (#311 needs nothing — #313
closed it.) The work is split across **three plan documents** so each produces
working, testable software on its own, all landing on the one branch:

- **Plan 1 — Retrieval and wiring:** `lexical.mjs` BM25, `wiki_query`, the `query`
  event, `invalidateOnWrite` wired, `contradicts` and `answers` written, `lessons`
  resolved.
- **Plan 2 — Production and measurement:** `derive.mjs` extractors, the
  cold-graph measures, Layer 1, Layer 2, calibration, report routing, pricing,
  recall probe. Depends on Plan 1 for the query signal.
- **Plan 3 — The detector and its allowlist:** comment stripping, the four
  declaration classes, and the nine wire-or-delete decisions.

Ordered commits:

1. Schema safety net (range reader, upcast, compaction fix, regression test)
2. Detector fixes (comment stripping, four declaration classes)
3. Capture (PostToolUse, pending invalidation, `invalidateOnWrite` wired)
4. Retrieval (`lexical.mjs`, `wiki_query`, `query` event)
5. Production (`derive.mjs`, standing rule, endpoint surfacing)
6. Correctness (`contradicts`, `answers`, confidence gating)
7. Measurement (Layer 1, Layer 2, calibration, report routing, pricing)
8. Recall probe
9. Allowlist emptied
10. ~~Dashboard (#311)~~ -- closed by #313, nothing to do
11. Docs, issue updates, census script

Honest note: this is a large diff spanning MCP tools, hooks, metrics, docs and
dashboard. The commit order is what keeps it reviewable.

---

## 16. Risks

| Risk | Mitigation | Residual |
|---|---|---|
| Emptying the allowlist expands scope unpredictably | Each entry is wire-or-delete, judgement calls surfaced individually | Real. Some entries may be larger than they look |
| Extractor noise floods the injection budget | Confidence caps, utility pruning, ε-exploration | Low-precision derivations still compete initially |
| Layer 2 degrades a real turn | Three guards; worst case is one finding missing from a served set | Accepted deliberately |
| Secrets in captured stderr reaching findings | Mandatory redaction and caps before storage | Pattern-based redaction is imperfect |
| PostToolUse latency | Scoped matcher, capture-only, measured budget | One process spawn per write/exec call |
| Utility rewards persuasive falsehoods | `contradicts` wired, confidence never promoted by utility | Detection depends on a re-derivation happening |
| Large single PR | Ordered commits | Review quality risk is real |

---

## 17. Docs and issues

- `WIKI_GRAPH.md` — BM25 now true; hit rate redefined to what is measured;
  PostToolUse and apply-at-next-read described; default-install honesty; recall
  probe named.
- `COMPETITIVE_GAPS.md` — per-gap status column; the stale concession about
  requiring the model to reissue against `smart_read` corrected, since zero-turn
  substitution shipped.
- `HOOKS-PERFORMANCE-OPTIMIZATION.md` — the capture hook's budget.
- `#204` — phases ticked with evidence from the census, not assertions.
- `#311` — already closed by #313; nothing to do.
- `#201` — out of scope; handled by the doc status pass, then closed as answered.
