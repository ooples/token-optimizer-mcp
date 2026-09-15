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

## Fresh natural refresh: nine runs, all passed

`fresh-refresh/` uses seeds 8-10 with pre-existing disabled routes and natural
tool selection. Every arm occupies every position once. The proxy build stayed
fixed across all nine attempts; provider totals matched Codex's usage.

| Configuration | Mean total input | Mean uncached input | Mean requests | Mean agent seconds |
| --- | ---: | ---: | ---: | ---: |
| Control | 112,563.7 | 22,409.0 | 5.33 | 31.5 |
| Our proxy | 90,866.7 | 10,141.3 | 6.33 | 42.5 |
| HeadRoom | 116,422.3 | 9,457.0 | 8.67 | 68.3 |

Our proxy's mean input is 22.0% below HeadRoom and 19.3% below control. It still
uses more requests and takes longer than control. Two proxy runs incurred a
PowerShell quoting error in generated `node -e` commands, then recovered. The
earlier seed-4 loss also included a quoting error; attributing its entire extra
request count to compression would be incorrect. No attempts were removed.

This is a fresh balanced development screen, not statistical confirmation.
Raw captures remain at
`C:/Users/yolan/AppData/Local/Temp/codex-ab-zZjKVm/run-EgVFuW`.

## Explicit cost scenario

Each campaign's `cost-scenario.json` applies the published Codex Enterprise
standard GPT-6 Astra rates to independently audited usage: USD 10 / 1 / 50 per
million uncached-input / cached-input / output tokens. The [official rate card](https://help.openai.com/en/articles/20001415)
was checked on 2026-09-15. These estimates assume standard speed, no regional
adjustments, and no contract discount; they do not establish actual account
charges or include proxy compute. Cached input is subtracted from total input
before applying the uncached rate.

| Campaign / workflow | Estimated proxy reduction vs HeadRoom |
| --- | ---: |
| Baseline bugfix | 17.0% |
| Baseline refactor | 15.3% |
| Baseline refresh | 31.0% |
| Seed-4 iteration refresh | 9.0% |
| Adversarial truncated refresh | 45.3% |
| Fresh natural refresh | 10.5% |

The seed-4 iteration loses on total input but wins in this rate-card scenario.
The adversarial proxy still costs an estimated 39.9% more than control, and the
baseline refactor costs 20.3% more than control. The incomplete campaign retains
its failure and has no cost comparisons. Shared caches and small samples limit
all these estimates; they do not establish wins on every task or billing plan.

## Natural tool-profile comparison: four passes, cache not exercised

`profile-natural/` compares proxy plus the default core MCP catalog (`full`)
with proxy plus the seven-tool file catalog (`full-files`) on seeds 11-12,
with each configuration occupying each position once. All four answers passed,
but no run called an MCP tool. Mean total input was 89,910 versus 91,780.5
(file profile 2.1% higher); estimated token cost was 21.1% lower for the file
profile because of the observed cache mix. This does not demonstrate savings
from smaller MCP schemas or correct MCP cache use. A separate controlled cache
diagnostic is necessary. Both configurations keep the proxy enabled.

## Controlled MCP cache comparison: four cache passes, file profile loses

`profile-mcp/` uses seeds 13-14 and requires successful reads on both sides of
the external replacement plus a reported cached diff. All four runs passed
that check and the independent artifact grader. The core configuration averaged
191,931.5 input tokens; files averaged 210,492.5, 9.7% more. Its estimated token
cost was 59.4% higher. The file profile is an opt-in experiment, not a proven
Codex optimization, and the default remains core.

Large wildcard discovery calls contributed substantial overhead: one run
printed metadata selected with `/search|optimizer|mcp/`, producing a response
reported as 57,441 tokens before client truncation. Both profiles incurred
large discovery output. The exact Codex invocation with `--ignore-user-config`
was independently checked to expose only the seven file-profile tools; an
earlier suspicion of inherited global MCP configuration was not confirmed.

Initialization-only guidance was not delivered to the model in the capture
audit. Explicit bounded discovery guidance is now shipped in integrations/AGENTS.md;
see [the diagnostic](bounded-discovery/README.md) for its limitations.

## Rare boolean preservation and local performance work

[The nine-run refresh screen](rare-boolean/README.md) passed all attempts.
Our proxy averaged 25.9% less input, a 32.3% lower standard-rate cost scenario,
21.7% fewer requests, and 16.2% lower agent time than installed HeadRoom. It
still lost on speed in one round and was 2.8% slower than control on mean agent
time. This does not establish superiority on every task.

Subsequent V8 profiling motivated a bounded per-proxy cache of unchanged tool
outputs. [The local replay](response-cache-profile.json) measured about 48%
lower mean compression time and 54% fewer sampled allocation bytes. All six
captured requests produced byte-identical old/new compressed bodies in a
separate check. These are local processing results, not a competitor CPU or
allocation comparison and not proof of end-to-end latency gains.

[The cached-build live follow-up](output-cache-live/README.md) passed 4/4.
Mean agent time tied HeadRoom and input was 0.9% lower, but the cost scenario
was 47.8% higher and requests increased. Replayed prior input items stayed
stable across all append transitions; the provider cache-miss cause remains
unproven. This loss remains part of the evidence.
