# Adversarial joint cost and speed development

The original 70-pair study has **51 joint wins, 11 cost-only losses, five speed-only losses, two losses on both metrics, and one failed attempt**. All cases are retained in `original-joint-audit.json`. A joint win requires audited quality and strictly lower estimated token cost and agent wall time. Unknown charges and ties never become wins.

## Implemented changes

- Preserve explicit JSON nulls, including recovery files. Null and absent are different values.
- Supply exact bounded null/missing counts and numeric extrema with source rows.
- Record monotonic transform, upstream-header and upstream-completion timing for successful and failed requests. Upstream includes transport and provider processing; the HeadRoom arm also includes its proxy.
- Reject impossible numbered-read candidates before allocating per-line matches.
- Share unchanged nested trees and multimodal output parts instead of copying them.
- Represent complete numeric arrays with exact templates when no rare categorical/boolean population supplies a compact summary and the representation materially beats minification. Every source byte can be reconstructed; incomplete arrays cannot claim completeness.
- Add tiny, opaque digest, numeric extrema and null-versus-absent live workloads; local repeated, unique, append-only and changing-prefix traffic at concurrency one and eight.
- Add every-case joint audits and multiplicity-adjusted per-family cost/time bounds plus exact joint-win probability bounds. Finite evidence never certifies every future execution.

## Initial live development campaign

`live-initial/` records product `253318f0`, eight balanced pairs, all 16 tasks passing. It predates complete numeric-array templates. Numeric summaries still caused verification reads: four requests versus HeadRoom's three in both cases. The complete-array codec was implemented in response; these losing attempts remain evidence.

Two entropy pairs were joint wins (three requests versus five). Tiny tasks had no compressible outputs and lost agent time in both pairs. Inspection of HeadRoom's installed tool compactor found description-whitespace changes consistent with the first-request token gap; we have not established that as its sole cause. Nullable tasks needed no recovery reads but provider cache and response times varied. One nullable proxy attempt spent 49.56 seconds upstream versus 15.49 milliseconds transforming requests; its competitor arm spent 13.97 seconds upstream. This is observed timing, not proof of why the provider was slower.

The initial nullable generator had fixed counts across seeds. The subsequent generator varies row count, null frequency and missing-key frequency. Reproduce initial evidence from its recorded commit; do not apply a newer generator's validator to those older files.

## Local comparison before the final array codec

`local-before-null-facts/`: 2,880 measured requests, 36 groups, two reversed arm orders. Proxy mean latency was lower in all 36 groups; forwarded bytes were smaller in 24 and tied in 12 tiny/opaque groups. Actual installed HeadRoom 0.37.0, with its rate limiter disabled for local throughput measurement. Warmup is excluded. These are local transport/byte measurements, not provider costs or task-quality evidence. This preliminary build predates the complete-array and copy-on-write changes.

## Complete-array follow-up and final local results

`numeric-followup/` records product `74f20dd3`: four balanced pairs, two original seeds plus two neighboring fresh seeds, no retries. All eight tasks passed; all four proxy attempts completed in three requests without a recovery read. All four cost comparisons favored proxy (34.5% lower aggregate estimated cost); three were joint cost-and-speed wins. The first pair was slower (15.6 vs 14.3 seconds). This small follow-up does not erase earlier losses or independently establish broad superiority.

`local-final/` contains 3,840 measured requests across 48 groups, including changing-prefix traffic and concurrency one/eight. Proxy mean latency was lower in all 48; forwarded bytes were smaller in 32 and tied in 16. Both arms preserved cache keys and previously transformed output in every measured repeated-prefix check.

`sharing/` verifies identical full Responses results on three captured nullable requests. Across 500 fresh-cache rounds (1,500 calls), mean internal time was 0.886 vs 0.861 ms and sampled allocation was 681,463,024 vs 644,979,520 bytes (5.4% lower). This is one before/after runtime profile, excludes network/disk, and is not a competitor allocation comparison.

## Release claim

These are development data used to improve the product. Fresh confirmation must freeze the final compiled product and all measurement code before calls. Provider caching is observed, not forcibly cold. Recorded rate-card estimates are not invoices or full deployment costs. Family averages, individual wins and uncertainty are reported separately.
