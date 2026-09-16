# Preregistered confirmation protocol and adversarial review

## Scope and fixed claim

Compare our existing compression proxy with installed HeadRoom using local
Codex 0.154.0 and gpt-6-astra. The candidate product is frozen at the source
state of 62c0b678 (same product as 09b3fcf5). Only measurement code and generated
cases changed during this preparation. freeze.json records executable/module
hashes for both products, Codex, the harness, analysis, plan, and this protocol.
No product tuning is allowed after confirmation starts.

The possible claim is **cost superiority on this generated synthetic suite and
configuration**, subject to the gates below. It is not superiority on all tasks,
all models, actual invoices, independent real-world repositories, or all cache
regimes. This adversarial self-review is not an independent third-party audit.

## Adversarial review completed before execution

| Attack on the proposed study | Resolution / remaining limitation |
| --- | --- |
| Repeated known fixtures reward tuning to examples. | Generate 70 new seeded instances after freezing the product; record case hashes. Vary content, targets, data sizes, initial bug forms, discounts, existing exceptions and override values. Task families and their generators are ours, so this is held-out instance evidence, not an external benchmark. |
| Changing only seed labels creates fake diversity. | Verify all case hashes are unique. Thirty lookup answer keys and forty good/bad workflow oracle cases are checked before live execution. Existing development instances are excluded from confirmation. |
| A fresh process is mislabeled cold. | Never make that assumption. Keep first-request and within-session continuation usage separate, record actual cached tokens, and report zero/partial first-request cache exposure. We cannot flush the provider cache. |
| Cache luck is mistaken for a codec improvement. | Randomize case order and balance arm order within every family. Report first-request-cold fixed-trace sensitivity separately. It is neither observed billing nor proof of causality. No unsupported cache-key changes. |
| The agent takes different paths. | Same generated task, model, permissions and output budget per pair. Count every request, failure and recovery. The estimand is end-to-end configured-system cost, not a causal decomposition of individual transforms. |
| One lucky comparison or optional stopping produces a win. | Use historical development data for sizing only; commit the whole schedule before execution. Complete it regardless of favorable/unfavorable task outcomes. No interim significance-based stopping or extra winner-selected repetitions. |
| Cheap wrong answers count as cost wins. | Correctness gate is mandatory. Failed tasks remain in cost totals when usage is measurable; they cannot establish superiority. Missing/unreconciled usage invalidates the claim, never becomes zero. |
| Failure retries disappear from accounting. | No automatic reattempts into this sample. Existing model-level retries are disabled by the harness. Tool recovery inside a run remains included. Record provider errors and partial attempts. |
| The grader shares the implementation's mistake. | Protected-file checks plus post-run external oracles and public tests for code changes; independent parsing of lookup keys; exact before/after configuration and override checks. Gold and deliberately broken implementations validate oracle rejection. Process-compliance claims beyond these audits are out of scope. |
| The comparator is an imitation or silently reconfigured. | Use installed HeadRoom's actual proxy with its shipped defaults. Our proxy uses its current defaults. Freeze implementation hashes and record Python package versions. This is a defaults comparison, not a search over HeadRoom settings. |
| Geometric averages hide a dollar-cost regression. | Require both paired geometric cost ratio and equal-family aggregate-dollar ratio to pass the margin. Report both. |
| Testing seven families inflates claims. | Only the overall suite is confirmatory. Per-family outcomes are exploratory and include losses; no per-family superiority claim from unadjusted intervals. |
| A narrow/biased confidence method overstates certainty. | Use 20,000 paired, family-stratified BCa bootstrap draws, with delete-one-pair jackknife acceleration; implementation is checked against SciPy on a single-family case. Intervals remain approximate and assume independent case pairs. Shared provider state can violate independence. |
| Frozen source differs from the tested binary. | Hash the compiled product, competitor modules, Codex executable, harness and analysis before execution; verify before and after every pair. Stop incomplete on any change. |

## Sampling and execution

plan.json contains the immutable randomized sequence, seeds, case hashes,
ordered arms, family labels and scenario. Seven equally weighted families:
log diagnosis, JSON outlier lookup, code search, retry-policy bugfix, multi-file
money refactor, external configuration refresh, and mixed-output refresh.
Lookup tasks require the same full initial read; workflow tasks allow natural
tool choices except mixed-output refresh, whose initial exposure is audited.

The historical pilot contains 29 comparable passing development pairs across
multiple builds. Its within-task residual log-cost standard deviation is
0.325. The planning rule uses max(pilot SD, 0.5), a target ratio of 0.8, a
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

## Replacement registration and delivery repair

This is a new study, v2. The original study stopped incomplete under its
measurement-failure rule after nine completed pairs and one interrupted pair.
Both json-4 arms' first model-facing output was truncated by the enclosing
code-mode tool despite the requested 18,000-token shell budget. Preserve the
original protocol, execution and failed exposure audits. No original attempt
or delivery smoke attempt enters this study's pilot or final inference.

The product is unchanged. Both arms now receive the same explicit instruction
to set exec_command max_output_tokens to 18000 and enclosing functions.exec
max_output_tokens to 24000 using its first-line pragma for full initial reads.
Existing exposure requirements, graders, fixtures and cost/quality gates remain.
A separate live smoke pair repeats the consumed json-4 instance solely to verify
delivery; it is not confirmation evidence.

The schedule uses recorded seed 915202602 and 70 entirely fresh case hashes and
seeds, verified disjoint from every scheduled v1 instance. The unchanged pilot
has 29 pairs and residual SD 0.3249830860803345. The fixed sample, arm balance,
cost margin and bootstrap method remain unchanged.

At pair boundaries, STOP.json permits a documented operator stop only for the
original protocol's allowed reasons. Both arms receiving INVALID_READ now
automatically stops the study incomplete for measurement review. Single-arm
exposure failures remain recorded and continue; audited task failures continue.
No favorable or unfavorable cost result authorizes a stop or sample extension.
The freeze is created after delivery smoke and preflight and committed before
the first replacement confirmation call.
