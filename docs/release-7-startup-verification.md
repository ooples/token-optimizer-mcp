# Lazy counter startup verification

TokenCounter previously allocated its synchronous encoder and fetched a second,
factory-owned async tokenizer at construction. Most callers only use synchronous
counting. Both are now lazy: unused counters allocate neither, and synchronous
callers avoid the async encoder. The model mapping, bounded encoding, token cache,
and truncation algorithm are unchanged.

Cleanup is idempotent and never invokes the allocating getter. A freed counter
cannot allocate again or serve cached counts. Freeing one counter does not free
the factory-owned async tokenizer used by another counter.

## Measurements

[Raw receipt](release-7-startup-proof.json), Windows / Node 22.15.0, four fresh
processes before and after. Run `node bench/live/startup-probe.mjs` after building.
The baseline is commit `5cb5938b`. These are sequential development batches;
they are not randomized confirmation or a HeadRoom comparison.

| Mean | Before | After |
| --- | ---: | ---: |
| MCP initialize and tools/list | 1,881.9 ms | 1,626.5 ms |
| Counter import and construction | 186.3 ms | 26.2 ms |
| Counter import, construction and first count | 190.5 ms | 127.8 ms |
| RSS growth through first count | 74.7 MiB | 48.3 MiB |

Counter timings include module import. RSS means resident-memory growth, not
total allocation volume. MCP timings include client-module loading and transport
startup. All eight MCP processes exposed the same 19 tools, and all eight counter
processes returned the same four-token result. Deferring allocation alone can
shift work to the first call; measuring through that call also shows a reduction
because the unused second encoder is avoided.

## Adversarial checks

- Repeated free, free before first use, counting/truncating after free, and shared
  async tokenizer ownership have explicit regression coverage.
- Existing tests cover counting across model names, savings accuracy, truncation,
  multi-megabyte inputs, cache bounds, and analytics output.
- Build, changed-file lint, and 87 tests across five affected suites passed.
- The lifecycle and model-mapping regressions run in both release CI platforms.

This improves common MCP startup for every client. It does not establish that
every end-to-end model workload is faster than HeadRoom; network and model
response time remain separate measurements.

## Live JSON follow-up

[Full receipt](release-7-startup-live-proof.json): two balanced pairs using fresh
heldout-v1 seeds 1900000502/503, current Codex account/model, combined core MCP
plus proxy versus the installed HeadRoom binary. All four runs passed, with
complete reads and three model requests each.

| Mean | Token Optimizer | HeadRoom |
| --- | ---: | ---: |
| Input tokens (including cached) | 40,528 | 48,725.5 |
| Agent execution | 17.35 s | 13.45 s |
| Total including proxy startup and validation | 18.35 s | 25.60 s |

The recorded rate-card scenario estimates 20.75% lower cost for Token Optimizer.
This is not a billing measurement. Input was 16.82% lower and total elapsed time
28.32% lower, but agent execution remained 29.00% slower. Retain that loss.

Across each run's three model requests, the recorder measured 0.270/0.277 seconds
of local transformation and 14.959/13.123 seconds in the upstream interval for
Token Optimizer. HeadRoom's corresponding upstream intervals were 12.002/10.768
seconds. The null recorder's local transformation time does not measure HeadRoom
compression itself. These boundaries do not isolate inference from networking or
other upstream work. Most of the observed agent-time difference is outside our
local transform interval; two pairs cannot establish its cause or stability.

This result supports keeping the allocation reduction, but does not close the
agent-speed gate or establish an end-to-end win on every task.
