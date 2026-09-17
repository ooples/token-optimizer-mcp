# Log cost and repetitive-input follow-up

## Baseline live evidence

[The complete campaign](release-7-multiworkload-proof.json) contains four balanced
pairs for each of logs, JSON and code search. All 24 attempts passed artifact and
complete-read validation. The interrupted preceding campaign is retained
separately and excluded from these means.

| Workload | Our mean agent time | HeadRoom | Estimated cost reduction |
| --- | ---: | ---: | ---: |
| Logs | 16.30 s | 32.80 s | **-3.25% (loss)** |
| JSON | 15.45 s | 16.25 s | 44.01% |
| Code search | 16.95 s | 32.75 s | 31.00% |

There were 11/12 individual agent-time wins and 10/12 estimated-cost wins. Cache
usage varied between runs and is included in the receipt. These are development
results on generated workload families already used in this project, not a claim
of unseen-task or production-repository superiority.

## Implementation

- Exact repeated sequences of one to eight safe log lines now retain one block
  and an explicit repeat count. The order, timestamps and whitespace remain
  reconstructible inline; error lines remain visible. This avoids listing the
  same timestamp repeatedly. Later grouping cannot move the referenced block.
- Scattered copies now retain explicit sequence positions and raw prefixes.
  Timestamps alone were ambiguous when equal, absent or out of order.
- Templates retain positions too. Literal hashes and delimiter collisions are
  left intact, and input resembling the codec's own annotations is not wrapped
  again. An independent decoder round-trips generated mixed sequences.
- Scattered grouping appends indices to arrays instead of copying a growing
  array on every duplicate.
- TokenCounter reuses identical bounded chunks within one call, with at most
  16 chunk entries. The existing boundaries and token counts are unchanged.
- The proxy token gate can accept a candidate without loading or executing the
  tokenizer when vocabulary bounds prove the existing 10% / eight-token margin.
  The maximum token byte length provides a lower bound on original tokens;
  candidate bytes provide an upper bound on candidate tokens. Uniform ASCII runs
  use tighter bounds verified against the actual o200k_base vocabulary. Other
  candidates retain the existing token check and fallback behavior.

## Local measurements

[Raw before/after receipt](release-7-repeated-count-proof.json), single development
measurements, outside the live campaign:

| Counter input | Before | After | Tokens unchanged |
| --- | ---: | ---: | ---: |
| Repeated ASCII, 262,144 characters | 1,216 ms | 89 ms | 32,768 |
| Repeated emoji, 262,144 UTF-16 units | 3,496 ms | 116 ms | 262,144 |
| Repeated alphabet cycle | 1,166 ms | 477 ms | 10,189 |
| Varied JSON | 71 ms | 77 ms | 62,991 |

The varied JSON sample was slightly slower; these single measurements are not
statistical confirmation. The cold token-gate probe over 32,768 repeated ASCII
characters returned the same acceptance result in 1.7 ms versus 1,489 ms, with
RSS growth of 0.42 MiB versus 39.2 MiB. RSS is resident-memory growth, not total
allocated bytes. The gate bounds apply to the named local estimate tokenizer,
not to an unknown provider's billed tokenizer.

## Follow-up validation

The full local run completed 330 suites: 328 passed and two fixture/schema
checks failed. Both were corrected and their 14 tests passed on the targeted
rerun. The original run had 4,500 passing tests and 12 skipped tests; no product
failure remained from that run.

[The fresh log campaign](release-7-log-cost-proof.json) passed all eight attempts.
All four pairs favored ours on both agent time and estimated cost. Mean agent
time was 17.10 s versus 32.525 s; mean estimated cost was $0.119668 versus
$0.296643, a 59.66% reduction under the recorded rate-card scenario. Input tokens
averaged 41,532 versus 117,522. Provider cache variation remains included.
These are development results, not universal or unseen-workload confirmation.

The install review also found that piped npm lifecycle output was mistaken for
CI. Global postinstall now invokes the packaged, non-interactive Node installer
without requiring a TTY or an installed Claude binary. Explicit CI and local
dependency installs still skip automatic user configuration. Nineteen targeted
installation tests passed. Package-manager policies that disable lifecycle
scripts still require the explicit `token-optimizer-install` command.

Account-blocked Claude, Copilot and Gemini gates stay pending.
