# UCR evidence

UCR evidence is claim-tiered. Transport, conformance, executable smoke,
effectiveness, superiority, and production are separate classes; a lower tier
never authorizes a higher-tier claim. `results/evidence-index-v2.json` is the
signed, redacted index consumed by the dashboard and release gate.

## Reproduce the current evidence

```sh
npm run build
npm run eval:ucr:scale
npm run eval:ucr:coordination
npm run eval:ucr:consolidation
npm run eval:ucr:adapters
npm run eval:ucr:compounding
npm run eval:ucr:context
npm run eval:ucr:production
npm run evidence:ucr:assemble
npm run evidence:ucr:update
npm run verify:ucr
```

Current integrity-checked results:

- 29/29 deterministic runtime checks and independent Python protocol replay.
- 1,000,000 canonical events projected in 22.48 seconds at 44,475 events/s.
- 100 physical SQLite/WAL writers with zero lost accepted events and 100%
  duplicate-intent suppression.
- 16/16 registered adapters certified in 16 distinct child processes with
  identical lifecycle semantics across four adapter families.
- 100 consolidation sessions with zero source mutations and 88/88 delayed
  reuse cases retained.
- 100 linked compounding tasks, 700 policy arms, a verified 700-row ledger,
  and 1,000 executable reference-baseline cases. These are deterministic
  policy fixtures, not model invocations or product comparisons.
- Six of six local fault classes contained with zero event loss. This is a
  mechanism exercise, not production traffic.
- Real MCP `tools/list` size measured with `tiktoken`: 71 tokens for receipt
  attestation alone, 1,235 for four cognitive operations plus attestation,
  4,815 for core, and 30,666 for the full 103-tool catalog. The stateful live
  consumers use host pre-action delivery and expose zero MCP tools.

## Live multi-model handoffs

Preview availability without spending provider quota:

```sh
npm run eval:ucr:multimodel:plan
```

Run the paid all-direction matrix only with authorization:

```sh
npm run build
npm run eval:ucr:multimodel
```

Each direction uses a stateful control, a real predecessor CLI that performs a
generated-file mistake and correction, active-model semantic harvesting after
external authentication, and a fresh transcript-free consumer working in a
separate repository fixture. The end-state grader checks the canonical source,
regenerated output, protected verifier hashes, and the fail-then-pass audit; it
does not trust the model's final text.

The stateful primary edges Codex→Claude Code and Claude Code→Codex pass with
mandatory delivery, zero consumer MCP tools, and zero repeated predecessor
mistakes. In the stricter matched rerun, Codex→Claude reduced total traffic
11.56% while latency increased 10.87%; Claude→Codex reduced traffic 0.58% and
latency 0.53%. Both controls were correct, so these rows establish executable
handoff and accounting—not a correctness or mistake-prevention effect.
That direction-level loss is not averaged away. The live harness now gives both
arms byte-identical predecessor prompts and the same native guard transport so
semantic-authoring and plugin startup are not treatment-only confounders; new
live evidence must be collected before the directional result can change. The
Copilot edge is retained as negative evidence because its consumer invocation
returned HTTP 402 after the account quota was exhausted. These are executable
smokes, not powered effectiveness estimates.

A later two-direction pilot deliberately repeated the OpenAI↔Anthropic study:
Codex→Claude passed and Claude→Codex did not deliver the correction, so the
pilot passed 1/2. Its signed four-row ledger is included as an integrity-valid
negative artifact. This variance is why the successful edges are not promoted
to an effectiveness claim.

The legacy powered handoff executor remains a direction-specific qualification
tool. It cannot establish all-family effectiveness. The replacement-grade study
is preregistered separately:

```sh
npm run eval:ucr:full-study:powered-plan
npm run verify:ucr:study-design
```

The full plan covers all 11 families, seven arms, three independent model
families, and nine same/cross-client directions. It requires 363 paired
empty/runtime observations and 1,056 hard-negative opportunities per direction
and arm: 54,054 trial envelopes and 113,022 provider calls. Concurrent-agent
trials use one producer plus two overlapping successors instead of being labels.
Hard-negative and subgroup intervals control family-wise error across the
preregistered direction/arm comparisons.
The hard-negative count powers the confidence bound, not merely a zero-error
point estimate. Incomplete or smaller runs are sealed as `executable-smoke`.
See [`FULL_STUDY_CONTRACT.md`](./FULL_STUDY_CONTRACT.md) for the CLI driver,
competitive, production, causal, privacy, and promotion contracts.

## Release boundary

The release verdict intentionally remains `insufficient`. Powered natural-task
effectiveness, fair external product comparisons, and staged production traffic
are not present, so the project does not claim statistical efficiency,
superiority over memory/RAG products, or production readiness. Missing usage is
published as `null`; deterministic fixture labels are never represented as live
model runs.

CI now proves that every release metric has an executable study source. That is
design coverage, not measured effectiveness, and does not change the signed
`insufficient` verdict.
