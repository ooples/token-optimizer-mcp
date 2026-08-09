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
- Real MCP `tools/list` size measured with `tiktoken`: 1,162 tokens for the
  four-operation cognitive profile, 4,815 for core, and 30,593 for the full
  102-tool catalog. Cognitive mode reduces static schema context 75.9% versus
  core and 96.2% versus full for all 16 registered adapters.

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

Each direction uses a blinded empty control, an active-model semantic producer,
and a fresh transcript-free consumer. The runner executes a deterministic
fail-then-correct fixture, signs its observations outside the model process,
requires the producer to verify the receipt before authoring cognition, and
grades the event stream plus the final answer. Raw transcripts, secrets, and
hidden recovery codes are never published.

Committed passing edges cover Codex→Claude Code, Claude Code→Codex, and
Codex→Copilot. Controls abstained in 3/3, runtime consumers succeeded in 3/3,
and no consumer repeated the verified failed action. This is executable smoke,
not a powered effectiveness estimate. The standalone Gemini authentication
failure, Copilot Gemini model rejection, Claude provenance refusal before the
verification operation existed, and Copilot quota exhaustion remain preserved
as negative evidence.

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
