# Local shipped-proxy performance comparison

Same synthetic Responses requests forwarded to the same local HTTP upstream
through our built proxy, installed HeadRoom 0.37.0, and our forwarding-only control.
Three rotated arm orders, six groups per arm, five warmup requests and forty
measured requests per group: **2,160 measured requests**, all completed.

HeadRoom uses its documented `--no-rate-limit` option for throughput measurement;
compression settings remain default. The initial default-rate run hit HTTP 429
and is retained as rate-limited-incomplete.json, excluded from these measurements.
Live Codex comparisons continue to use HeadRoom's shipped defaults.

| Tool output | Mode     | Proxy mean ms | HeadRoom mean ms | Proxy CPU reduction |
| ----------- | -------- | ------------: | ---------------: | ------------------: |
| Logs        | repeated |          3.03 |            22.83 |               94.8% |
| Logs        | unique   |          3.99 |            20.57 |               91.3% |
| JSON        | repeated |          3.77 |            17.95 |               93.1% |
| JSON        | unique   |          5.78 |            54.60 |               90.8% |
| Code        | repeated |          2.42 |            14.93 |               91.9% |
| Code        | unique   |          3.07 |         4,578.33 |              99.99% |

The unique-code HeadRoom means in the three rounds were 4,629.83, 5,054.21 and
4,050.94 ms; the large value is not a single timeout or failed request. Raw samples,
medians, p95, per-round means, CPU samples, and upstream byte counts are retained.
Our proxy sends fewer bytes in five groups; unique code sends 11,208 mean bytes
versus HeadRoom's 10,600.3 (5.7% more). No all-metric win is claimed.

Sampled peak private memory across each proxy process tree: ours 83,898,368 bytes
(80.0 MiB), HeadRoom 2,002,698,240 (1,909.9 MiB), forwarding control 69,337,088
(66.1 MiB). **These are process footprints, not allocation volumes.** CPU is the
process-tree counter difference around each measured batch, including runtime
and background work during the sampling window.

This is local transport/transform evidence, not live model quality or billed-cost
evidence. It runs on a normal workstation without CPU affinity; routine monitoring
and tooling may add background load. Full Jest execution finished before this
comparison. Within-group samples are correlated, and no independent-request
confidence interval is claimed. Fresh processes do not imply cold persistent caches.

Reproduce with `node bench/live/local-proxy-performance.mjs`, then pass its raw
directory to `node bench/live/local-proxy-performance-report.mjs DIRECTORY`.
Complete raw run: C:/Users/yolan/AppData/Local/Temp/local-proxy-performance-6FvvHE
