# HeadRoom source review and local route probe

## Finding

Our strongest next opportunity is to combine our smaller individual encodings
with stable cross-output deduplication on the Codex Responses route. HeadRoom
already does this. Our other conversation route has deduplication, but
`src/proxy/responses.ts` calls only the independent block compressor.

This review does **not** establish the cause of the two remaining provider-cache
cost losses. It identifies reproducible product gaps instead of attributing
provider cache hits to unrelated features or further shrinking tool descriptions.

## Provenance

- Our source/build: `8c70671be8132b33b8b61f5f5d3d77bab2149391`.
- Upstream: [headroomlabs-ai/headroom at
  35b11564c6217c358094732618d21eb74503aa47](https://github.com/headroomlabs-ai/headroom/tree/35b11564c6217c358094732618d21eb74503aa47),
  checked out September 16, 2026. Package metadata points to the old
  `chopratejas/headroom` location; use the canonical repository above.
- Local probe: installed `headroom-ai` 0.37.0, Python 3.13; actual HTTP proxy with
  a local mock upstream. No provider calls, agent tasks, or billable usage.
- Upstream and installed packages both label themselves 0.37.0, but are not
  source-identical. The attached AST comparison ignores formatting/comments.
  Deduplication, the unit cache key, tool lifting, and the payload compressor
  match. The live-unit adapter's upstream change adds byte-exact read exclusions;
  installed code lacks that addition. Output shaping also differs.
- `probe-summary.json` preserves all seven synthetic cases. Full synthetic wire
  captures and process logs remain at its recorded local temporary path.
- Reproduce from the repository root after building:
  `node bench/live/headroom-gap-probe.mjs`. This starts the installed HeadRoom
  proxy, routes it exclusively to a loopback mock, and stops the child afterward.

## What the actual Responses route does better

All source links below are pinned to the reviewed upstream commit.

| Mechanism                   | HeadRoom source                                                                                                                                                                                                                                                                                                               | Our Responses route / consequence                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-output deduplication  | [Keep the earliest copy; fold later repeated spans](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/proxy/handlers/openai.py#L1244)                                                                                                                                        | Independent `cachedOutput` calls reuse CPU work but still transmit each compressed copy. This is a demonstrated size loss on repeated outputs.                                                                            |
| More output representations | [Four output item types](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/proxy/handlers/openai.py#L1021) and [both text-part types](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/proxy/handlers/openai.py#L2049)     | We support function/custom output and `input_text`; we skip local-shell/apply-patch outputs and `output_text` parts. Confirmed by the local probe. Client/API compatibility still needs fixtures before widening support. |
| Token-count acceptance      | [Reject non-decreasing token counts](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/transforms/compression_units.py#L331)                                                                                                                                                 | Our final route acceptance compares serialized bytes. Fewer bytes are not a guarantee of fewer model tokens. Their tokenizer is still an estimate for an unknown provider encoding.                                       |
| Small-output handling       | [512-byte unit floor](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/proxy/handlers/openai.py#L1732), [compatible small-unit batching](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/proxy/handlers/openai.py#L2476) | We skip each text under 1,024 JavaScript characters. This is a coverage opportunity, not a demonstrated win: the single small case tied.                                                                                  |
| Tool-aware read protection  | [Inspect call names, commands, and output content before compressing](https://github.com/headroomlabs-ai/headroom/blob/35b11564c6217c358094732618d21eb74503aa47/headroom/proxy/handlers/openai.py#L2135)                                                                                                                      | We pass text to the compressor without its originating call. Content-based safeguards cannot exploit whether the agent needs exact edit anchors. Potential workflow benefit; not a proven cause of our extra requests.    |

Their per-unit exact-output cache and ours serve the same broad purpose. Raising
ours from 128 entries to their 10,000-entry limit is not an evidence-backed fix;
our 8 MiB bound matters after the allocation work.

## Local evidence

These are full JSON request **bytes**, not tokens, task-quality results, latency,
or cost. Fixtures contain the same 80-row structured result and vary its output
representation or repeat count. They were selected to exercise source-identified
gaps, not to estimate the prevalence of those gaps in production.

| Case                      | Original |   Ours | Installed HeadRoom |
| ------------------------- | -------: | -----: | -----------------: |
| One result                |   11,422 |  2,066 |              4,356 |
| Two identical results     |   22,716 |  4,004 |              4,461 |
| Three identical results   |   34,010 |  5,942 |              4,566 |
| One small result          |      802 |    802 |                802 |
| `output_text` part        |   11,454 | 11,454 |              4,388 |
| `local_shell_call_output` |   11,425 | 11,425 |              4,359 |
| `apply_patch_call_output` |   11,425 | 11,425 |              4,359 |

Both arms preserved earlier input items exactly as the repeat sequence grew.
The mock accepts arbitrary input, so representation probes demonstrate adapter
behavior, not acceptance by a real model endpoint. The synthetic recovery path
is a placeholder; this probe does not validate recovery or task correctness.

## What does not explain the two cost losses

- The broader `session_engine` confirmed-prefix replay and cold-recompression
  design cannot simply be attributed to this route. The reviewed Responses
  compressor builds live units and reuses exact unit results; the active handler
  call graph does not run `prepare_turn` / `finalize_turn`.
- The earlier real-payload local replay observed description whitespace changes
  and tool-output compression, not altered instructions, reasoning effort, or
  `prompt_cache_key`. Output-shaping code existing in the repository does not
  establish that it affected those measured requests.
- Codex routing-header resolution adds account routing information when absent;
  it is not evidence of a special prompt-cache key strategy.
- Original nullable loss: $0.051840 cache-discount disadvantage outweighed
  $0.040040 input and $0.005550 output savings, leaving $0.006250 higher cost.
- Original JSON loss: $0.116352 cache-discount disadvantage outweighed $0.075480
  input and $0.001150 output savings, leaving $0.039722 higher cost.
- Those are the recorded $10/$1/$50 estimates, not invoices. Stable visible
  prefixes and client keys do not establish equivalent provider cache state.
  The later description experiment lost all four cost pairs and stays off.

## Implementation order and adversarial requirements

1. **Connect stable cross-output deduplication to Responses.** Keep our smaller
   first-copy encoding, retain an in-request referent, and replace only later
   equivalent content. Include repeated shell output with changing transport
   headers. Index forward only: appended items must never change prior output.
   Do not directly transplant our existing `dedupBlocks` labeling pass: it
   chooses labels from future reference counts, which can change earlier
   references when another duplicate arrives. Bound retained indexes and work;
   a hash match must be verified against exact content. Changed rows, duplicate
   names, removed referents, and truncated histories must not produce stale or
   ambiguous references. Repeated errors may carry temporal meaning; preserve
   call identity, occurrence, order, status, and changing metadata.
2. **Cover the skipped output representations.** Preserve all IDs, metadata,
   images, encrypted reasoning, and unsupported shapes. Protect source/edit
   anchors using call context where needed. Use endpoint-valid fixtures before
   promoting support; a permissive mock is insufficient validation.
3. **Add token-aware selection, then small-unit handling.** Count candidate
   savings once per cached transformation, with a conservative fallback when
   model tokenization is unknown. Do not make every request pay a full token
   recount. Small-unit batching must not regroup previously forwarded content
   when a turn is appended. Require a benefit after framing/recovery overhead.
4. **Isolate the remaining cache economics.** Capture only necessary routing
   metadata safely, compare exact forwarded prefixes and first divergent token
   positions, and distinguish first-request cold/warm state from within-session
   reuse. Use matched, counterbalanced cold/warm protocols with all outcomes
   retained; server warm state is observed, not assumed from a client flag.
   Retain the original losses. Do not claim a provider-cache fix based on the
   unrelated synthetic adapter wins above.

Validate the new adapter behavior and append-only stability together once the
implementation is complete, then run a fixed live comparison on repeated-read,
JSON, nullable, and extra-action workflows. Passing tasks, complete request and
usage accounting, lower total estimated cost, and lower agent time are the
promotion criteria. A byte win alone is insufficient, and no finite comparison
proves superiority on every possible task.
