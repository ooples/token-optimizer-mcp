# Frozen joint cost and speed confirmation — 2026-09-16

## Result

The fixed schedule completed all **120 pairs / 240 attempts** against installed
**HeadRoom 0.37.0**, using local **Codex 0.154.0** and **gpt-6-astra**.
Token Optimizer passed **119/120** attempts; HeadRoom passed **120/120**.
One local allocation failure has unknown provider usage. The complete-study
superiority gate failed. **Cheaper and faster on every task was not established.**

The strict joint classifications cover all scheduled pairs:

| Classification | Pairs |
| --- | ---: |
| Passing, strictly cheaper and faster | 77 |
| Cost loss, speed win | 20 |
| Speed loss, cost win | 12 |
| Cost and speed loss | 9 |
| Equal time, higher cost | 1 |
| Failed attempt / incomplete exposure | 1 |

The classification checks quality before missing metrics. Therefore the crash is
listed as a quality/exposure failure, while its **one unknown-cost attempt** is
also counted explicitly in the accounting and loss review. It is not a zero-cost
attempt or a discarded case.

Across the **119 fully measured pairs only**, descriptive totals were:

- Estimated token cost: **26.9% lower**, $22.257720 versus $30.431438.
- Input tokens: **35.9% lower**, 7,014,166 versus 10,950,930.
- Agent wall time: **30.1% lower**, 3,327.0 versus 4,759.6 seconds.
- Provider requests: **29.0% fewer**, 483 versus 680.
- Individual cost outcomes: **89 wins and 30 losses**.
- Individual speed outcomes: **97 wins, 21 losses, one tie**.

These complete-pair totals are descriptive, not a repaired full-study inference.
Over all 120 attempts, our known subtotal is $22.257720 **plus unknown usage**;
HeadRoom's total is $30.542456. No full-study percentage is calculated from those
unequally complete totals.

## Per-family results

Positive reductions favor Token Optimizer; a negative reduction means more cost
or time. Nullable totals use nine fully measured pairs. Joint-win counts always
use all ten planned pairs.

| Family | Measured pairs | Joint wins | Estimated cost reduction | Agent time reduction | Simultaneous criteria met |
| --- | ---: | ---: | ---: | ---: | --- |
| logs | 10/10 | 10/10 | 38.0% | 52.3% | yes |
| json | 10/10 | 2/10 | 32.6% | -5.6% | no |
| code | 10/10 | 8/10 | 30.0% | 47.5% | no |
| bugfix | 10/10 | 8/10 | 29.2% | 36.2% | no |
| refactor | 10/10 | 10/10 | 42.6% | 41.6% | yes |
| refresh | 10/10 | 3/10 | 11.6% | 6.9% | no |
| mixed | 10/10 | 8/10 | 31.8% | 40.3% | no |
| outer | 10/10 | 4/10 | 9.2% | 8.7% | no |
| tiny | 10/10 | 3/10 | 13.4% | 2.0% | no |
| entropy | 10/10 | 9/10 | 22.8% | 40.7% | no |
| numeric | 10/10 | 5/10 | 23.2% | 7.5% | no |
| nullable | 9/10 | 7/10 | 18.8% | 22.6% | no |

JSON agent time was **5.6% higher** despite lower estimated cost. Tiny-input and
refresh means do not imply that their individual cases won.

## Preregistered uncertainty

The protocol allocates alpha 0.05 across 12 families and three comparisons per
family (Bonferroni; one-sided alpha 0.0013889). Cost/time bounds use paired log
ratios; joint-win probability uses an exact binomial lower bound with every
scheduled case in the denominator. Ratios below 1 favor Token Optimizer.

| Family | Cost ratio upper bound | Agent-time ratio upper bound | Joint-win probability lower bound |
| --- | ---: | ---: | ---: |
| logs | 0.875 | 0.779 | 51.8% |
| json | 1.257 | 1.217 | 0.6% |
| code | 1.277 | 0.641 | 29.4% |
| bugfix | 1.071 | 0.792 | 29.4% |
| refactor | 0.918 | 0.763 | 51.8% |
| refresh | 1.608 | 1.244 | 2.4% |
| mixed | 1.135 | 0.891 | 29.4% |
| outer | 1.533 | 1.161 | 5.4% |
| tiny | 1.752 | 1.287 | 2.4% |
| entropy | 1.208 | 0.802 | 39.1% |
| numeric | 1.317 | 1.108 | 9.6% |
| nullable | unknown | 1.122 | 21.6% |

Only **logs and refactoring** met all family criteria: complete passing data,
both upper ratios below 1, and joint-win probability lower bound above 0.5.
Even ten wins out of ten yield a simultaneous lower bound of only **51.8%** here;
this is not evidence for a 95% probability of winning every future task.
Inference assumes independent pairs and approximately normal paired log ratios.
Shared provider state can violate independence. The suite contains generated
held-out fixtures, not an independently sampled population of production tasks.

## Every loss investigated

[loss-review.json](loss-review.json) archives all **43 non-winning pairs**, their
commands, failed tool outputs, request counts, usage, and timing. The original
[joint audit](joint-audit.json) retains every scheduled case.

