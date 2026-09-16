# Exact declaration rows: code-size gap closed

Search output already factored repeated paths but retained repeated declaration
syntax. The new representation states that syntax once and keeps every identifier
and right-hand-side value verbatim in two tab-separated columns. The header states
how to reconstruct each line and its source location. Mixed syntax or tab-containing
values retain the existing representation; conservative size and row floors avoid
paying for a table on short groups. Windows drive/UNC paths, canonical line labels,
and uniform CRLF/LF preservation are covered too.

## Actual shipped proxies, local upstream

Eight fresh code cases (seeds 1900000201–1900000208), two opposite arm orders,
all requests completed. Both proxies used the same local upstream; installed
HeadRoom 0.37.0 used default compression with its rate limit disabled, matching the
earlier throughput experiment. These measurements contain no provider calls.

| Mean metric                               |     Proxy |  HeadRoom | Reduction |
| ----------------------------------------- | --------: | --------: | --------: |
| Transmitted bytes                         | 6,370.375 | 11,877.25 |     46.4% |
| Serialized-body o200k_base token estimate | 1,977.875 |     3,456 |     42.8% |
| Request latency, ms                       |      6.96 |    374.63 |     98.1% |

Proxy transmitted fewer bytes on all eight cases. Tokenizer counts are wire-body
estimates, not observed model usage; this small sample has no confidence interval.
Latency includes initial requests without a separate warmup, so it is not directly
interchangeable with the earlier longer benchmark.

Replaying the **same 40 unique-code inputs from the earlier losing benchmark**:
old proxy mean 11,208 bytes, archived HeadRoom mean 10,600.3, new proxy mean 6,620.
The old 5.7% size loss becomes a 37.5% reduction against the archived comparator.
New proxy output is 40.9% smaller than old proxy output. Request sizes and fixture
order match the archived inputs. This replay compares bytes across runs, not
concurrent latency.

An independent decoder reconstructed every original byte for all **48 captured
proxy outputs**. Sixty-four focused checks passed, including full reconstruction,
rare values, placeholder-like text, escaped values, CRLF, missing final newline,
context markers, Windows paths, and unsafe/padded line labels. Build and targeted
lint passed. Raw transmitted bodies and summaries are retained under local/.

Reproduce with `node bench/live/search-columns-local.mjs`, and with
`--replay-prior` for the original 40 inputs. Archive their JSON files under
local/fresh and local/replay, then run
`node bench/live/search-columns-report.mjs EVIDENCE_DIRECTORY`.

## Live follow-up

The four predeclared development pairs completed on product commit 3faf2289:
code seeds 1900000301–1900000304, alternating proxy/HeadRoom order, local Codex
0.154.0 with gpt-6-astra, heldout-v1 controlled code-search lookups, and the same
independent exposure, answer and provider-usage audits. **All 8 attempts passed
all audits**, with complete reconciled usage. Proxy cost was lower in all four pairs.

| Totals across four attempts per arm |    Proxy | HeadRoom | Reduction |
| ----------------------------------- | -------: | -------: | --------: |
| Estimated token cost, USD           | 0.480652 | 0.963856 |     50.1% |
| Input tokens                        |  175,418 |  317,697 |     44.8% |
| Output tokens                       |      772 |    1,403 |     45.0% |
| Provider requests                   |       12 |       20 |     40.0% |
| Agent time, seconds                 |     57.1 |    116.7 |     51.1% |

Proxy used three requests per task; HeadRoom used five. The frozen Codex Enterprise
10/1/50 rate-card scenario estimates token charges, not actual billing. Charging
each first request fully uncached leaves a 27.7% reduction; charging all input fully
uncached leaves 44.8%. These sensitivities hold observed behavior fixed and do not
create measured cold-cache cohorts. Raw audited evidence is under live/ and the
independent summary is live-summary.json.

A subsequent allocation cleanup avoids joining a temporary copy solely to measure
its length and avoids spreading large row arrays into function arguments. It
handles a 130,000-row regression and produces byte-identical output for all 48
captured local cases. The final build and 65 focused checks passed cumulatively.

This is a small, balanced development follow-up. Different seeds and provider/cache
conditions prevent attributing every live improvement solely to the new codec.
It does not replace or inherit the earlier 70-pair study. Recompute its summary
with `node bench/live/search-columns-live-report.mjs EVIDENCE_DIRECTORY` on this
revision; that also checks the final codec against the captured output bytes.
