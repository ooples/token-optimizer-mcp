# Allocation hardening and live follow-up

## Implemented fix

The asynchronous capture writer eagerly serialized every incoming request into a
full JSON string and retained an unbounded queue while disk writes lagged. A
2,000-record burst of 128 KiB records reproduced an out-of-memory termination in
the baseline under `--max-old-space-size=32`.

Capture now reserves capacity before copying, bounds the global queue to 128
requests / 16 MiB of snapshots and metadata, and streams JSON escaping in 64 KiB
chunks with at most two active writers. UTF-8 boundaries, enqueue-time contents,
and per-destination record order are preserved. Excess capture requests return
false without copying; the proxy warns once and continues forwarding requests.
The independent live auditor marks warned attempts `INVALID_CAPTURE` rather than
accepting incomplete evidence as a win.

The corrected capture-only pressure run exited successfully: 127 records
accepted, 1,873 explicitly rejected, about 5.1 MB used JavaScript heap. This is
bounded overload behavior, not lossless capture under arbitrary load.

## Original crash and remaining uncertainty

The frozen study's `nullable-9` attempt failed in both native Codex and Node after
the first 63,212-byte, uncompressed request, before a tool read. Its unknown
provider usage and failure remain in that study. There was no contemporaneous
host-memory trace. The capture backlog bug above is a separately reproduced
failure; it does **not** establish the cause of that first-request crash.

The Windows live runner now records system commit/physical-memory samples every
second. Before either arm starts, it requires at least 2 GiB of commit reserve,
512 MiB of available physical memory, and a recent valid sample. Otherwise it
stops before that attempt and records the reason. It never removes or substitutes
completed failures. This is a benchmark resource guard, not a production memory
limit or a guarantee against other applications exhausting memory mid-request.
Future proxy fatal errors also request Node diagnostic reports in the raw
artifact directory, excluding environment variables and network diagnostics.
Those report launch flags were added after the live runs below.

## Constrained-memory replay

Both modes replay the original captured request 1,344 times through the actual
proxy at concurrency eight, with V8 old space limited to 32 MiB. This flag does
not cap total heap, external buffers, or process RSS. The `heapLimitMiB` field in
the raw replay artifacts refers specifically to this old-space flag.

| Mode | Forwarded unchanged | Captures retained | Exit | Final post-GC heap used |
| --- | ---: | ---: | ---: | ---: |
| Sustained: mock upstream waits 20 ms | 1,344/1,344 | 1,344 | 0 | 8,622,200 B |
| Overload: zero-delay mock upstream | 1,344/1,344 | 446 | 0 | 8,648,568 B |

The first zero-delay experiment also survived but failed a harness assertion
requiring lossless capture under overload; it retained 423/1,344 captures. That
failed validation attempt is preserved in `initial-overload-attempt.json`.
The revised harness separates sustained capture completeness from overload
survival and writes its measured result before asserting capture completeness.
These local replays establish neither model quality nor provider cost wins.

## Live Codex versus installed HeadRoom

Four development pairs / eight attempts, with both arm orders within each family.
Codex 0.154.0, gpt-6-astra, HeadRoom 0.37.0. Nullable seeds 2494523014 and
2494523015 (the first deliberately repeats the failed case); JSON seeds
3141592001 and 3141592002. These are new follow-up results, not replacements in
the frozen 120-pair study.

| Measure | Token Optimizer | HeadRoom |
| --- | ---: | ---: |
| Independently validated quality | 4/4 | 4/4 |
| Estimated token cost, recorded rate-card scenario | $0.646138 | $0.751738 |
| Total agent time | 60.3 s | 73.7 s |

Ours was faster in all four pairs, cheaper in two, and more expensive in two:
two strict joint wins, two cost losses. Aggregate estimated cost was 14.0% lower
and agent time 18.2% lower. Cache discounts varied; these are observed costs,
not proof that the memory fix caused a cost or speed improvement. Both live
campaigns retained over 4.7 billion bytes of sampled commit reserve and over
3.3 billion bytes of available physical memory. No allocation failure occurred.

The original case now passes and wins both measures, but four follow-up pairs
do not establish production readiness or superiority on every task. The larger
frozen study's 77/120 strict joint wins and remaining losses still govern that
claim. See `live-summary.json` and each campaign's independent validation,
cost scenario, provenance, and memory trace.

## Verification and reproduction

- Build and changed-file ESLint passed; 12 capture tests passed, including
  chunk-edge Unicode, buffer mutation, queue saturation and recovery.
- `capture-audit-check.mjs` invalidated a copy of a passing real attempt after
  injecting the capture warning, while preserving the original evidence.
- Host-memory checks covered healthy, low-reserve, and stale samples, then ran
  the actual Windows monitor and cleanup. The two live campaigns also exercised
  the monitor throughout.

From the repository root, after `npm run build`:

```powershell
node --max-old-space-size=32 bench/live/capture-pressure.mjs
node bench/live/memory-replay.mjs PATH_TO_REQUESTS_JSONL NEW_OUTPUT_DIR sustained
node bench/live/memory-replay.mjs PATH_TO_REQUESTS_JSONL ANOTHER_OUTPUT_DIR overload
```

Use a fresh output directory for each replay. Raw request bodies remain in the
local temporary directories named by the artifacts; they are not published here.
`capture-pressure.json` preserves the original baseline OOM stderr and corrected
run output. `implementation-hashes.json` identifies the compiled product and
supporting files; live provenance separately records the run-time hashes.
