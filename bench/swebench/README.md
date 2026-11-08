# bench/swebench: does token-optimizer cut cost on real issues without losing fixes?

TokenEconomizer reported its savings on SWE-bench traces. This harness puts the
same question to this product, on SWE-bench Verified, with the comparison built
so that a win cannot come from anything except the plugin.

## Method

- **Same instances, both arms.** A seeded sample, stratified by repository so
  django (46% of Verified) cannot be the whole result. Every instance runs once
  per arm per repetition.
- **Order fixed before anything runs.** An instance's two arms run back to back,
  with a seeded coin deciding which goes first, so neither arm systematically
  gets the warmer provider cache or the quieter hour.
- **Both arms start warm.** Before a batch, each arm runs one unscored session
  (logged to `warmup.jsonl`; `--no-warm` skips it). Control's cross-session
  prompt prefix is the stock `claude -p` one, which other traffic keeps warm;
  the plugin arm's exists only here. In pilot 4 that cold start alone was 9,556
  of the plugin arm's 17,156 extra cache-write tokens over ten pairs: a cost of
  the batch order, not of the product, since a user's own sessions keep their
  prefix warm too.
- **Isolation, verified by probe.** Each run gets a fresh worktree at the
  instance's `base_commit` and a throwaway `CLAUDE_CONFIG_DIR`, so the host's
  plugins, memory, settings and MCP servers load in neither arm. The parent
  shell's `ANTHROPIC_BASE_URL` (the product's own proxy, on the machine this
  was built on), every `TOKEN_OPTIMIZER_*` and every `CLAUDE_CODE_*` variable
  are removed. claude.ai connectors are switched off in both arms: probed
  before this was added, they loaded 46 tool definitions into the plugin arm
  only. The binary under test is the real `claude` executable, never a
  launcher shim (the first `claude` on that machine's PATH was this product's
  managed `claude.cmd`).
- **The plugin arm runs this checkout.** The plugin is staged with its MCP
  server pointed at this checkout's `dist/server/index.js`, not the published
  `@latest` that `plugin/launch.mjs` would fetch. Each plugin-arm run writes an
  MCP debug log, and the report warns about any run in which the server never
  connected.
- **Scored by the official evaluator.** Predictions are written in SWE-bench's
  own format and graded by `swebench.harness.run_evaluation`. Test-file hunks
  are dropped from each patch, since SWE-bench applies its own tests.
- **Compared per instance.** Cost is reported as the geometric-mean paired
  ratio (plugin / control) with a bootstrap 95% interval, in API-equivalent
  dollars and in cache-aware units. Resolution uses an exact McNemar test on
  the discordant instances. The report also gives dollars per resolved
  instance.

## Run it

```bash
npm run build                                   # the plugin arm runs this build
node bench/swebench/run.mjs fetch               # 500 Verified instances, free
node bench/swebench/run.mjs plan --n 50 --seed 7 --model sonnet --budget-usd 3
node bench/swebench/run.mjs run --dry-run       # prints every run, spends nothing
node bench/swebench/run.mjs run --confirm-spend [--limit 10]
node bench/swebench/run.mjs evaluate            # prints the official evaluator commands (needs Docker + `pip install swebench`)
node bench/swebench/run.mjs report --eval control=<report.json> --eval token-optimizer=<report.json>
```

`run` refuses to spend without `--confirm-spend` and prints the worst case
first: number of runs times `--budget-usd`, which each run passes to
`--max-budget-usd`. It is resumable, because a run already recorded for this
plan is skipped. With `ANTHROPIC_API_KEY` set the runs are API-billed.
Otherwise the host's subscription login is copied into each run's throwaway
config, only the `claudeAiOauth` entry, and deleted after the run.

## Caveats

- **The agent runs on the host** with `bypassPermissions`, in a clone of a
  well-known open-source repository. It can run that repository's code. The
  repositories' Python environments are not installed, so the agent cannot
  always run the tests. That is the same for both arms, but it makes absolute
  resolution rates lower than published leaderboard numbers. Compare the two
  arms, not the arms against a leaderboard.
- **Repetitions.** One repetition detects only large effects. For anything
  published, use `--reps 3` and report the interval, not the point estimate.
