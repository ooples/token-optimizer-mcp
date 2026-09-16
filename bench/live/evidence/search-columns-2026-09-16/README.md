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

| Mean metric | Proxy | HeadRoom | Reduction |
| --- | ---: | ---: | ---: |
| Transmitted bytes | 6,370.375 | 11,877.25 | 46.4% |
| Serialized-body o200k_base token estimate | 1,977.875 | 3,456 | 42.8% |
| Request latency, ms | 6.96 | 374.63 | 98.1% |

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

Four fresh development pairs are scheduled before execution: code seeds
1900000301–1900000304, alternating proxy/HeadRoom order, the same local Codex model,
natural tool choice, heldout-v1 generator, and existing independent exposure,
answer and provider-usage audits. All attempts, failures and losses will be retained.
This targeted follow-up does not replace or inherit the earlier 70-pair study.
