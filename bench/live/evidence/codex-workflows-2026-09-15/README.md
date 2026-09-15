# Codex natural-workflow development screen

Local Codex 0.154.0, gpt-6-astra, Node 22.15.0, installed HeadRoom 0.37.0.
Authenticated HTTP Responses traffic; all arms retain the proxy recorder.

## Baseline: 27 runs, three repetitions per task and arm

All 27 passed independent artifact checks. Provider ledger totals matched
Codex's input, cached-input and output usage. Each arm occupied every position.

| Workflow | Control input | Our proxy input | HeadRoom input | Our input reduction vs HeadRoom |
| --- | ---: | ---: | ---: | ---: |
| Retry-policy bug fix | 83,394.7 | 88,082.7 | 136,501.7 | 35.5% |
| Multi-file money refactor | 63,950.0 | 59,157.7 | 104,619.3 | 43.5% |
| External configuration refresh | 138,662.7 | 98,986.3 | 118,701.3 | 16.6% |

These are means of total input, including cached input, not dollar costs.
Uncached input was higher for our proxy than HeadRoom on bugfix/refactor, and
lower on refresh. Our bugfix total input exceeded control by 5.6%; refactor and
refresh were lower than control by 7.5% and 28.6%. Execution latency and output
tokens are separate fields in [the summary](baseline/summary.json).

The screen used small synthetic repositories and natural tool selection, not
forced full-file reads. Client truncation and recovery reads are part of the
outcome. Proxy-only runs do not exercise MCP file caches. Initial runner artifacts
were visible in the task directory; subsequent runner versions put those outside
`workspace/`. The build stayed fixed throughout this screen. Build hashes were
recorded during the run; the runner was hardened afterward. The baseline was
run before the new TAP and truncated-JSON-fragment representations were built.

Three repetitions are development evidence, not a statistical confirmation or a
claim to win every metric. Shared provider caches were not isolated. No raw
request bodies are committed here. Local captures remain under
`C:/Users/yolan/AppData/Local/Temp/codex-ab-lIHGcP/run-wxw7PT`.

## Designs prompted by the screen

- TAP: represent repeated test-record structure and identical diagnostics with
  an exact template and individual rows. Preserve each test identity, status,
  duration and diagnostic, including failures.
- Truncated JSON: template complete flat records on either side of missing
  content. Preserve the truncation warning, gap, partial records, rare values,
  and lexical spelling. Missing records remain explicitly unknown.
- Complete JSON arrays: attach exact boolean counts when eliding rows, so a
  question about enabled/disabled totals does not require rereading the tail.
  Counts distinguish true, false, missing and other values; they are never
  presented as whole-array facts for truncated fragments.

The format templates have byte-for-byte reconstruction tests; boolean facts
have independent counting tests. All are routed through the existing proxy.
Raw replay is a diagnostic and does not establish live
quality, token, or cost savings.

## First fresh-variant diagnostic: incomplete

`fresh-variant-incomplete/` preserves all nine attempts with the initial TAP and
fragment candidate, before boolean facts were added. Eight passed; our bugfix
arm hit a provider capacity error before any tool call. The audited verdict is
`PROVIDER_ERROR`, usage is missing, and the overall report is invalid with no
headline comparisons. This attempt is retained, not replaced by a retry.

The refresh pair exposed a loss worth investigating: our proxy used 80,093
input tokens versus HeadRoom's 75,369. Our agent reread the elided complete array
to count disabled routes. That observation prompted exact whole-array boolean
facts. These fixtures then became development data for that change. The
refactor proxy and control were effectively tied (54,729 and 54,676 input).

## Iteration: six runs, all passed

`iteration/` reruns bugfix and refresh on seed 4 with all three proxy arms.
Provider totals matched Codex again. TAP compression activated on three bugfix
requests; fragment compression activated on six refresh requests.

| Workflow | Control input | Our proxy input | HeadRoom input |
| --- | ---: | ---: | ---: |
| Varied retry cases | 96,443 | 96,661 | 146,323 |
| Configuration refresh | 151,887 | 105,305 | 59,559 |

This is one repetition, not a confirmation. Bugfix input was 33.9% below
HeadRoom and effectively tied with control. Refresh input was 30.7% below
control but 76.8% above HeadRoom: seven provider requests versus four. Our
refresh uncached input was lower (7,897 versus 16,423); these distinct metrics
must not be collapsed into a dollar-cost claim. The initial refresh view was
already truncated, so this run did not establish that whole-array boolean facts
eliminate a lookup. The natural-workflow turn-count loss remains unresolved.

## Adversarial truncated refresh: four runs, all passed

`adversarial/` uses seed 7 with a pre-existing disabled route outside every
arm's initial truncated view. Each arm correctly recovered that route before
the external replacement and identified the newly disabled route afterward.
The exposure audit confirms actual truncation and that the pre-existing route
was absent from all four initial outputs. Provider totals matched Codex.

| Configuration | Total input | Cached input | Provider requests |
| --- | ---: | ---: | ---: |
| Control | 118,073 | 108,160 | 7 |
| Our proxy | 103,160 | 80,768 | 7 |
| HeadRoom | 154,297 | 105,472 | 8 |
| Our proxy plus MCP | 153,430 | 133,248 | 9 |

Our proxy used 33.1% less total input than HeadRoom and 12.6% less than control.
The combined configuration retained proxy compression and completed two real
MCP `smart_read` calls, including a cached diff after the file replacement.
It passed, but used 48.7% more total input than proxy-only. Its 0.6% reduction
versus HeadRoom is effectively a tie in this single, unbalanced repetition.
MCP-reported savings are not substituted for provider usage.

This diagnostic does not resolve the natural-refresh loss above. Results from
different builds, fixtures and read modes are not pooled. Across these four
campaigns, 45 of 46 attempts passed; the remaining attempt was the retained
provider capacity error before any tool call. These are development results,
not proof of universal wins. Raw captures for this last campaign remain at
`C:/Users/yolan/AppData/Local/Temp/codex-ab-Ge6Nld/run-Ontqw6`.
