# Responses improvements: implementation and evidence

## Implemented

- Forward-only, request-local deduplication. Keep the smaller first encoding and
  reference only exact earlier content still present in this request. Bound the
  index to 256 entries / 4 MiB of retained string estimates; reject oversized
  candidates. Preserve call IDs, distinct occurrences, changing status/timing,
  and known source-read edit anchors. Appending a result cannot relabel old ones.
- Handle `output_text` parts, apply-patch output, and text fields in local-shell
  JSON objects. Preserve other content parts, unknown metadata, and JSON lexical
  bytes outside replaced strings. Non-object local-shell JSON remains unchanged.
  See the [official input schema](https://developers.openai.com/api/reference/resources/responses/methods/create.md):
  local-shell output is a JSON string, whereas patch output is human-readable
  text. The earlier permissive mock was not sufficient protocol validation.
- Handle actual Codex JSON shell envelopes: deduplicate their `output` field
  while keeping changing chunk IDs, wall time, exit codes, and other metadata.
  The ledger now records references actually forwarded, not just local estimates.
- Apply bounded, memoized o200k_base token estimates with a 10% / eight-token
  savings floor plus serialized-size checks. This encoding is an estimate for
  the configured model, not its verified billing tokenizer. Oversized units or
  tokenizer failure require at least 25% byte savings. Counting is limited to
  units no larger than 128 Ki characters, not whole requests.
- Compress small complete flat JSON arrays using exact lexical templates, with
  short framing. Preserve nulls, escapes, order, and large integer spellings.
  No cross-turn small-output regrouping is needed.
- Cache token decisions by **both** original and candidate text. A full encoding
  and a later reference no longer replace each other's cached counts. Bound this
  cache to 128 decisions / 2 MiB of conservative retained-string estimates.

The proxy remains in place. The rejected tool-description experiment stays off.

## Fixed live results

Actual local Codex, gpt-6-astra, installed HeadRoom 0.37.0, balanced arm order,
independent quality/usage/capture audits, and Windows memory telemetry. The two
stages have different product commits and remain separate:

| Stage                                                                   | Product    | Quality    | Cost pairs won | Speed pairs won | Our estimated cost / HeadRoom | Our agent seconds / HeadRoom |
| ----------------------------------------------------------------------- | ---------- | ---------- | -------------- | --------------- | ----------------------------- | ---------------------------- |
| [Initial protocol](PROTOCOL.md): JSON, nullable, refresh, repeated JSON | `90f42537` | 16/16 PASS | 8/8            | 3/8             | $1.182176 / $2.013110         | 250.3 / 240.1                |
| [Nested-output follow-up](FOLLOWUP.md): repeated JSON                   | `1427417f` | 4/4 PASS   | 2/2            | 1/2             | $0.381052 / $0.621684         | 48.2 / 53.7                  |

Initial stage: 41.3% lower estimated cost, **4.2% slower** overall. Follow-up:
38.7% lower estimated cost and 10.2% faster overall. All scheduled attempts are
retained. The final cache-only performance correction came after these live
runs; its output equivalence was checked locally instead of rerunning paid cases.

These are the recorded $10/$1/$50 input/cached-input/output per-million scenario,
not account invoices. The first stage reused known development loss cases.
Cache-hit patterns varied; these results do not isolate a cache fix. The original
losses and frozen study remain unchanged. One short local mock-upstream probe
overlapped the initial JSON group; its timings are not a controlled CPU study.
Every-task superiority and unrestricted production readiness are not established.

## Mechanism evidence

The first implementation did not reference the nested shell outputs in actual
Codex captures: the varying outer metadata hid repeated content. The follow-up
corrected this rather than treating synthetic success as live proof.

- [Before replay](prefix-replay-v1.json): zero references on ten captured requests.
- [After replay](prefix-replay-v2.json): references appear as reads accumulate;
  all ten historical-prefix checks remain stable. Replay uses a placeholder
  recovery path, not captured forwarded bytes.
- [Actual live counters](nested-followup/references.json): each candidate attempt
  forwarded reference counts `0, 0, 1, 2, 2`, with HTTP 200 for every request.
- [Local source-driven probe](local-probe-v2.json): three nested repeated results
  are 3,878 request bytes for ours versus 13,743 for shipped HeadRoom. Nine small
  rows are 668 versus 689 bytes. One result remains 2,066 versus 4,356 bytes.
  These are synthetic byte measurements, not model-task or dollar results.
- Non-object local-shell JSON is deliberately preserved, so the array-shaped
  local-shell probe remains a size loss. Do not omit that result or count every
  probe as a win. Unknown envelope schemas need explicit handling before rewrite.

## Speed and allocation

[Recorded speed-loss timing](speed-loss-timing.json) shows higher measured upstream
time in all five initial speed losses; our summed transform time ranged from
220.7 to 329.4 ms. HeadRoom sits behind the recorder, so its upstream time includes
its own work and is not an isolated provider/competitor CPU measurement. Cold
tokenizer initialization is a real cost and is not removed from these results.

The cache correction reduced mean warm replay time for ten captured requests
from 168.3 ms to 10.9 ms (93.5%), over twelve passes in fresh processes. All ten
output SHA-256 hashes match before/after. This is an internal before/after result,
not a claim about HeadRoom allocation or latency. Raw samples:
[before](token-cache-before.json), [after](token-cache-after.json).

The same corrected replay survived with 32 MiB V8 old space, with matching output
hashes and 10.9 ms mean warm passes. Its final RSS snapshot was approximately
94 MiB; old-space limits are not RSS limits and a snapshot is not a peak or total
allocation measurement. See [constrained run](token-cache-after-32m.json) and the
[earlier 300-result pressure check](memory-check.json).

Reproduce the cache replay after building:

```powershell
node bench/live/response-cache-replay.mjs <captured-run-directory> <output.json>
```

Use `--max-old-space-size=32` before the script for the constrained variant.
Reproduce the synthetic competitor probe with
`node bench/live/headroom-gap-probe.mjs`.

## Validation

Build and changed-file ESLint passed. The combined Responses, deduplication, and
JSON-fragment suites passed 35 tests after nested-envelope support. The final
cache correction passed all 15 dedicated regression tests and the byte-identical
replay checks. Tests cover changed values, dropped referents, index eviction,
duplicate call IDs, append-only stability, transport metadata, source anchors,
multimodal parts, local-shell lexical preservation, and token-expanding outputs.

Remaining work is the measured speed variability, unexplained provider-cache
state differences, and broader workload coverage. These improvements complete
the concrete Responses implementation tasks; they do not close those larger
superiority claims.
