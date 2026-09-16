# Completed amended live comparison

All **70 scheduled pairs / 140 attempts** completed. Proxy passed **69/70**;
installed HeadRoom 0.37.0 passed **70/70**. Proxy bugfix-10 hit an upstream HTTP 503
after two successful responses. The failed request had no compressed output.
Its third-request usage is unknown; its total cost remains null, and known partial
usage is retained. **Strict superiority was not established**: the quality and
complete-ledger gates failed. The frozen analyzer correctly returns no intervals.

The original harness stopped between cases after 22 pairs due to a whole-file
hash allocation failure. Independent streaming verification matched all 800
original artifacts. The disclosed [amendment](AMENDMENT.md) replaced hashing with
64 KiB streaming reads and continued only the 48 unattempted cases, preserving the
original schedule, product, tasks, prompts, analysis, and every original attempt.
No interim cost analysis or outcome-selected repeats occurred. Final verification
matched all 805 amended frozen artifacts and reverified the 22-pair prefix before
subsequent product changes.

## Descriptive complete-pair results

These totals include **69 fully measured pairs only**; the entire bugfix-10 pair
is excluded from this table, while both attempts remain in analysis.json. They
are not whole-study totals or confidence-backed superiority claims.

| Family             | Pairs | Estimated cost reduction | Input reduction | Agent-time reduction |
| ------------------ | ----: | -----------------------: | --------------: | -------------------: |
| Bug fix            |     9 |                    23.6% |           49.2% |                27.2% |
| Code search        |    10 |                    27.5% |           44.4% |                38.8% |
| JSON               |    10 |                    27.5% |           17.9% |                 0.4% |
| Logs               |    10 |                    32.7% |           41.4% |                43.5% |
| Mixed output       |    10 |                    20.9% |           43.9% |                25.3% |
| Refactor           |    10 |                    45.4% |           64.6% |                41.5% |
| Refresh            |    10 |                    14.7% |           26.9% |                30.1% |
| All complete pairs |    69 |                    27.9% |           44.2% |                31.7% |

Proxy cost was lower in 56 of 69 measured pairs and higher in 13. Every family's
mean favors proxy, but individual losses remain. JSON provider request count ties;
its output-token total is 9.5% higher and its agent-time advantage is only 0.4%.
Across complete pairs, requests are 37.5% lower and startup-inclusive time 43.6%
lower. See descriptive.json for raw totals and all metrics.

Known estimated subtotal across **all 70 proxy attempts** is $15.635996 plus the
unknown charge, if any, for the failed third request. HeadRoom's fully measured
70-attempt total is $21.968986. These are not a complete like-for-like total-cost
comparison. The failed proxy attempt has $0.068654 in known charges plus unknown
usage; the matching HeadRoom attempt costs $0.373884 in the rate scenario.

The frozen scenario is USD 10/1/50 per million uncached-input/cached-input/output
tokens. These are estimated token charges, not invoices, subscription charges or
proxy compute costs. On the 69-pair subset, charging only each first request fully
uncached leaves a 26.5% descriptive reduction; charging all input fully uncached
leaves 43.6%. Both sensitivities hold observed behavior fixed and do not represent
controlled cold-cache experiments.

JSON's earlier v2 cost loss was 35.1%; the current product retains complete rare
string categories. Different fresh instances, provider conditions and model paths
prevent attributing the full before/after difference solely to that change.

## Reproduction and validation

The protocol, plan, freeze, original interruption and amendment are retained.
Run `python bench/live/confirmation-analyze.py STUDY_DIRECTORY` on the archived
study with its recorded Python dependencies. The separate
`confirmation-describe.mjs` produces descriptive totals without repairing failed
inference gates. An existing descriptive.json is intentionally not overwritten.

The streaming repair matched the original digest six times for the 298 MB Codex
binary under a 48 MiB V8 heap cap. Sampled array-buffer footprint peaked at
33,747,995 bytes. Reproduce from the repository root with
`node --max-old-space-size=48 bench/live/evidence/confirmation-2026-09-16-v3-continuation/hash-memory-check-source.mjs`.
This is sampled buffer footprint, not allocation volume.

This completed schedule measures product source 9a151ecc. Subsequent exact
declaration-row compression is separate development work and does not inherit
this study's results.