- **30 cost losses**, including the equal-time pair: **20 used fewer input tokens**,
  but the cache-discount component outweighed their input/output savings. This is
  arithmetic attribution, not proof of why the provider granted a cache hit.
- **Six tiny-input cost losses** had slightly higher input. All ten tiny cases
  started with 83 more input tokens on our side. Installed HeadRoom compacts tool
  descriptions; this is consistent with the difference but was not isolated as
  its sole cause. The opaque tiny payload itself is preserved. Under the
  all-input-uncached sensitivity, tiny costs are **0.6% higher** overall.
- The other **four higher-input cost losses** are refresh-7, refresh-3, refresh-1,
  and outer-5. Each made one more request. Refresh-7, refresh-3, and outer-5 show
  failed model-generated PowerShell/Node quoting; refresh-1 splits verification
  and writing into additional calls. These are observed actions, not proof that
  compression caused the choice. Their successful recovery still costs tokens.
- **All 21 passing speed losses** have higher recorded upstream time. Our summed
  transform time is at most **27.7 ms** in those cases. Upstream includes network,
  provider queue/prefill/generation, and HeadRoom processing on its arm; the
  capture cannot separate those causes. The HeadRoom recorder's transform timer
  does not measure HeadRoom's internal processing and is not a local-proxy speed
  comparison.
- Replaying every cost-loss capture passed **1,124 historical-item stability
  checks** and preserved each client cache key. This does not prove provider
  cache hits; it rules out those measured replay mutations. See
  [cost-loss replay](cost-loss-replay/loss-audit.json).

The first-request-uncached and all-input-uncached sensitivities give **19.2%** and
**35.6%** lower cost on the 119 measured pairs. They hold model behavior fixed and
are not experiments that flush provider cache. Numeric's first-request-uncached
sensitivity is **0.9% higher** despite its observed cost reduction.

## Retained allocation failure and implemented audit fix

The nullable-9 proxy attempt exited with code 3221226505 before a tool read.
Codex reported an allocation failure for 904,704 bytes. The Node proxy also
reported a native allocation failure while its JavaScript heap was approximately
12 MB. Its initial 63,212-byte request had no compressible tool output and was
forwarded unchanged. No completed response usage was recorded, so its charge is
unknown.

A subsequent host sample showed 87% committed memory, 31,604,203,520 bytes against
a 36,126,572,544-byte limit. That later sample is consistent with host pressure;
it does not establish the peak or root cause. No large accumulating benchmark
process was observed. Neither the crash nor later successful attempts were
retried into this sample. [Diagnostic logs](diagnostics/nullable-9/allocation-failure.json)
retain the observations.

The frozen auditor originally labelled this INVALID_READ and counted no
infrastructure error because no JSON client error event was emitted. **After the
study finished**, the auditor was fixed to classify native stderr allocation
failures as CLIENT_ERROR and populate clientErrors. The runner's existing
three-consecutive-infrastructure-failure stop now recognizes those failures.
A focused regression uses the actual crash text; an integration check ran the
updated auditor on a copy of the campaign and preserved the original evidence.
See [post-run validator check](diagnostics/nullable-9/post-run-validator-check.json).
The original study classifications and analysis files remain unchanged.

## Frozen execution and implemented product changes

- Product source commit: **74f20dd34a63ae536a945922f238a6fefd78eb95**.
- Plan and freeze committed in **0e4021563f4086c6c0228777dc52514735a59f6d** before
  confirmation calls. Ten fresh seeds per family; five orders each; randomized
  schedule seed 3206388120. No product tuning, winner stopping, or selective retry.
- Started 2026-09-16T12:37:15.561Z; finished 2026-09-16T15:24:32.792Z.
- All **823 frozen artifacts** matched after execution, before the post-run
  validator fix. [Final verification](final-freeze-verification.json) records it.
  The later validator change does not change the measured product build.
- Preserved explicit nulls and distinguished null from absent fields; retained
  exact numeric extrema and complete numeric tables when the exact encoding is
  suitable; reused unchanged object branches and skipped impossible line-number
  parsing; added request transform/upstream timing.
- Initial development losses, implemented fixes, four-pair numeric follow-up,
  local latency/concurrency evidence, and allocation profile are all retained in
  [the development record](../joint-development-2026-09-16/README.md).
- The final local proxy comparison covered **3,840 requests / 48 groups** against
  the actual shipped HeadRoom proxy: lower mean latency in every group, **32
  byte-size wins and 16 ties**, with no cache-key or historical-output changes.
  These are local transport results, not live cost or quality conclusions.
- An internal before/after V8 profile measured **5.35% fewer sampled allocated
  bytes** with equivalent outputs. It is not a competitor allocation comparison.

## Cost and scope

Costs use the recorded Codex Enterprise standard scenario: $10/$1/$50 per million
uncached-input/cached-input/output tokens. The scenario and source are in
[plan.json](plan.json). These are estimated token costs, not invoices,
subscription charges, credits, or proxy-compute costs. Client settings, model,
installed competitor, scripts, and product are pinned by [freeze.json](freeze.json).

The proxy remains part of the product. This work implements and tests the
adversarial plan; it does not establish every-task superiority or unrestricted
production readiness. The failed complete-study gate and losing families remain
visible rather than being converted into a release claim.
