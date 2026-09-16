# Cached-output live follow-up: correctness passes, cost loss retained

Two balanced repetitions, refresh seeds 32–33, our proxy and installed HeadRoom.
All four attempts passed independent artifacts and usage reconciliation.
No control or uncached-old-build arm was included, so this is not a causal
latency test of the output cache.

| Mean per attempt | Our proxy | HeadRoom |
| --- | ---: | ---: |
| Total input tokens | 90,630.5 | 91,444 |
| Uncached input tokens | 25,158.5 | 12,468 |
| Output tokens | 664.5 | 666 |
| Requests | 6.5 | 6 |
| Agent seconds | 36.4 | 36.4 |
| Seconds including startup | 37.4 | 47.85 |

Input was 0.9% lower, agent time tied, and the standard-rate cost scenario was
47.8% higher. Startup-inclusive time was 21.8% lower. Both arms had one shell
failure in the first repetition; HeadRoom completed the second in fewer calls.
Do not present this sample as a win on every metric or discard the cache misses.

Replaying both proxy request histories with the cached compressor preserved
every prior input item byte-for-byte through all 11 append transitions. The
only changed top-level field besides input was client_metadata. This excludes
an observed rewritten input prefix in that replay; it does not establish why
the provider did not serve cached tokens or validate provider cache routing.

The run started before the cache commit, so provenance records e4550423 with
the then-uncommitted implementation now committed as bc10b2ca. Its recorded
responses.js hash identifies the tested implementation. The output-cache.js
SHA-256, captured before any further build, is
`e50b76025d27e04787f6b4fcb2300f4f02168cc186dd770f06b17bb5dd7e0428`.
Future provenance includes that module directly.

The separate local profile measured reduced CPU time and sampled allocations;
those microbenchmarks must not be substituted for these live outcomes.
