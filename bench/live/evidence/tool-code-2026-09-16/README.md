# Two cost losses: diagnosis and rejected default change

The original nullable and JSON losses used fewer input and output tokens than
HeadRoom. Their cache-discount differences outweighed those savings:

| Original pair | Input contribution to our cost gap | Cache-discount contribution | Output contribution | Net gap |
| --- | ---: | ---: | ---: | ---: |
| Nullable seed 2494523015 | -$0.040040 | +$0.051840 | -$0.005550 | +$0.006250 |
| JSON seed 3141592001 | -$0.075480 | +$0.116352 | -$0.001150 | +$0.039722 |

These are decompositions of the recorded $10/$1/$50 scenario, not causal
explanations of provider cache misses. The client's cache key and initial input
prefix remained stable within each run. Local replay also preserved historical
items when a new user question was appended.

## Implemented experiment

Actual installed HeadRoom wire replay showed description whitespace normalization,
including code examples. Added `TOKEN_OPTIMIZER_PROXY_TOOL_CODE=1` as an **off by
default** experiment: compact selected whitespace inside fenced TypeScript,
JavaScript and JSON examples, preserving prose, strings, comments and line breaks.
Leave templates, continuations, unsupported languages and ambiguous slash syntax
alone. Tool parameters and custom grammars are never traversed. The description
cache is bounded by bytes and entry count.

This removes 140 locally estimated o200k_base tokens from the captured
additional-tools item, repeated in every request. That estimate is not provider
billing. Comparing all 33 fenced blocks across the three captured requests found
identical TypeScript lexical tokens. Seven targeted tests and seven existing
Responses tests passed; build and changed-file ESLint passed.

## Fixed live experiment

The [protocol](PROTOCOL.md) was committed at `023b9770` before execution; run
commit `a27fd59d` additionally fingerprints the compiled experiment module.
Four pairs / eight attempts, two families, both arm orders. All completed and
were independently validated. No outcomes were replaced.

| Pair | Our estimated cost | HeadRoom estimated cost | Our agent seconds | HeadRoom agent seconds |
| --- | ---: | ---: | ---: | ---: |
| Nullable 2494523015 | $0.173484 | $0.120798 | 12.5 | 18.8 |
| Nullable 2494523016 | $0.173054 | $0.115502 | 15.5 | 16.2 |
| JSON 3141592001 | $0.174782 | $0.134388 | 15.0 | 15.4 |
| JSON 3141592002 | $0.175042 | $0.138932 | 19.0 | 16.5 |

**All eight attempts passed quality; zero of four cost wins, three speed wins.**
Every candidate first request reported zero cached tokens, while every HeadRoom
first request reported 9,216. Both candidate and competitor used three requests
per attempt. Do not claim that the formatting change caused these cache outcomes;
this comparison did not isolate provider cache state. It also did not solve the
two original cost losses. `summary.json` retains the complete totals.

Decision: **do not enable this experiment by default.** Fewer input tokens alone
do not justify promoting a change that lost on observed cost. Default proxy
behavior continues to preserve tool descriptions and client cache keys.

## Cache-routing review

The current OpenAI API documentation says newer models route caches automatically;
on GPT-5.6 and later, cache keys serve separate cache accounting. This does not
justify overriding Astra client keys as a routing fix. It also documents explicit
breakpoints and cache-write charges for the API; those must not be assumed to
apply unchanged to this Codex backend and its recorded Enterprise rate-card
scenario. No key, retention, or breakpoint policy was changed.
[Official prompt-caching documentation, reviewed 2026-09-16](https://developers.openai.com/api/docs/guides/prompt-caching)

Raw bodies remain local at the paths recorded in the audit artifacts. Archived
results include every live outcome, usage, independent validation, provenance,
cost scenario and host-memory trace. These development experiments provide no
new across-the-board superiority or production-readiness claim.
