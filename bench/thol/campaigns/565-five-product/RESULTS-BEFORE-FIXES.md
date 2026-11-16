# Five-product campaign (#565): results before fixes

These are the results as recorded, published before any fix, as the
pre-registration requires. The run started on 2026-11-14.

- Claude Code 2.1.325, `claude-sonnet-4-6`.
- 8 arms × 12 development tasks × 3 repetitions.
- 288 successful runs, $61.66 at API prices.

## Failures (6 runs, every one listed)

| run | error | attributed to |
| --- | --- | --- |
| headroom-cache, log-needle-zh, rep 3 | `API Error: Connection refused (ECONNREFUSED)` on turn 8 | **Headroom.** Its proxy stopped accepting mid-session. The resume re-ran the run, and it passed. |
| tokenjuice, seo-audit, rep 2 | `OAuth session expired and could not be refreshed` on turn 1 | the rig: its staged login expired |
| cto, seo-audit, rep 2 | the same | the rig |
| cto-patched, seo-audit, rep 2 | the same | the rig |
| control, seo-audit, rep 2 | the same | the rig |
| headroom-cache, code-migration-py-xl, rep 3 | the same | the rig |

Every one of these was re-run on resume. The analysis uses `ok` runs only, so
each arm has 36 runs.

**Rig observation, not a result.** `headroom wrap claude` leaves its proxy
running after Claude Code exits. Each orphaned proxy holds 0.8–0.9 GB, and the
container held up to four at once. That did not change any cost figure, but
memory pressure on the host killed the campaign's controlling script twice. The
full board will stop leftover proxies after every run.

## Cost relative to control, paired by task

Computed with `bench/thol/analyse-campaign.py`: the mean and median of per-task
ratios, with a 95% bootstrap CI over tasks.

| arm | mean | median | 95% CI | verdict |
| --- | --- | --- | --- | --- |
| tokenjuice | 0.975 | 1.013 | [0.898, 1.043] | no detectable difference |
| tokenade-product | 1.028 | 1.077 | [0.881, 1.161] | no detectable difference |
| cto-patched | 1.036 | 1.069 | [0.904, 1.151] | no detectable difference |
| cto | 1.070 | 1.139 | [0.937, 1.174] | no detectable difference |
| headroom-cache | 1.080 | 1.056 | [0.937, 1.241] | no detectable difference |
| headroom-token | 1.145 | 1.098 | [1.022, 1.284] | **costlier** |
| **token-optimizer-mcp (ours)** | **1.149** | **1.089** | [0.953, 1.394] | no detectable difference; **highest mean** |

**Score.** Every arm scored the same as control on all 12 tasks. The one
exception is tokenjuice, which lost a third of the score on one task (minimum
ratio 0.67). Its mean is 0.977, but the CI spans 1.0.

**Turns.** Tokenade used the fewest (0.837×). cto and cto-patched used the
most (1.17× and 1.21×; both CIs exclude 1.0). Ours was 1.036×.

## Per task: cost ratio to control (mean of 3 repetitions)

| task | control $ | ours | tokenjuice | tokenade | headroom-cache | headroom-token | cto | cto-patched |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| code-bugfix-py (bias control) | 0.097 | 1.09 | 0.96 | 1.39 | 1.30 | 1.12 | 1.13 | 1.15 |
| code-comprehension-django | 0.399 | 0.63 | 1.06 | 0.55 | 0.67 | 0.73 | 0.50 | 0.47 |
| code-debug-pipeline-py | 0.301 | 1.09 | 1.17 | 1.09 | 1.77 | 1.44 | 1.20 | 1.09 |
| code-feature-validate-py | 0.215 | 1.22 | 1.01 | 0.98 | 1.06 | 1.05 | 0.99 | 0.99 |
| code-iterate-tests | 0.132 | 1.06 | 0.98 | 1.20 | 1.06 | 1.07 | 1.07 | 1.09 |
| code-migration-py | 0.175 | 0.72 | 1.07 | 0.81 | 1.23 | 1.20 | 1.17 | 1.04 |
| code-migration-py-xl | 0.141 | 1.18 | 1.06 | 1.06 | 1.02 | 0.99 | 1.15 | 1.15 |
| code-overview-cobra | 0.264 | 0.90 | 0.82 | 0.95 | 0.85 | 0.99 | 0.80 | 0.93 |
| code-refactor-split-py | 0.106 | 1.02 | 1.04 | 1.21 | 1.14 | 1.22 | 1.21 | 1.19 |
| code-settings-inventory-django | 0.237 | **2.27** | 0.83 | 1.34 | 1.05 | 1.73 | 1.35 | 1.44 |
| log-needle-zh | 0.164 | **1.47** | 0.67 | 0.62 | 0.78 | 1.13 | 1.15 | 0.82 |
| seo-audit | 0.252 | 1.13 | 1.02 | 1.14 | 1.03 | 1.08 | 1.10 | 1.05 |

## Why we lost: findings from the development transcripts

### 1. `smart_grep` returns large match sets uncompressed, and pages them

Seen on code-settings-inventory-django (2.27×). The task asks for every
`settings.NAME` read in Django: 577 matches.

- **Control** ran `grep -oh … | sort -u`. That is 2.7 KB, in one call.
- **Ours** was routed to `smart_grep`, and every repetition made 3–4 calls:
  - The output is JSON that repeats the `file`, `lineNumber`, `line` and `match`
    keys on every hit.
  - It reports `compressionRatio: 1` and `tokensSaved: 0` about itself.
  - It stopped at about 225 matches per call even when asked for `limit: 3000`,
    so the model paged three times.
  - In total, about 20k tokens went into context and were cache-written.

