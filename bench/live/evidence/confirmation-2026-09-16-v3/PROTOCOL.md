# Preregistered confirmation protocol and adversarial review

## Scope and fixed claim

Compare our existing compression proxy with installed HeadRoom using local
Codex 0.154.0 and gpt-6-astra. The candidate product is frozen at the source
state of 9a151eccaeb5d609bba82beed22b08e5b7c5241c, including the categorical retention
and failure-accounting fixes. freeze.json records executable/module
hashes for both products, Codex, the harness, analysis, plan, and this protocol.
No product tuning is allowed after confirmation starts.

The possible claim is **cost superiority on this generated synthetic suite and
configuration**, subject to the gates below. It is not superiority on all tasks,
all models, actual invoices, independent real-world repositories, or all cache
regimes. This adversarial self-review is not an independent third-party audit.

## Adversarial review completed before execution

| Attack on the proposed study                              | Resolution / remaining limitation                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeated known fixtures reward tuning to examples.        | Generate 70 new seeded instances after freezing the product; record case hashes. Vary content, targets, data sizes, initial bug forms, discounts, existing exceptions and override values. Task families and their generators are ours, so this is held-out instance evidence, not an external benchmark.                 |
| Changing only seed labels creates fake diversity.         | Verify all case hashes are unique. Thirty lookup answer keys and forty good/bad workflow oracle cases are checked before live execution. Existing development instances are excluded from confirmation.                                                                                                                   |
| A fresh process is mislabeled cold.                       | Never make that assumption. Keep first-request and within-session continuation usage separate, record actual cached tokens, and report zero/partial first-request cache exposure. We cannot flush the provider cache.                                                                                                     |
| Cache luck is mistaken for a codec improvement.           | Randomize case order and balance arm order within every family. Report first-request-cold fixed-trace sensitivity separately. It is neither observed billing nor proof of causality. No unsupported cache-key changes.                                                                                                    |
| The agent takes different paths.                          | Same generated task, model, permissions and output budget per pair. Count every request, failure and recovery. The estimand is end-to-end configured-system cost, not a causal decomposition of individual transforms.                                                                                                    |
| One lucky comparison or optional stopping produces a win. | Use historical development data for sizing only; commit the whole schedule before execution. Complete it regardless of favorable/unfavorable task outcomes. No interim significance-based stopping or extra winner-selected repetitions.                                                                                  |
| Cheap wrong answers count as cost wins.                   | Correctness gate is mandatory. Failed tasks remain in cost totals when usage is measurable; they cannot establish superiority. Missing/unreconciled usage invalidates the claim, never becomes zero.                                                                                                                      |
| Failure retries disappear from accounting.                | No automatic reattempts into this sample. Existing model-level retries are disabled by the harness. Tool recovery inside a run remains included. Record provider errors and partial attempts.                                                                                                                             |
| The grader shares the implementation's mistake.           | Protected-file checks plus post-run external oracles and public tests for code changes; independent parsing of lookup keys; exact before/after configuration and override checks. Gold and deliberately broken implementations validate oracle rejection. Process-compliance claims beyond these audits are out of scope. |
| The comparator is an imitation or silently reconfigured.  | Use installed HeadRoom's actual proxy with its shipped defaults. Our proxy uses its current defaults. Freeze implementation hashes and record Python package versions. This is a defaults comparison, not a search over HeadRoom settings.                                                                                |
| Geometric averages hide a dollar-cost regression.         | Require both paired geometric cost ratio and equal-family aggregate-dollar ratio to pass the margin. Report both.                                                                                                                                                                                                         |
| Testing seven families inflates claims.                   | Only the overall suite is confirmatory. Per-family outcomes are exploratory and include losses; no per-family superiority claim from unadjusted intervals.                                                                                                                                                                |
| A narrow/biased confidence method overstates certainty.   | Use 20,000 paired, family-stratified BCa bootstrap draws, with delete-one-pair jackknife acceleration; implementation is checked against SciPy on a single-family case. Intervals remain approximate and assume independent case pairs. Shared provider state can violate independence.                                   |
| Frozen source differs from the tested binary.             | Hash the compiled product, competitor modules, Codex executable, harness and analysis before execution; verify before and after every pair. Stop incomplete on any change.                                                                                                                                                |

## Sampling and execution

plan.json contains the immutable randomized sequence, seeds, case hashes,
ordered arms, family labels and scenario. Seven equally weighted families:
log diagnosis, JSON outlier lookup, code search, retry-policy bugfix, multi-file
money refactor, external configuration refresh, and mixed-output refresh.
Lookup tasks require the same full initial read; workflow tasks allow natural
tool choices except mixed-output refresh, whose initial exposure is audited.

