# Rare string-group development screen

Product commit 8776575a adds bounded retention of complete rare string-value
groups and exact population counts to JSON elision. This follows the frozen
confirmation candidate's 35.1% JSON estimated-cost loss across ten measured pairs.
The original confirmation remains unchanged and does not validate this new build.

## Adversarial self-review and focused validation

- No failure-word special case: arbitrary low-cardinality string fields qualify.
- Reject high-cardinality ID fields and values longer than 80 characters.
- Never keep part of a population while claiming the whole population survived.
- At most eight candidate fields, eight values per field, eight admitted groups,
  eight rows per group, and min(32, 10% of rows) total retained rows from this rule.
- Count from the complete input before elision; preserve escaped values as data.
- Existing spill recovery remains available for all omitted records.
- Build, targeted ESLint, and 11 category/boolean/mixed-JSON checks passed.

## Live results

Four fresh paired JSON cases, seeds 1900000001 through 1900000004, using local
Codex gpt-6-astra and actual HeadRoom 0.37.0. Each arm was first twice. All eight
attempts are retained. Proxy passed 3/4; HeadRoom passed 4/4. Proxy rep 1 received
an upstream 503 after its complete initial read. Its partial ledger is retained,
but its total cost is unknown. This is not a full-campaign cost win.

All three fully measured pairs passed exposure, answer, and usage audits:

| Measure | Proxy | HeadRoom | Reduction |
| --- | ---: | ---: | ---: |
| Total input tokens | 119,775 | 145,476 | 17.7% |
| Estimated cost, fixed standard-rate scenario | $0.596358 | $0.688282 | 13.4% |
| Agent seconds | 56.6 | 65.5 | 13.6% |
| Requests | 9 | 9 | 0% |

Each successful proxy attempt answered after the initial read and answer write,
using three model requests. The frozen build averaged four requests across its
ten JSON cases (range three to five). Different seeds and provider state mean this is not a
same-case randomized causal estimate of the code change.

One measured pair cost 2.7% more for proxy, despite lower input and faster agent
time; the other two cost less. A fixed-trace first-request-uncached sensitivity
gives 17.7% lower estimated cost in this subset. This is a sensitivity calculation,
not a measured cold-cache experiment. No confidence or universal superiority
claim is made from these three complete pairs.

Run `node bench/live/evidence/json-categories-2026-09-16/describe.mjs` from the
repository root to regenerate the descriptive subset report. The standard audit
correctly rejects the whole campaign because of the unmeasured failed attempt.
Raw artifacts: C:/Users/yolan/AppData/Local/Temp/codex-categories-live/run-W9D5I7