The same tool is our **best** task, code-comprehension-django (0.63×). There the
model needs a handful of locations, not an aggregate. The fault is how
`smart_grep` presents a large result, not that it is used.

### 2. `smart_read` of a huge log elides everything

Seen on log-needle-zh (1.47×). The first Read of a 512 KB log was routed to
`smart_read`.

- It returned 121 characters: "omitted 153 lines … expand", with no content.
- The model spent a `ToolSearch` turn loading `expand`, pulled 11 KB, and then
  grepped anyway.
- That is 10–12 turns against control's 7–8. Control's own Read was refused for
  size, so it went straight to parallel greps.

### 3. Every first use of an MCP tool costs a round trip

The tools are deferred, so each one needs a `ToolSearch` before its first call.
There were 8 on log-needle-zh across three repetitions, and 3 each on
settings-inventory, feature-validate and debug-pipeline. Each is a full turn that
re-reads the cached prefix.

### 4. Fixed overhead on short tasks

On the bias-control task, code-bugfix-py, we used only built-in tools and still
cost 1.09×. That is the SessionStart context and the MCP instructions with
nothing to compress, which is the effect the bias control was chosen to expose.

### 5. Small noisy Bash output is left alone

This was seen on the mock check before the campaign. tokenjuice and Tokenade
compact it; we bound only named runners above 30 KB. tokenjuice is the cheapest
arm here (0.975×), on log-needle-zh (0.67×) among others. That is consistent
with the finding, but not proof of it.

### What did work

Hooks alone, with no MCP tool used, won on code-migration-py (0.72×). Routing to
`smart_grep` for location search won on code-comprehension-django (0.63×).

## After the findings were measured (2026-11-15)

Each finding was checked against the 288 development-task transcripts before
anything was changed. The held-out tasks were not opened. Two were fixed, two
did not hold up, and one turned out to be the rig.

| finding | verdict | evidence |
| --- | --- | --- |
| 1. `smart_grep` large result sets | **fixed** | 395d4cfd (#592): hits grouped by file on the wire, plus a `distinct` summary. On this repository's `process.env` search, one page now carries 291 hits where the record form fitted ~149. |
| 2. `smart_read` of a huge log | **fixed** | 4c34d03e (#592): an envelope field no longer disarms the partial-admission floor. The same 524 KB log now returns 5,000 characters of content where it returned 121 of metadata. |
| 3. ToolSearch round trip | **kept as is** | A ToolSearch-only turn costs **$0.004** at the margin (12.8k cached tokens read, 4 output), 0.72 per run, so ~$0.003 per run. Marking `smart_read`, `smart_grep` and `expand` always-loaded (`_meta["anthropic/alwaysLoad"]`) would put ~1.6k schema tokens in every request: one write plus ~13 reads per run, ~$0.012. Deferral is 4× cheaper. |
| 4. Fixed overhead on short tasks | **mostly the rig** | See below. code-bugfix-py ran 6.3 turns against 5.3, which is the remaining 1.09×. |
| 5. Small Bash output | **did not hold** | Outside the two fixed tasks, our Bash results average **3,857** characters a run against tokenjuice's 4,162 and control's 8,023. |

### The rig shared a cache between arms

Control's first request read **14,070** cached tokens on all 36 development
runs, as did tokenade, tokenjuice, cto and cto-patched. Ours read 14,070 on its
first 12 runs and then 8,297, 11,098 or 11,298 for the rest, rewriting the
difference at the 1-hour tier ($6/MTok). Headroom read 11,088 throughout.

Arms run back to back per task, so the five arms whose prefix the server matches
keep one cache entry warm for each other, and control reads it. Ours did not get
that from run 13 on, although with the 1-hour tier its runs 5–6 minutes apart
should have hit its own prefix. Captured locally against a mock on the same
Claude Code version with the same login, our request prefix is **byte-identical**
to control's: all 14 tool hashes and both cached system blocks. The installed
7.11.0 server's tool list is byte-identical between runs too. Whatever splits
the match happens server-side, where it cannot be observed.

No real user shares a cache entry with another product's sessions. So
`analyse-campaign.py` gains a pre-registered secondary endpoint,
`cold_start_cost_usd`: every arm's first request is priced as if nothing earlier
had been cached, its cache reads billed as writes at the tier it wrote at.
Later requests are unchanged. The primary endpoint is unchanged.

A first request that wrote nothing takes its tier from the run's other
requests. If they wrote at both tiers, or wrote nothing, the run's cold start
is reported as unavailable rather than priced at a guessed tier. In this
campaign and the held-out one, every `ok` run's first request wrote at the 1h
tier. Recomputed after this rule replaced an earlier 5m fallback (#590
review), neither campaign's analysis output changed.

| arm | `total_cost_usd` | `cold_start_cost_usd` |
| --- | ---: | ---: |
| tokenjuice | 0.975 | 0.983 |
| headroom-cache | 1.080 | **0.977** |
| tokenade | 1.028 | 1.010 |
| cto-patched | 1.036 | 1.017 |
| headroom-token | 1.145 | 1.036 |
| **ours** | 1.149 | **1.036** |
| cto | 1.070 | 1.040 |

These are the before-fixes numbers re-scored, not a new measurement. Every
95% CI spans 1.0 on both endpoints except headroom-token's primary. The full
board reports both endpoints.