The historical pilot contains 32 comparable passing development pairs across
multiple builds. Its within-task residual log-cost standard deviation is
0.314. The planning rule uses max(pilot SD, 0.5), a target ratio of 0.8, a
superiority boundary of 0.95, two-sided alpha 0.05 and approximate 80% power.
Round the resulting pair count up to a multiple of 14, with a minimum of 70
and predeclared ceiling of 210. This selects **70 pairs / 140 runs**, ten pairs
per family, with each arm first five times within each family. The log-normal
power approximation is planning, not a guarantee of power for the dollar gate.

Runs execute sequentially on this machine. Existing per-run timeouts remain:
180 seconds for lookups, 300 seconds for workflows, plus process startup.
Preserve all raw traces locally and compact manifests, usage, audits, and
results in the PR. Do not pool development screens into the confirmation sample.

Stop early only for user interruption, frozen-artifact change, harness/auditor
failure that prevents reliable measurement, or three consecutive pairs with
provider infrastructure errors. Such a stop is **incomplete/inconclusive**, not
superiority. Audited task failures alone do not stop the remaining schedule.

## Prespecified endpoints and success gates

Use the recorded Codex Enterprise standard rate-card scenario: USD 10 / 1 / 50
per million uncached input / cached input / output tokens. Cached input is a
subset of total input. This is not API cache-write pricing or actual account
billing. Scenario source and assumptions are copied into plan.json.

Primary cost endpoints, equally weighting the seven families:

1. Geometric mean of paired proxy/HeadRoom cost ratios.
2. Ratio of the two arms' mean dollar costs, with each family equally weighted.

Both **two-sided 95% BCa interval upper bounds must be below 0.95**. Every
expected attempt must be present and independently audited; every provider
ledger must reconcile to client usage, with no missing usage or exposure.
All 70 proxy tasks must pass. With zero failures, the one-sided 95% success
lower bound is 0.05^(1/70), about 95.8%, under the independent-case model.
This strict absolute-quality gate is stronger than merely accepting an
observed success-rate tie. Any failed proxy task defeats the chosen gate.

No superiority claim if any gate fails, evidence is incomplete, or the bootstrap
distribution is degenerate. Cost estimates for failed but fully measured tasks
remain descriptive. Report success counts for both arms, per-family losses,
requests, input/cached/output totals, agent latency, startup-inclusive latency,
and first-request versus continuation cache usage. Speed and allocation claims
are separate from this cost/correctness claim.

The cold-first-request sensitivity changes that charge only, holding subsequent
usage and model behavior fixed. It does not control later cache misses or create
an observed cold/warm experimental cohort. A controlled cache-regime claim
remains unavailable without provider-supported cache controls or diagnostics.

## Method references

- [SciPy paired bootstrap and BCa documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html).
- [NIST exact binomial confidence limits](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).
- [Scenario's official Codex rate card](https://help.openai.com/en/articles/20001415), previously verified 2026-09-15.

## Third registration: current product and complete attempt accounting

The product now includes rare string-group retention (8776575a) and transport
failure accounting (9a151ecc). Prior studies and development screens are retained
but excluded from final inference. These 70 seeds and case hashes are
disjoint from every scheduled v1/v2 case and the categorical development seeds.
Schedule seed is 916202603. This is a fixed single study, not permission to keep
rerunning studies until significance appears. The earlier study was inconclusive;
its result is not retroactively changed by the new analyzer.

Adversarial review: failure of one arm must not erase the other's valid task
outcome. The analyzer now records every validated attempt independently, including
known partial provider usage, request indices with unknown usage, and null total
cost when incomplete. Local socket failures are recorded with status 0. Transport
errors count toward the existing three-consecutive-infrastructure-failure stop.
Missing charges are never invented or treated as free; all original strict cost
and correctness gates remain. A provider failure can still prevent confirmation.

Both arms receive the repaired full-read instructions: 18,000 shell tokens and
24,000 enclosing code-mode tokens. Both-arm INVALID_READ stops incomplete for
measurement review. STOP.json allows only the original protocol's stated reasons.
Model request/stream retries remain disabled symmetrically; every request is
retained. No replacements for failed cases or unrecorded recovery attempts.

The all-input-uncached sensitivity charges every recorded input token at the
uncached rate while holding behavior fixed. Report alongside actual-cache and
first-request sensitivity results. It is not a measured cold-cache cohort and
does not establish a cache mechanism. Allocation and local transform speed are
separate measurements; end-to-end agent time is descriptive here.

Current product source, compiled modules, comparator, CLI, harness, analysis,
protocol and schedule are frozen before first execution. Existing freeze files
remain unchanged. Local full-suite validation and generator/oracle preflight
precede live execution. Every result is pushed to the same progress PR.
