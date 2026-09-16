# Cost-loss investigation and fixes (2026-09-16)

## Implemented changes

The 13 cost losses from the completed amended study were investigated individually. Twelve had lower input usage but smaller provider cache discounts; refresh-3 also carried more input. The audit decomposes observed cost arithmetically; it does not assign a causal explanation to provider cache misses. Replaying all captured proxy requests checked 601 repeated input-item transformations for stability and preserved the client cache key.

Two product changes followed:

1. Factor substantial shared ID prefixes/suffixes in exact JSON-fragment templates. Every value, order, source byte, and missing-data marker remains reconstructible; booleans, numbers, and short categories remain explicit. Also handle literal escaped structural newlines without decoding string-value escapes.
2. Handle complete escaped records inside a truncated outer shell envelope. The original truncated serialization remains invalid/incomplete; only complete records are represented compactly. Canonical re-encoding must reproduce each original record before it qualifies.

## Complete follow-up of all 13 original losses

Product build: `efd2779d`. Same original seeds and tasks, opposite arm order, one attempt per arm per case, no retries or replacements. All 26 attempts passed independently audited task validation. Twelve pairs favored proxy on estimated token cost; one still favored HeadRoom. Total estimated cost: **$2.972548 vs $4.464508**, or **33.4% lower**. Input totals: 1,011,978 vs 1,545,277.

These are development results on previously observed cases. Provider cache hits and model behavior changed, so a flipped result is not by itself proof that a product fix caused the flip. Original losses are retained in the earlier study and `loss-audit.json`.

| Original case | Proxy estimated USD | HeadRoom estimated USD | Proxy reduction |
|---|---:|---:|---:|
| logs-1 | 0.213496 | 0.282636 | 24.5% |
| mixed-4 | 0.147436 | 0.321342 | 54.1% |
| json-10 | 0.128090 | 0.225242 | 43.1% |
| json-9 | 0.174390 | 0.230294 | 24.3% |
| json-8 | 0.129220 | 0.335448 | 61.5% |
| mixed-9 | 0.169334 | 0.543340 | 68.8% |
| refresh-2 | 0.508406 | 0.307372 | -65.4% |
| code-7 | 0.154614 | 0.240980 | 35.8% |
| bugfix-9 | 0.315954 | 0.414782 | 23.8% |
| refresh-1 | 0.242538 | 0.303634 | 20.1% |
| bugfix-2 | 0.282686 | 0.351786 | 19.6% |
| mixed-3 | 0.252418 | 0.561484 | 55.0% |
| refresh-3 | 0.253966 | 0.346168 | 26.6% |

## Remaining loss traced to an unhandled envelope

The follow-up refresh-2 attempt sent an outer-truncated serialized shell result. Its 40,105-byte text was not recognized by the previous compressor. The additional fix in `510d570a` reduces that exact result to **10,200 bytes** and **3,731 estimated o200k_base tokens vs 15,631** (76.1% fewer). An independent decoder reconstructs every original byte, including the gap. Across the seven captured requests, the same history item is reused six times; replay removes 36,120 transmitted bytes from each of those requests. This replay estimates wire tokens; it is not observed provider usage.

The earlier prefix change alone reduced the three original refresh fragments by another 41?42% relative to their previous compressed representation. Compare `loss-audit.json` with `after-prefix/loss-audit.json`; both replays use identical fixed recovery paths. Comparing either replay directly to original live byte totals also includes recovery-path length differences.

## Controlled live validation of the additional fix

Product build: `510d570a`; installed HeadRoom 0.37.0; Codex 0.154.0 / gpt-6-astra. Two balanced pairs used the original refresh-2 seed and one fresh neighboring seed. Both arms received the same instruction to force an outer-truncated initial shell envelope. Independent audits confirmed that exposure in all four attempts, and all four tasks passed. Both pairs favored proxy on estimated cost.

| Total over two attempts per arm | Proxy | HeadRoom |
|---|---:|---:|
| Estimated USD | 0.551652 | 0.839652 |
| Provider input tokens | 204,594 | 243,251 |
| Provider output tokens | 1,656 | 1,643 |
| Requests | 14 | 15 |
| Agent seconds | 95.8 | 91.1 |

Estimated cost was **34.3% lower** and input **15.9% lower**. Agent time was 5.2% higher in this small sample; this is not a speed win. Cache hits remain observed, not controlled. These are targeted development pairs with a deliberately constrained initial read, separate from the natural-workflow sweep and broader confirmation. They validate the diagnosed path without overwriting its earlier loss.

The actual outer fragments in these fresh captures fell from 8,101 characters each to 2,521 and 2,490. `outer-live/*` contains all six standard evidence files; `outer-summary.json` records both paired costs, exposure, and raw locations. The compiled fragment module matched the exact-replay hash.

## Request-path profiling and allocation fix

V8 CPU/allocation profiling found that every valid escaped record first caused a failed JSON parse and an exception allocation. The final implementation chooses the decoder from the first property quote, keeping canonical round-trip validation and malformed-record rejection intact. No output format changes.

A replay of seven captured requests over 200 fresh-cache rounds (1,400 calls) measured mean time **2.645 ? 1.437 ms**, p95 **12.963 ? 3.918 ms**, and sampled allocation **913,448,128 ? 764,762,056 bytes**: 45.7%, 69.8%, and 16.3% reductions respectively. Total process CPU fell 43.8%. This is one internal before/after profiling comparison with 32 KiB sampling, excluding network/disk; it is not a HeadRoom allocation or live agent-time comparison.

The codec result and metadata match `510d570a` exactly on **69 unique large strings across 28 captured proxy conversations**, including all original losses, the complete follow-up, and both outer-truncation pairs. `fastpath/` retains summaries, allocation profiles, and the equivalence report. The focused fragment regressions and build passed after this change.

## Evidence and reproduction

- `followup-plan.json`, `followup-execution.json`, `followup-summary.json`: complete fixed follow-up and raw locations.
- `cases/*`: all manifests, provenance, independent validations, provider usage and recorded rate-card costs.
- `product-hashes.json` and `product-hashes-at-completion.json`: recorded during the sweep and verified before rebuilding for the additional fix. This is not a preregistered freeze.
- `outer-replay/*`: actual missed synthetic result, compact result, independent exact reconstruction and wire-token estimates.
- `outer-followup-plan.json`: two balanced controlled pairs specified before their calls, requiring actual initial outer-envelope truncation.

```powershell
node bench/live/loss-audit.mjs bench/live/evidence/confirmation-2026-09-16-v3-continuation <new-output-directory>
node bench/live/loss-followup.mjs bench/live/evidence/confirmation-2026-09-16-v3-continuation <new-output-directory>
node bench/live/loss-followup-report.mjs bench/live/evidence/cost-losses-2026-09-16
```

Report writers refuse to overwrite existing results. Use a fresh destination to recompute. The loss audit needs retained raw captures at the recorded local paths. Costs use the original recorded Codex Enterprise rate scenario (USD 10/1/50 per million uncached-input/cached-input/output tokens); they are not billing invoices.
