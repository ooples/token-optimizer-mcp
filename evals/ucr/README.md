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
mistakes. In the latest source-complete runs, Codex→Claude increased total token
traffic 22.0% and latency 109.6%; Claude→Codex increased traffic 56.9% and
latency 91.9%. An earlier Claude→Codex attempt had improved both metrics, so the
directional reversal is explicit variance evidence, not a result to average
away. The efficiency gate is currently 0/2. The Copilot edge is retained as
negative evidence because its consumer invocation returned HTTP 402 after the
account quota was exhausted. These are executable smokes, not powered
effectiveness estimates.

A later two-direction pilot deliberately repeated the OpenAI↔Anthropic study:
Codex→Claude passed and Claude→Codex did not deliver the correction, so the
pilot passed 1/2. Its signed four-row ledger is included as an integrity-valid
negative artifact. This variance is why the successful edges are not promoted
to an effectiveness claim.

The powered handoff executor is preregistered separately:

```sh
npm run eval:ucr:effectiveness:plan
npm run eval:ucr:effectiveness
```

The frozen power analysis requires 357 pairs per arm in both directions, or
2,142 model invocations. Incomplete runs and smaller pilots are cryptographically
sealed as `executable-smoke`; the runner promotes a ledger to `effectiveness`
only after every preregistered pair completes.

## Release boundary

The release verdict intentionally remains `insufficient`. Powered natural-task
effectiveness, fair external product comparisons, and staged production traffic
are not present, so the project does not claim statistical efficiency,
superiority over memory/RAG products, or production readiness. Missing usage is
published as `null`; deterministic fixture labels are never represented as live
model runs.
