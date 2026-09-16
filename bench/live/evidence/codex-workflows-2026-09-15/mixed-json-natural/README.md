# Unrestricted follow-up: observed cost win, cache advantage disclosed

Same compiled build as mixed-json/, natural tool choices, refresh seeds 36–37,
two reversed arm positions. All four attempts passed independent artifact and
provider/client usage audits. There was no prescribed initial-read command.

| Mean per attempt | Our proxy | HeadRoom |
| --- | ---: | ---: |
| Input tokens | 81,152.5 | 91,372.5 |
| Uncached input | 5,952.5 | 15,916.5 |
| Output tokens | 650 | 557.5 |
| Requests | 6 | 6.5 |
| Agent seconds | 35.05 | 33.15 |
| Standard-rate cost scenario | $0.167225 | $0.262496 |

Observed estimated cost was 36.3% lower, input 11.2% lower, and requests 7.7%
lower. Agent time was 5.7% higher; the proxy lost input/request/speed comparisons
in the second pair. Both observed pair cost estimates favored the proxy.

**Cache warmth explains much of the cost margin.** Each proxy first request
reported 9,216 cached tokens; both HeadRoom first requests reported zero.
`first-cold-sensitivity.json` changes only that first-request charge to fully
uncached, holding all subsequent usage and model behavior fixed. Its means are
$0.250169 versus $0.262496: a 4.7% proxy advantage, with a loss in the second
pair. This is a counterfactual sensitivity calculation, not measured cold-start
billing, a normalized experiment, or a guarantee of provider cache behavior.

The first proxy agent naturally printed combined AGENTS.md and routes.json.
Replay of that actual captured output compressed 29,385 characters to 697 while
preserving the surrounding text and disabled route-109. The other proxy first
read was ordinary JSON. Thus the new path activated under natural tool choice,
but no old-build live arm isolates its causal effect on token or cost totals.

Keep this screen separate from the controlled mixed-read screen and from the
earlier 47.8% losing sample. Two repetitions are development evidence, not
statistical proof of a persistent cost advantage across workloads.
