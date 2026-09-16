# Completed schedule; superiority gate not met

All 70 pairs / 140 attempts ran in the committed order on the frozen product.
Proxy passed 70/70. HeadRoom passed 69/70; refactor-5 received an upstream HTTP
503 before a model response, with no usable cost ledger. This is an infrastructure
failure, not demonstrated task incompetence. It was retained without replacement.

**The preregistered complete-ledger gate failed. No confirmatory superiority
claim or primary confidence interval is reported.** analysis.json correctly
reports superiorityEstablished=false. Its 69-pair pass counts concern the
fully measured subset; execution.json records all 140 attempts, including the
passing proxy counterpart of the unmeasured HeadRoom attempt.

## Descriptive results only

The following excludes the entire refactor-5 pair and describes 69 fully
measured pairs. It is not the preregistered complete-sample inference.
Positive percentages mean less usage/cost/time for proxy; negative means worse.
Overall totals use the observed subset (nine refactors, ten of each other family),
rather than claiming the prespecified equal-family confirmatory estimand.

| Family | Pairs | Estimated cost reduction | Input reduction | Agent time reduction |
| --- | ---: | ---: | ---: | ---: |
| overall | 69 | 25.7% | 38.9% | 30.0% |
| logs | 10 | 37.4% | 50.3% | 47.7% |
| json | 10 | -35.1% | -37.7% | -84.5% |
| code | 10 | 20.9% | 43.5% | 39.9% |
| bugfix | 10 | 32.5% | 51.5% | 39.6% |
| refactor | 9 | 48.1% | 64.3% | 39.7% |
| refresh | 10 | 7.9% | 0.7% | 19.3% |
| mixed | 10 | 33.6% | 47.1% | 29.5% |

The 69 measured pairs used 37.0% fewer requests overall. JSON lost estimated
cost by 35.1%, input by 37.7%, and agent time by 84.5%; every JSON pair was
slower for proxy. This is the next development target, not a hidden exception.

Costs use the frozen Codex Enterprise standard rate scenario, not actual invoices.
Provider cache state was observed, not flushed. These are generated synthetic
instances, not evidence of superiority on every workload or cache regime.
Raw captures remain at the execution.json raw path. freeze-at-completion.json
records verification before any subsequent product change.

The runner labeled the 503 as FAIL rather than PROVIDER_ERROR. The frozen
analyzer still rejected its missing ledger. Future infrastructure-stop detection
must also recognize transport failures; no retries or relabeling altered this sample.
