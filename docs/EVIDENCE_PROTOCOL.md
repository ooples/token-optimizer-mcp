# Causal evidence protocol

Token Optimizer does not use “smarter” as an unqualified score. The evidence
system tests four separate claims:

1. Client wiring captures the lifecycle events its protocol exposes.
2. Retrieval selects relevant, current, non-harmful findings.
3. A treated task improves without reducing correctness.
4. A finding remains useful across sessions or projects.

## Four arms

| Arm | Routing/optimization | Graph retrieval | Semantic harvest |
| --- | --- | --- | --- |
| `baseline` | no | no | no |
| `optimizer` | yes | no | no |
| `retrieval` | yes | yes | no |
| `full` | yes | yes | active model |

`TOKEN_OPTIMIZER_EXPERIMENT_ARM` gates both native hooks and the MCP tool
catalog. A real baseline must additionally start the CLI without the user's
installed hooks, MCP servers, rules, or plugins. The evaluation runner refuses
a runner profile that does not document and supply baseline-isolation flags.

Runs are paired by task and repetition, use fresh graph/state directories, and
rotate arm order. Only paired `eval-run` records can produce causal effect
intervals. Deterministic configuration verification is never counted as causal
model evidence.

## Episode schema

Every causal record uses schema version 2 and carries the identifiers available
on its client surface:

```text
episodeId, sessionId, turnId, toolCallId, injectionId
client, clientVersion, model, modelVersion
taskId, pairId, arm
findingIds, shadowFindingIds
deliveredTokens, shadowTokens
success, correct, latencyMs, costUsd
uncachedInputTokens, cachedInputTokens, outputTokens, totalTokens
```

An exact tool-call-id join is preferred. Clients that omit it use an explicitly
labelled episode/anchor fallback. The dashboard reports causal join coverage so
missing linkage cannot silently become “savings.”

## Metrics and sufficiency

Correctness is primary. Token, tool-call, latency, and cost changes are
secondary and are never considered a win when the task grader regresses.

- Scalar effects use deterministic percentile-bootstrap 95% intervals.
- Correctness rates use Wilson 95% intervals.
- Missing usage values remain `null`; they are never converted to zero.
- The default causal gate requires five paired runs in a cohort. Production
  studies should first estimate variance and then pre-register a powered sample
  size with `TOKEN_OPTIMIZER_EVAL_MIN_PAIRS`.
- Cohorts are separated by client, client version, model, model version, and
  task. Results from unlike surfaces are never pooled into one headline.

## Retrieval economics and safety

Before delivery, each finding is scored from relevance, confidence, provenance,
recency, observed outcomes, feedback, context cost, and stale/speculative risk.
It is injected only when expected benefit exceeds delivery cost and risk.

The default one-minute episode cooldown backs up the persisted once-per-session
gate. Two harmful ratings quarantine a finding from automatic retrieval. A
quarantined finding remains in the append-only graph and dashboard audit trail;
it is not silently deleted.

Holdouts record the candidate finding IDs and shadow token cost without
delivering them. This makes treatment/control selection observable while
preserving the control condition.

## Semantic finding contract

Active-model `wiki_write` calls require:

- `claim`: compact, durable conclusion;
- `anchors`: real files or symbols;
- `evidence`: the concrete observation that established it;
- `applicability`: when a later model should use it;
- `confidenceLabel`: `verified`, `probable`, or `speculative`;
- `scope`: `project`, `organization`, or `global`;
- `invalidators`: changes or assumptions that require re-validation.

Exact normalized duplicates collapse to one active finding. Project scope is
the default; cross-project reuse must be chosen deliberately. Anchor changes
still drive the existing staleness mechanism.

## Reproduction

```bash
npm run eval:evidence:plan
node scripts/certify-clients.mjs --json
node scripts/run-evidence-eval.mjs \
  --runner path/to/local-runners.json \
  --client codex \
  --model exact-model-id \
  --repetitions 8
```

The runner writes a redacted JSONL artifact by default: prompt, stdout, and
stderr hashes are retained, but transcripts are included only with the explicit
`--include-transcript` option. Raw records are also appended to the aggregate
graph's evidence log for `/api/wiki/evidence` and the dashboard.
