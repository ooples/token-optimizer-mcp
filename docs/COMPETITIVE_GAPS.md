# Competitive gap analysis

Against `alexgreensh/token-optimizer` (1.7k stars, PolyForm Noncommercial), read
from its README and documentation site rather than from memory.

## A correction I owe first

On issue #201 I wrote that they "audit waste in your *setup*" while we "change
what the *operations* cost", and that those compose. **That was wrong.**

They ship active compression that changes operation cost directly:

- **Delta mode** — re-reads return only what changed (~20% claimed)
- **Structure map** — unchanged code re-reads return a function/class skeleton (~30%)
- **First-read skeleton** — large files return an outline on first read
- **Bash output compression** — 111 commands across 22 pattern families
- **Search result compression** — grep/rg condensed to top hits plus counts (~15%)

Delta-on-re-read is the exact mechanism I called our headline differentiator.
They have it, and theirs is **transparent** — it happens in hooks without the
model choosing to cooperate. Ours requires the model to reissue the call against
`smart_read`. That is a worse interaction, not a better one, and the comment on
#201 should be corrected.

## Where we are genuinely ahead

| | Us | Them |
|---|---|---|
| **License** | MIT | PolyForm **Noncommercial** — unusable at work |
| Clients | 15 | 6 |
| Savings measurement | **withheld control arm** | counterfactual baseline + metered receipts, no control |
| Operational tooling | ~100 MCP tools (git, build, db, API, search) | none — it is not an MCP server |
| Cross-session knowledge | anchored graph with computed staleness | decision extraction, capped at 10/session |
| Enforcement | refusal with the replacement named | nudges and transparent rewriting |

The licence is still the single most decisive line for anyone using this at
work, and the control-arm measurement is a claim they cannot make. The MCP tool
surface is a different product axis they do not compete on at all.

## The gaps, ranked by how much they cost us

### 1. Compaction survival — the biggest hole

They checkpoint at five fill thresholds and four quality thresholds, snapshot
before subagent fan-out and after edit batches, score checkpoints by relevance,
restore the richest eligible one after compaction, and reconstruct cold sessions
from SQLite without re-reading transcripts.

We have a `PreCompact` hook that shells out to the CLI wrapper, and I have
already flagged that it is unverified against a real compaction cycle.

This is worth stating plainly: **the wiki graph is a better substrate for this
than checkpoints are** — findings are anchored, stale-checked and survive
compaction by construction, where a checkpoint is a frozen blob. We built the
harder half and skipped the easy half.

### 2. Context quality scoring

Seven signals (fill, compaction depth, waste tokens, stale reads, result bloat,
decision density, agent efficiency), letter grades S–F, a status-line integration
with colour transitions, and degradation tracking framed against MRCR falling
93% → 76% as context grows.

We have nothing here. It is also the most *visible* feature they have — it is on
screen constantly, which is worth more than its accuracy.

### 3. Progressive disclosure of tool results

Outputs over 4 KB are replaced with a preview plus a retrieval pointer; an
`expand` command fetches the original without re-running; re-expanded content is
netted back out of the savings total.

We have `optimize_text` by key, but nothing automatic and no pointer discipline.
This pairs naturally with our enforcement: refusing a large read is strictly
worse than substituting a preview the model can expand.

### 4. Behavioural waste detection

Eleven detectors: PDF/binary ingestion, web-search overhead, retry churn, tool
cascades, looping, overpowered model, weak model, bad decomposition, wasteful
thinking, output waste, cache-instability patterns in CLAUDE.md.

Zero for us. Most are cheap to implement from data our hooks already see.

### 5. Prompt-cache economics

Keep-warm TTL refresh with a cost tripwire that auto-disables when the trade
turns negative, detection of CLAUDE.md constructs that break the cache, and
detection of mid-session model switches that invalidate it.

Zero for us, and cache economics is real money — a broken cache costs more than
most compression saves.

### 6. Model routing

Task-sizing before spending, weak/overpowered model detection, routing advice
injected into CLAUDE.md with a 48-hour staleness guard.

Zero for us.

### 7. Audit and coaching surface

`/token-optimizer` runs six parallel agents with guided fixes; `/token-coach`
does a 30-day pattern analysis; plus an install doctor scored out of ten, a
savings report across four pricing tiers, trends, drift-vs-snapshot, and a
per-message cost breakdown.

We have `get_optimization_report`. The gap is less about capability than about
there being an obvious thing to run that tells you what to do next.

### 8. Dollars, not tokens

They price against four tiers and report `$/month` with receipts. We report
tokens. Same data, and the unit people actually feel.

### 9. Skills and configuration health

Unused-skill detection, per-skill context cost, CLAUDE.md bloat and
cache-pattern auditing. Zero for us.

### 10. Memory health

An eight-auditor MEMORY.md review with stale-entry detection. Our wiki staleness
is conceptually the same machinery pointed at a different file; we have not
pointed it there.

### 11. Distribution and trust

Per-release `CHECKSUMS.sha256`, an auto-update toggle, a clean uninstall that
preserves user hooks, and an install doctor. We have none of it, and we ask
people to install hooks that refuse their tool calls.

### 12. Fleet auditor

Scans transcripts across Claude Code, Codex and custom clients for
opportunities. We have 15 client integrations and no cross-client analysis —
we are better positioned for this than they are and have not built it.

## What I would do, in order

1. **Turn the refusal into a substitution.** We already compute a diff inside
   the refusal for the zero-turn path. Extending that to a preview-plus-pointer
   for every large read closes gap 3, removes our worst interaction (making the
   model reissue a call), and matches their delta mode without needing model
   cooperation.
2. **Finish compaction survival on top of the wiki graph.** Checkpoint the
   session's finding set and restore it after compaction. The graph already does
   the hard part; this is wiring.
3. **Quality score and status line.** Cheap, constantly visible, and it makes
   the holdout measurement legible instead of buried in a dashboard.
4. **Dollars everywhere.** A pricing table and a multiply.
5. **Waste detectors.** Start with retry churn, tool cascades and cache-breaking
   CLAUDE.md patterns — all visible in data we already collect.

Gaps 6, 9, 10, 11 and 12 are real but none of them decide an evaluation the way
1–3 do.

## The honest summary

They are ahead on **breadth, polish and visibility**. We are ahead on
**licence, client coverage, measurement rigour and operational tooling**, and
the wiki graph is a genuinely differentiated bet that nothing in their feature
list matches.

But we are behind on the thing a user notices in the first five minutes, and
"we have a better substrate" does not survive contact with a competitor whose
dashboard shows a letter grade and a dollar figure the moment you install it.
