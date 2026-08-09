# Live evidence suite

`task-suite.json` is the pre-registered cross-client task set. It covers command
recovery, repeated reads, noisy search, cross-session recall, cross-project
transfer, staleness, harmful-findings quarantine, active-model harvesting, a
no-benefit control, and long-session/compaction behavior.

Copy `runners.example.json` outside the repository and replace every model,
version, and baseline-isolation placeholder with the exact local CLI values.
Do not weaken the baseline: it must load no Token Optimizer MCP server, hooks,
plugin, rules, or user instructions.

First inspect the counterbalanced schedule without launching a model:

```bash
npm run eval:evidence:plan
```

Then run one client/model cohort:

```bash
node scripts/run-evidence-eval.mjs \
  --runner C:/private/token-optimizer-runners.json \
  --client codex \
  --model gpt-5.6-sol \
  --repetitions 8
```

Each arm receives a fresh fixture copy, graph, and hook-state directory. The
aggregate result is a schema-v2 `eval-run` record. Use `--include-transcript`
only when raw model output is appropriate to retain locally.

Published, redacted live cohorts:

- [Claude Code 2.1.225 / Claude Sonnet 5 / command recovery / five pairs](results/2026-08-09-claude-sonnet-5-command-recovery.md)

## Cross-client mistake transfer

`handoff-suite.json` tests a stricter chain: one live producer must encounter a
dead end, capture the durable lesson itself, and a fresh consumer must receive
that exact finding before its first tool call. Empty, natural, oracle,
irrelevant, and stale graph arms all use the full integration and identical
post-producer workspace snapshots.

Inspect the pre-registered cyclic order without launching a model:

```bash
npm run eval:handoff:plan
```

Run a direction with explicit, locally isolated runner profiles:

```bash
node scripts/run-handoff-eval.mjs \
  --runner C:/private/token-optimizer-runners.json \
  --producer codex \
  --consumer claude-code \
  --producer-model gpt-5.6-sol \
  --consumer-model claude-sonnet-5 \
  --repetitions 5
```

The schema-v3 artifact stores hashes and behavioral outcomes by default, not
transcripts. A missing or semantically wrong natural harvest remains a failed
natural arm and is never replaced with an oracle finding.
