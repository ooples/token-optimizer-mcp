# Incomplete measurement study

Stopped under the preregistered measurement-failure rule. Nine pairs completed;
the tenth (code-9) was interrupted and its partial raw artifacts are retained at
the path in execution.json. The original executable/harness freeze was verified
at stop, before subsequent harness repairs. No superiority is established.

Both json-4 agents requested 18,000 shell-output tokens, but omitted the enclosing
functions.exec output budget. The shell subprocess returned the full 38,633
characters; the first model-facing result nevertheless said `Warning: truncated
output (original token count: 11636)`. Both answers were correct, but both failed
the original full-exposure audit (INVALID_READ). Later reads cannot repair that
initial-exposure requirement. The problem affects the comparison's delivery
protocol, and is not evidence of either product's compression correctness.

All nine completed pairs, including these invalid exposures, remain archived.
analysis.json reports incomplete evidence and no confirmatory interval. A
replacement study must use fresh cases after a separate delivery smoke check.
Neither these attempts nor smoke attempts may enter its pilot or final sample.
The original PROTOCOL.md, plan.json and freeze.json remain unchanged.
