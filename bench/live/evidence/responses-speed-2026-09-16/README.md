# Responses speed follow-up

Product change: 5104328e, compared locally with 5d749774.

## Implemented

- Reuse exact token counts when the same source is tested against different compression candidates. The additional cache holds at most 128 strings and 1 MiB of estimated UTF-16 string storage.
- Reuse validated Codex shell-envelope parsing and exact output-field offsets across historical turns. Preserve status, timing, large integers, and every other lexical byte. Ambiguous fields still pass through. This cache holds at most 128 envelopes and 2 MiB of estimated string storage.
- Both caches are process-local. Limits concern retained string payload, not Map overhead or total process memory. Oversized shell envelopes are not retained.
- Compression thresholds, representations, proxy transport, and request ordering are unchanged.

## Local evidence

Four alternating process pairs replayed the same ten captured requests. Each process made twelve warm passes:

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Mean cold pass | 380.73 ms | 360.82 ms | 5.2% |
| Mean warm pass | 10.847 ms | 9.205 ms | 15.1% |

All ten output hashes match across every run. Full samples are in [replay.json](replay.json).
The baseline restores only token-gate.ts and response-dedup.ts from 5d749774, transpiles them with the installed TypeScript compiler, and redirects the unchanged Responses module to those baseline modules. All other compiled dependencies are identical.

Replay entry point: bench/live/response-cache-replay.mjs RAW_RUN OUTPUT_JSON.
RESPONSES_MODULE can select the comparison module. Raw input is the earlier repeat/run-yqI6GZ campaign recorded in the artifact; raw requests are retained locally rather than committed.

Separate allocation sampling used bench/live/profile-responses.mjs on json-1-proxy/requests.jsonl for 30 rounds (150 calls), with --max-old-space-size=32. Before/after sampled JavaScript allocation bytes were 116,060,488 / 103,917,680 (10.5% lower). Both completed. A single sampling run is diagnostic, excludes native/WASM allocation, and does not establish peak RSS.

Build, changed-file ESLint, and 23 focused Responses regressions passed. The new regression checks repeated cached replacements, changed exit status, lexical large integers, and ambiguous nested output fields.

## Scope

These are local implementation improvements, not proof of beating HeadRoom on model latency. The earlier largest speed loss contained a 50.7-second upstream response; its cause is not identifiable from aggregate timing. A twelve-request local transport probe reused one upstream connection, ruling out the proposed per-request handshake explanation for that probe.

The fixed live schedule is in [PROTOCOL.md](PROTOCOL.md). All eight scheduled attempts passed; three of four speed wins and three of four estimated-cost wins. Totals were 135.2 versus 166.5 agent seconds (18.8% lower) and $0.703922 versus $1.310704 (46.3% lower). See [all outcomes and timing](summary.json).

| Pair | Ours / HeadRoom seconds | Ours / HeadRoom estimated USD | Result |
| --- | ---: | ---: | --- |
| repeat 1 | 25.2 / 27.1 | 0.129386 / 0.336684 | joint-win |
| repeat 2 | 27.1 / 26.5 | 0.129666 / 0.392092 | speed-loss |
| refresh 1 | 45.6 / 50.7 | 0.239170 / 0.235676 | cost-loss |
| refresh 2 | 37.3 / 62.2 | 0.205700 / 0.346252 | joint-win |

The first refresh attempt recovered from a PowerShell quoting failure in an agent-generated node -e command. Both arms used seven requests there. The second refresh used six requests for ours versus eleven for HeadRoom. These model trajectories and cache states prevent attributing the live aggregate difference to a roughly 20 ms local cold-pass improvement. Costs use the archived $10/$1/$50 per-million uncached/cached/output scenario, not actual invoices. No mock or local CPU load ran concurrently with this schedule.

The local transport probe completed successfully after correcting its cleanup helper; all twelve requests reused one upstream connection.

