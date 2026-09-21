# Head-to-head: Token Optimizer MCP vs HeadRoom

Measured and written 2026-09-21. Supersedes nothing — `docs/COMPETITIVE_GAPS.md`
is about a **different** competitor (`alexgreensh/token-optimizer`, 1.7k stars)
and remains valid on its own terms, though several gaps it lists as "zero for
us" have since been built (see [What COMPETITIVE_GAPS.md now gets
wrong](#what-competitive_gapsmd-now-gets-wrong)).

---

## Addendum, later the same day: what the fixes changed

The nine blockers this document implied were worked through in one pass;
four of its own statements did not survive that and are corrected here
rather than quietly edited below.

**The scope leak was narrower than stated.** The proxy path already filtered
correctly (`TRANSFERABLE_SCOPES` in `src/compress/knowledge.ts`), and
`forRepeatedAct` / `forSharedCommand` already refused a shared graph. Only
`forCommand` genuinely leaked -- it matches on command text with no anchor to
the current tree -- with `forTouch` narrowly exposed. Both now filter, proven
by reverting the fix and watching one case go red.

**The kompress caveat was wrong, and it was wrong in their favour.** I wrote
that their `rag-conversation` 0.1% was a missing model flattering us.
Downloading `kompress-v2-base` and installing `optimum` left the warning
firing and the totals byte-identical: their `content_router` loads the model
in the background and routes around the deep path until it is ready, so a
one-shot process measures their cold behaviour BY DESIGN. The 52.0% stands
for a cold process. Their warm persistent proxy remains unmeasured.

**The `grep-output` gate failure was not a regression.** Both arms report
0.0% gross there, so equal cost is forced and the gate was demanding a strict
win it could not have. Relaxed, and paid for with a guard that fails the run
if NO workload shows a strict win.

**We now have an accuracy benchmark, and building it found a product gap.**
`bench/accuracy/squad-eval.mjs` runs SQuAD v2 with a baseline arm through the
Claude Code subscription. Its first run reported baseline 1.000 / ours 1.000
at 0.0% reduction -- an inert arm, caught by its own vacuity gate. The cause
is not size: **the engine is completely inert on NDJSON / JSON-lines** (0.0%
at 10.9KB, 55.4KB and 83.3KB) while the identical rows as a pretty-printed
JSON array compress 94.6%. `looksLikeJson` claims NDJSON, so the engine is
selected; `compressJson` then fails its whole-text `JSON.parse` and returns
the input untouched. NDJSON is what docker, k8s, structured loggers and
`jq -c` emit, so this is a live gap in the core claim, and it is invisible to
`head-to-head.mjs` because HeadRoom's dumped fixtures are pretty-printed
arrays. **It is the highest-value thing found today, and it is now fixed:**
46,707 -> 3,212 (93.1%) with the anomalous `ERROR` record kept whole, while a
damaged line and an unprofitably short document still come back byte for byte.

Also closed: the README table is generated and gated
(`bench/compression/readme-table.check.mjs`, proven by mutating `48.2%` to
the `61.3%` that once shipped and watching it fail); `codebase-exploration`
is published as **theirs by 1.4 points** on this base, 47.4% against our
46.0%, the earlier "parity" having been a figure from another branch; the
retention column travels with every reduction claim; the
false control-arm line is struck from `COMPETITIVE_GAPS.md`; the frozen
comparators carry provenance; and `npm test` no longer runs 31 of the
competitor's own suites.

---

## 0. Two corrections to the brief, before anything else

**The star count is 73,347, not 78,000.** Read from the GitHub API today, not
from a secondary index:

```
gh api repos/headroomlabs-ai/headroom --jq '.stargazers_count'  # 73347
```

Third-party trackers disagree wildly about this repo — one index lists 73.1k and
another 42.4k for the same project, weeks apart. Quote the API, never a tracker.
The error direction matters: 78k overstates them by 6%, which is nothing, but it
means the figure came from somewhere unverifiable, and the rest of a competitive
brief built the same way is where real errors hide.

**"HeadRoom Learning" is `headroom learn`.** It is not a hosted service and not
a model — it is a CLI subcommand that mines failed sessions and appends rules to
`CLAUDE.local.md`. This matters for the comparison, because a subcommand and a
knowledge graph are not competing on the same axis (§5).

### Distribution, which is the only column we lose by two orders of magnitude

|                | Token Optimizer MCP | HeadRoom            |
| -------------- | ------------------- | ------------------- |
| Stars          | 531                 | **73,347** (138×)   |
| Forks          | 65                  | **5,645**           |
| Open issues    | 3                   | 705                 |
| First commit   | 2025-10-11          | 2026-01-07          |
| Licence        | **MIT**             | Apache-2.0          |
| Language       | TypeScript / Node   | Python + Rust + TS  |
| Distribution   | npm                 | PyPI · npm · Docker · GHCR |
| Docs           | in-repo markdown    | docs.headroomlabs.ai + `llms.txt` |
| Community      | none                | Discord, Trendshift #1 |

They reached 73k stars in 8.5 months; we have had 11 and reached 531. **Nothing
in the feature analysis below changes the fact that the gap is distribution, not
capability.** Their licence is the weaker one for a corporate buyer and it has
not cost them anything, so our MIT advantage is not the lever we have been
treating it as.

---

## 1. Method and provenance

Every number below is labelled with how it was obtained. Three tiers:

- **MEASURED TODAY** — regenerated in this session on this machine.
- **RECORDED** — a constant committed in this repo from an earlier run of their
  harness, not regenerated today.
- **READ** — read from their source tree or README, not executed.

Their code is a real clone at `.codex/headroom-research`, `headroom-ai` **0.37.0**.
It was 15 commits behind when this was written and has since been
fast-forwarded to `67eb910` (2026-09-19), which brings in
`feat(beacon): schema v2 — routing/compression training signal, gzip transport (#3253)`
— the commit that matters for §4. The measurements in §2 were taken both
before and after that fast-forward and are identical.

Two configuration caveats on their arm, stated up front because both **flatter
us**:

1. ~~**`Kompress model not ready`** — their text compressor never loaded, so
   their `rag-conversation` 0.1% is a missing model rather than a capability
   limit.~~ **RETRACTED — see the addendum.** The model was downloaded and
   `optimum` installed; the warning still fired and the totals were
   byte-identical. Their `content_router` loads it in the background and
   routes around the deep path until ready, so a one-shot process measures
   their cold behaviour by design. The figures stand for a cold process.
   Their warm persistent proxy is a separate, still-unmeasured arm.
2. Their native Magika/ONNX content detector is disabled by default on Windows,
   so content detection ran on the pure-Python fallback.

This project has twice published a competitive number that turned out to be
their side misconfigured. Both caveats above are that same failure mode caught
before publication rather than after.

---

## 2. Compression, measured today

`python bench/compression/headroom/run-theirs.py .codex/headroom-research <out>`
then `node bench/compression/head-to-head.mjs <out>`. Both arms compress **the
same bytes**, dumped from their harness; tokens counted with `cl100k_base` over
both arms' real output. **MEASURED TODAY.**

| workload             | payload chars | ours (tok) | theirs (tok) | their arm         |
| -------------------- | ------------: | ---------: | -----------: | ----------------- |
| log-entries          |       105,155 |  **96.9%** |        85.5% | crusher-lossy-ccr |
| search-results       |       112,873 |  **97.3%** |        96.2% | crusher-lossy-ccr |
| api-responses        |        67,253 |  **97.8%** |        92.2% | crusher-lossy-ccr |
| database-rows        |        55,667 |  **94.9%** |        91.1% | crusher-lossy-ccr |
| agentic-conversation |       248,764 |  **86.6%** |        26.6% | pipeline@0.10     |
| rag-conversation     |       171,973 |  **86.7%** |         0.2% | router            |
| **total**            |       761,685 |  **91.5%** |    **52.0%** |                   |

Chars tell the same story: 90.2% against 52.4%.

### The column we lose, which is the one that matters more

The same harness scores **retention symmetrically**, and it reverses the verdict:

```
retention units           3793
  in context     ours 345   theirs 1890   <-- THEY keep 5.5x more directly visible
  recoverable    ours 3448 in a named spill
  unrecoverable by us      0
spill store: 0.94x the input, on disk
```

**We reduce more partly by eliding harder.** Our spill is nearly the size of the
input, and every identifier in it costs a turn to retrieve. Zero unrecoverable
loss is a real guarantee and worth defending, but "91.5% vs 52.0%" without this
paragraph next to it is the kind of claim that gets audited and then quoted
against us. Their design keeps the answer in front of the model; ours keeps a
receipt for it.

### Cache-weighted cost, and a gate that is currently red

`node bench/compression/proof.mjs` — our arms **MEASURED TODAY**, their
comparators **RECORDED** as hardcoded constants in `bench/compression/fixtures.mjs`.

| workload              | theirs (recorded) | our best touchable | verdict         |
| --------------------- | ----------------: | -----------------: | --------------- |
| code-search           |             92.1% |          **97.6%** | ours            |
| sre-debugging         |             92.2% |          **98.4%** | ours            |
| issue-triage          |             72.8% |          **97.3%** | ours            |
| codebase-exploration  |             47.4% |          **48.2%** | **tie (0.8pt)** |

Three findings from that run that are not in any public claim:

1. **`proof.mjs` exits 1 today.** `GATE FAILED: grep-output: v1-frontier 15482
   effective vs ccr 15482` — the gate requires a strict win and gets a tie. Our
   flagship benchmark is red on `master`-adjacent work.
2. **History compression is cache-negative on agent-loop shapes**: `v3-history`
   scores **−113.4%** effective on `agent-loop` and **−43.3%** on
   `agent-loop-logs`; `v4-substitute` reaches **−421.1%**. Only the frontier
   arms are safe there.
3. **The README's headline table cannot be regenerated.** `README.md` §"Why it
   wins" prints an eight-row table ("936 vs 948", "859 vs 1,068", …) and
   attributes it to `node bench/compression/proof.mjs`. Six of those eight
   figures appear **zero times** in today's output, which emits twelve workloads
   with only four comparators and different absolutes. This is the third
   recorded instance of benchmark prose drifting away from its generator.

---

## 3. Feature parity matrix

**READ** from their source tree and README unless marked otherwise.

### Where we win

| Capability | Us | Them |
| --- | --- | --- |
| Raw + token reduction on tool output | **91.5%** (measured) | 52.0% (measured, model missing) |
| Cache-weighted cost discipline | **explicit `effective`/`steady` metric, gated in CI** | `CacheAligner` only *flags* volatile content; never rewrites |
| Refusal-based enforcement | **the wasteful call is denied, with the substitute named** | advisory; compresses what passes through |
| Zero-turn substitution on re-read | **returns the diff inside the refusal** | re-compresses the same bytes again |
| MCP operational surface | **74 tools** (git, build, db, API, search) | 3 (`headroom_compress`, `_retrieve`, `_stats`) |
| Cross-session knowledge | **anchored graph, computed staleness, dead ends, traversal** | flat markdown rules file |
| Waste detection → durable fix | **detector produces a reversible skip rule + briefing** | none |
| Prompt-cache economics attributed to a source line | **yes** (`CLAUDE.md:2 has an embedded timestamp…`) | flags volatility, does not attribute or price |
| Model routing from measured episode outcomes | **yes** | none |
| Cross-project fix transfer by content hash | **`fleet_audit`** | none |
| Licence for commercial use | **MIT** | Apache-2.0 (also fine) |
| Telemetry | **none at all** | beacon **on by default** |

### Where we lose

| Capability | Them | Us |
| --- | --- | --- |
| **Distribution** | 73,347 stars, PyPI + npm + Docker, docs site, Discord | 531 stars, npm, in-repo docs |
| **Retention in context** | **1,890 / 3,793 units kept visible** | 345 |
| **Accuracy benchmarks** | 16 datasets across 3 tiers (§4.3) | **zero** |
| **Managed / team product** | offered (§4.1) | **none** |
| **Anonymous telemetry** | shipped, opt-out (§4.2) | **none** |
| **Library API** | `compress(messages)` in Python *and* TypeScript | MCP server entrypoint only; `exports` exposes `dist/server/index.js` and nothing else |
| **Framework adapters** | LangChain, LiteLLM, Agno, Strands, Vercel AI SDK, ASGI, Anthropic/OpenAI SDK wrappers | none |
| **Output-token reduction** | verbosity steering + reasoning-effort routing, both providers | **none** — `reasoning_effort` / `budget_tokens` appear nowhere in `src/` or `hooks-core/` |
| **Agents wrapped by one command** | 19, via `headroom wrap <tool>` / `unwrap` | 16 clients, manual config per client |
| **Trained compression model** | `kompress-v2-base` on HuggingFace | BM25 + heuristics (deliberate: no Python, no weights, no RAM floor) |
| **Image compression** | 40–90% via trained router | dedup of repeated frames only |
| **Self-update + supply chain** | `headroom update`, SBOM (CycloneDX + SPDX), vuln scans, `server.json` | none |
| **Semantic code navigation bundled** | installs Serena on wrap | none |

### Genuine ties

Reversible retrieval (their CCR ↔ our named spill + content-addressed
`expand`), local-first compression with nothing sent out to compress, a proxy
mode, a holdout control arm for measurement — **they added the holdout too**
(`HEADROOM_OUTPUT_HOLDOUT=0.1` flips their dashboard card from `estimated` to
`measured`), so "a control arm is a claim they cannot make" is no longer true
and must come out of our materials.

---

## 4. The four items the brief named

### 4.1 Managed instance

**What they do.** OSS stays Apache-2.0; a "Headroom for teams" section at the
bottom of the README sells the operational layer: shared always-on deployment,
centralised config and version rollout, org-wide savings dashboards, SSO and
access control, air-gapped and VPC installs, and support — self-hosted or fully
managed. No pricing page, no tiers, no signup. A single mailto:
`hello@headroomlabs.ai`, qualified on "rough monthly LLM spend".

**Why that shape is right and we should copy it exactly.** It is a
demand-discovery instrument, not a product. It costs one README section, commits
them to nothing, keeps the OSS promise unambiguous ("everything in this repo
stays open source"), and the qualifying question filters to buyers. Building a
control plane before anyone has emailed is the expensive version of this.

**What we can sell that they cannot.** Their managed pitch is *deployment* of a
stateless compressor. Ours would be **the graph**: an org-wide knowledge graph
where a finding measured in one repo transfers to every repo with the same file
contents. `fleet_audit` already does this on one machine. That is a
fleet-shaped, seat-priced, genuinely sticky product, and nothing in their
architecture competes with it — a compressor has no state worth centralising.

**Do not** ship a hosted compression service. Compression is local-first in both
products and that is a promise, not an implementation detail.

### 4.2 Anonymous telemetry

**Their design, read from `headroom/telemetry/beacon.py`.** Two switches,
deliberately separate, with a docstring explaining why:

- `HEADROOM_TELEMETRY` — **off by default, opt-in.** Local aggregation only,
  feeds `/stats`. Fail-closed: only an explicit on-value enables it.
- `HEADROOM_BEACON` — **on by default, opt-out.** Uploads an anonymous session
  summary. Killed by `HEADROOM_BEACON=off`, the `DO_NOT_TRACK=1` convention, or
  `--offline`.
- `HEADROOM_OTEL_METRICS_*` — operational metrics to **your own** collector,
  which they never see.

The separation is the good idea: *"an operator who turned on local stats has not
thereby agreed to upload anything, and must not start doing so on upgrade."*
The policy is one auditable constant, `BEACON_DEFAULT_ON = True`, with a comment
saying flip it to make the product opt-in.

**Payload** (`headroom/telemetry/session.py`, one event per activity burst):
`schema_version`; session id/seq/duration/turns/ended/final; tokens
original·attempted·input·output·saved·tool_saved·cache_read·cache_write·uncached;
rates saved_pct·eligible_pct·yield_pct·cache_read_pct·overhead_pct; compression
transforms and per-strategy `n`/`tokens_in`/`tokens_out`; overhead and latency
ms, total and per turn; passthrough turns; response-cache hits; skips; sources;
providers; models; failures and `failure_statuses` by HTTP status. Never prompts,
completions, code or file paths. Receiver is a 361-line Cloudflare Worker at
`deploy/beacon/worker.js`, committed.

**The strategic problem for us.** We ship a `telemetry-none` badge and an
"Honest comparison" row that says **None**. That is currently a differentiator
*against them*, and the upstream commit we do not yet have —
`feat(beacon): schema v2 — routing/compression training signal` — shows where it
goes: they are now harvesting **training signal** from real workloads. That is a
compounding data advantage no feature ships around.

**Recommendation: opt-in, and keep the badge honest.** Add
`TOKEN_OPTIMIZER_BEACON` defaulting to **off**, honour `DO_NOT_TRACK`, and change
the badge from `telemetry-none` to `telemetry-opt-in`. We lose the absolutist
line and keep the credible one; flipping to opt-out after shipping a
`telemetry-none` badge would be the kind of reversal that costs more than the
data is worth. Mirror their two-switch split exactly — local stats and upload
must be separately gated, for the reason their docstring gives.

Adopt their field list nearly verbatim, plus the two fields we have that they do
not: **holdout-arm outcome** and **graph-substitution counts**. Those are the
only metrics that can tell us whether the graph pays, and we currently learn it
one machine at a time.

### 4.3 Their benchmarks — we run none of them

**READ** from `headroom/evals/README.md`. Three tiers, `gpt-4o-mini`, Tier 1
~$3 / ~15 min:

| Tier | Datasets |
| --- | --- |
| 1 | GSM8K, TruthfulQA, MMLU, ARC-Challenge, HumanEval, SQuAD v2, BFCL, Tool Outputs, CCR Needle Retention |
| 2 | HotpotQA, MS MARCO, CodeSearchNet, Info Retention |
| 3 | HellaSwag, NarrativeQA, TriviaQA |

Also available: `natural_questions`, `triviaqa`, `toolbench`, `longbench`.
Methods: Before/After (F1 > 0.7, semantic similarity > 0.85, ground-truth
match), LLM-as-Judge for BFCL (score ≥ 3 of 5), and zero-cost compression-only
runs. Published Tier-1 results: GSM8K 0.870 → 0.870, TruthfulQA 0.530 → 0.560,
SQuAD v2 97% at 19% compression, BFCL 97% at 32%. They state themselves that
±0.03 at N=100 is inside the CI, which is more honest than most vendor tables.
CI runs the zero-cost CCR round-trip on every transforms PR plus a weekly
scheduled eval.

**Verified today: we reference none of these anywhere.** A ripgrep for all
fourteen dataset names across the repo, excluding `.codex/` and `node_modules`,
returns **no files**.

**Why this is the most dangerous gap in the document.** Every claim we make is
about *transmission cost*. We have gates for needles, relevance and steady-state
cache behaviour, and a symmetric retention score — all good, all
compression-intrinsic. **None of them is a task-accuracy measurement.** A
reviewer who asks "does the model still answer correctly at 91.5% reduction?"
gets, from us, a needle-survival gate; from them, GSM8K and SQuAD v2 with a
baseline column. Given §2 shows we keep 5.5× *fewer* identifiers in context than
they do, this is precisely the axis where we are most exposed and least
measured.

The cheapest credible answer is their zero-cost tier: **CCR Needle Retention and
Info Retention need no API key at all**, and SQuAD v2 at N=100 through
`gpt-4o-mini` is a few dollars. Start there, publish the baseline column, and
run it in CI on every `src/compress/**` PR.

### 4.4 `headroom learn` vs our graph and live wiki

| | `headroom learn` | Our graph + `wiki_write` |
| --- | --- | --- |
| Input | agent session transcripts | tool outcomes, exit codes, red→green transitions, corrections, re-read churn |
| Extraction | **one LLM call over a session digest** | three paths: `derive` (**no model, no credential**), `wiki_write` (model records its own conclusion), semantic harvest (credential-gated; free and local against `TOKEN_OPTIMIZER_HARVEST_ENDPOINT`) |
| Output shape | `context_file_rules` / `memory_file_rules`, each with `section`, markdown `content`, `estimated_tokens_saved`, `evidence_count` | graph nodes (file, symbol, task, finding) and edges (`derived_from`, `contains`, `supersedes`, `contradicts`, `related`) |
| Storage | `CLAUDE.local.md` (default, gitignored), `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `GROK.md` | per-project graph with content-hash staleness |
| Delivery | text in the prompt, every session, forever | fires when the model **reaches for the file**, with the invalidating diff when stale |
| Staleness | none — a rule about deleted code is served identically forever | **computed**; served with the diff that invalidated it |
| Negative knowledge | no | **dead ends** — "the skew fix was reverted once already" |
| Clients | 5 plugins: claude, codex, gemini, grok, opencode | 16 |
| Extra | `learn --verbosity` infers preferred terseness from interruption behaviour and feeds the output shaper | — |

**Honest verdict: we are ahead on substrate and behind on delivery.**

Their mechanism is architecturally crude — an LLM call per session writing flat
markdown that grows monotonically, sits in the cached prefix, has no staleness
model, and cannot express "we tried that and it failed". Ours is a staleness-
checked graph with traversal and negative knowledge, delivered at the moment of
attention.

But theirs *works everywhere on day one*, needs no hook, and its output is a
file the user can read and edit. And our delivery path has a known defect:
findings are written **with** scope (`hooks-core/derive.mjs`,
`hooks-core/harvest.mjs`, `hooks-core/harvest-write.mjs` all set
`project`/`organization`/`global`), but the injection path
`hooks-core/inject.mjs` contains **zero** occurrences of `scope` — consistent
with the recorded finding that project-scoped findings leak into unrelated
codebases. That is the single highest-value bug in this document: it makes the
differentiator actively harmful on a foreign repo. *(Re-verified this session
only as far as the `scope` grep; the end-to-end leak was not re-reproduced.)*

`learn --verbosity` is worth stealing outright. Inferring preferred terseness
from interruption behaviour is a genuinely clever read of a signal we already
capture and ignore.

---

## What COMPETITIVE_GAPS.md now gets wrong

Refreshing it is cheap and it is quoted internally. Since it was written we have
built: progressive disclosure with named cuts and an `expand` store (its gap 3),
prompt-cache economics attributed to a line (gap 5), outcome-based model routing
(gap 6), waste detection that becomes a ratchet (gap 4), `fleet_audit` across
projects (gap 12), and a `token_audit` surface (gap 7). Its remaining live
entries are checkpoint-style compaction survival (gap 1), context quality
scoring and a status line (gap 2), MEMORY.md health (gap 10), and distribution
and trust (gap 11) — and gap 11 is now shared with HeadRoom, who have SBOMs,
vuln scans and `headroom update` while we have none of it.

One line in it is now false: **"withheld control arm — a claim they cannot
make."** They can; see §3.

---

## 5. Follow-up plan, ranked

> **Items 1-3 as originally written are done and have been removed from this
> list.** The scope leak is closed (by provenance, not scope -- see the
> addendum), `proof.mjs` is green with a strict-win guard and its table is
> generated and drift-gated, and the accuracy arm exists and has measured
> n=30 at 53.8% reduction with baseline 0.933 against ours 0.967. What remains
> of item 3 is scale and wiring, kept below. The retention column is published,
> so that item is gone too.

Ordered by evidence-value per unit of work, not by size.

1. **Fix the scope leak in `hooks-core/inject.mjs`.** Highest value in the
   document. The graph is our only real differentiator and it currently injects
   one project's private findings into other repositories. Until this is fixed,
   every claim in §4.4 is a liability in a demo.
2. **Get `proof.mjs` green, then regenerate the README table from it.** The
   harness exits 1 (`grep-output` tie) and six of eight published figures are
   unreproducible. Fix the gate or the arm, then make the table a generated
   artefact so the fourth instance of this drift cannot happen.
3. **Ship the zero-cost accuracy tier.** CCR Needle Retention and Info
   Retention need no API key; add SQuAD v2 at N=100 for a few dollars. Publish
   the baseline column. Wire it into CI on `src/compress/**`. This is the axis
   where §2's retention result leaves us most exposed.
4. **Add the retention column to every public compression claim.** "91.5% vs
   52.0%, and they keep 5.5× more identifiers in context while we keep zero
   unrecoverable" is a stronger and more durable sentence than the first half
   alone. Publishing the column a competitor wins has repeatedly strengthened
   this project's arguments rather than weakening them.
5. **Opt-in telemetry** (`TOKEN_OPTIMIZER_BEACON`, default off, `DO_NOT_TRACK`
   honoured, two switches split as theirs are), carrying their field list plus
   holdout outcome and graph-substitution counts. Change the badge to
   `telemetry-opt-in` in the same PR — shipping the feature while the badge
   still says `none` is the worst of both.
6. **Add the "for teams" README section** — graph-fleet framing, one mailto, no
   pricing, no control plane. Copy their instrument, not their product.
7. **Output-token reduction.** Verbosity steering and effort routing are a small
   proxy change against a cost we do not touch at all, on models where output
   bills at 5× input. `learn --verbosity` is the configuration-free version.
8. **One-command wrap.** `headroom wrap claude` against our per-client manual
   configuration is a first-five-minutes difference, and first-five-minutes
   differences are what 73k stars are made of.
9. **Distribution work, treated as engineering.** PyPI is closed to us, but a
   Docker image, a published docs site, an `llms.txt`, an SBOM and a
   self-update path are all mechanical, and they are the difference the
   feature matrix does not explain.

Items 1–3 are correctness work and should not wait for the rest. Items 5–6 are
each roughly a day. Item 9 is where the 138× actually lives.

---

## What would invalidate this

- **Their Kompress model loading.** Their prose and conversation numbers in §2
  are measured with it absent. Re-run with `headroom-ai[ml]` warmed before
  quoting `rag-conversation` at anyone.
- **The 15 commits we do not have**, particularly beacon schema v2.
- **`fixtures.mjs` comparator constants**, which are recorded rather than
  regenerated; the four cache-weighted rows in §2 inherit whatever date they
  were captured on.
- **Any `src/compress/**` change**, which makes every §2 figure stale. They are
  reproducible by the two commands named at the top of §2 — re-run them rather
  than quoting this file.
