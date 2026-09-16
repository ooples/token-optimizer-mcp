# Live client comparisons

`ab.sh` drives Claude Code and uses Anthropic usage classes. `codex.mjs` drives
the locally installed Codex CLI with its existing ChatGPT authentication and
the model selected in the user's configuration. A Claude usage limit does not
prevent running the Codex benchmark.

`local-proxy-performance.mjs` requires Windows: it samples process-tree CPU and
private memory through PowerShell/CIM. It rejects other hosts before starting
servers or sending warmup requests. This restriction applies to that benchmark,
not to the proxy itself.

Build first, then run:

```sh
npm run build
node bench/live/codex.mjs
node bench/live/report-codex.mjs /path/printed/by/the/runner
```

The default Codex campaign runs three repetitions of three synthetic tasks
(log diagnosis, JSON outlier lookup, and code search) through these arms:

- `control`: Token Optimizer's null proxy, recording unmodified requests.
- `proxy`: Token Optimizer's compression proxy.
- `headroom`: the installed `python -m headroom.cli proxy`, behind the same null
  recorder. Provider usage reflects HeadRoom's actual transformed requests.

Every arm occupies each position once. Set `ARMS`, `REPS`, and `TASKS` to narrow
a diagnostic run; repetitions must be a multiple of the arm count for a balanced
comparison. `CODEX_BIN`, `CODEX_BENCH_MODEL`, and `PYTHON` override executable or
model selection. `OUT` selects an evidence directory; every invocation creates a
new subdirectory and retains previous results.

## Natural workflow screening

In PowerShell, run the development screen with:

```powershell
$env:TASKS='bugfix,refactor,refresh'
$env:REPS='3'
node bench/live/codex.mjs
```

These tasks let Codex choose its searches and reads. `bugfix` repairs an HTTP
retry policy through a failing/passing test loop. `refactor` migrates a money API
across four modules while preserving its callers. `refresh` replaces a route
configuration and adds an override between reads; its changed route varies by
repetition. These are small synthetic repositories, not production-repository
or long-session evidence. Proxy-only arms do not exercise MCP read caches.

Workflow validation runs in fresh processes after Codex exits, with additional
checks defined outside the task directory. Protected requirements and tests
must remain unchanged. The evaluator checks boundary conditions beyond the
public tests; regression tests verify it rejects plausible incomplete fixes.
This is process separation and an instruction boundary, not an OS sandbox.
Natural workflows do not require a complete first read: selective reads and
client truncation are part of their measured behavior.

The screen is for finding losses and guiding designs. Three repetitions are
not a confirmation study. Retain every attempt, including failures. Freeze
fresh confirmation variants and the confirmation protocol before using those
results to claim a broader win. Report correctness, cached/uncached/input/output
tokens and execution latency separately. `agentSeconds` excludes proxy startup
and post-run validation; `seconds` includes both.

Optional arms `mcp` (MCP tools with the null recorder) and `full` (MCP plus
compression proxy) make tool overhead and tool selection measurable. Both enable
the local built MCP server and add explicit usage guidance. Report these as
product configurations, separately from the proxy-only comparison. The runner
records completed tool names so a cache result cannot be inferred from a run
that never used the cache. Use `ARMS` to select a comparison and choose a
repetition count divisible by its arm count for balanced screening.

`full-files` keeps proxy compression enabled and uses the opt-in `files` MCP
profile: `smart_read`, `smart_write`, `smart_edit`, `smart_glob`, `smart_grep`,
`get_cached`, and `expand`. Compare it with `full` to measure the effect of a
smaller advertised tool catalog. The default server profile remains `core`.
File-only runs do not measure wiki, audit, or session-management functionality.

## Rate-card cost scenarios

After auditing a campaign, run `node bench/live/codex-cost.mjs CAMPAIGN` to write
`cost-scenario.json`. It weights **uncached input = input minus cached input**,
cached input, and output separately and checks their ledger totals. Invalid,
missing, duplicate, or failed runs cannot produce campaign cost comparisons.

The bundled scenario uses the published Codex Enterprise standard rates for
GPT-6 Astra, verified on 2026-09-15: USD 10 / 1 / 50 per million uncached-input /
cached-input / output tokens. See the [official rate card](https://help.openai.com/en/articles/20001415).
It assumes standard speed and no regional or contract adjustments. These are
rate-card estimates, not measured account charges; subscription plans, credits,
discounts, and proxy compute costs are outside the calculation. Do not apply
this scenario to another model or treat it as an API cache-write pricing model.

New runs keep task files in `workspace/` and captures outside it, so ordinary
repository discovery does not return benchmark logs. `provenance.json` records
client/competitor versions and relevant source/build hashes at startup.
`PROXY_BIN` can point to a separately compiled candidate while the normal
`dist` build remains fixed for another campaign.

`SEED_OFFSET` shifts workflow seeds (default zero). Seeds 4 and above use varied
retry statuses/attempts instead of identical failures, and fractional-price
refactor tests. Refresh route positions also change. These support fresh-variant
checks after development; a single run per arm remains a diagnostic, not a
statistical confirmation. Archive the manifest and provenance with each result.

Refresh seeds 7 and above include a pre-existing disabled route. The agent must
identify it before replacement and distinguish it from the newly disabled route.
`READ_MODE=truncated` (refresh only) requests an initial shell read with a
2,000-token output budget, then allows free tool choice. The audit requires a
truncation marker in the captured first output. This is an explicit adversarial
exposure test, separate from natural workflow measurements.

`READ_MODE=mcp` is a separate refresh-only cache diagnostic for MCP-enabled
arms. It asks for `smart_read` before the external replacement and again after
`node refresh.mjs`. Both the runner and auditor require successful calls on the
actual route file on each side and a reported cached diff afterward. Missing
events, skipped calls, or a full reread cannot be reported as a cache pass.
This controlled diagnostic is not a natural tool-selection result.

The runner uses per-invocation Codex configuration, isolated task directories,
and loopback proxy ports. It does not edit the user's Codex configuration. It
records plaintext request bodies in the evidence directory, including the
client's instructions and reasoning items. These are local diagnostic artifacts;
publish the result and summary files rather than the raw captures.

## Validity checks

- Answers are parsed and checked independently, including UTF-8 BOM handling
  for files written by Windows PowerShell. Source fixtures must remain unchanged.
- The controlled initial tool output must contain the complete fixture.
  Client-side truncation of that input invalidates a sample, even if the model
  found the answer. Later recovery reads remain part of the task's outcome.
- Every run must have provider usage. Missing measurements and failures cannot
  become zero-cost wins.
- The report checks the proxy ledger against Codex's input, cached-input, and
  output totals. An incomplete campaign, failed answer, provider error, or
  disagreement makes the report exit unsuccessfully.
- The report independently rechecks captured initial reads, answer files, and
  unchanged fixtures, saving original and audited verdicts in `validation.json`.

## Interpretation

Codex input includes cached input. Cached tokens are a subset, not an additional
charge. Report them separately; do not apply the Anthropic formula from `ab.sh`.
The summary reports token counts rather than dollar costs. Elapsed time includes
proxy startup, and HeadRoom's null-recorder byte counts describe the traffic
entering HeadRoom, not its compressed output.

Rotation balances position but does not isolate shared provider caches. These
small tasks establish behavior on these fixtures, not superiority across all
workloads, compression quality, latency, or cost. Keep failed and preliminary
campaigns separate from confirmation results.
