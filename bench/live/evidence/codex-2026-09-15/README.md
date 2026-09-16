# Local Codex comparison, 2026-09-15

Codex CLI 0.154.0, model `gpt-6-astra`, Node 22.15.0, and installed HeadRoom
0.37.0 ran on Windows using existing ChatGPT authentication. The proxy used
the HTTP Responses API and kept tool definitions and reasoning items intact.

Three tasks × three arms × three repetitions produced **27/27 correct answers**.
Every run's initial tool output contained the full fixture without truncation.
Every input, cached-input, and output total matched between the provider ledger
and Codex's final usage event. Token Optimizer compressed output in every task.

## Results

Mean input tokens, including cached input and subsequent retrieval turns:

| Task | Control | Token Optimizer | HeadRoom | Less input vs HeadRoom |
| --- | ---: | ---: | ---: | ---: |
| JSON outlier lookup | 60,955 | 39,318 | 44,043 | 10.7% |
| Code search | 49,186 | 44,427 | 82,697 | 46.3% |
| Log diagnosis | 51,295 | 39,203 | 84,308 | 53.5% |

All arms passed 3/3 repetitions of each task. Token Optimizer and control used
three requests per task. HeadRoom used three on JSON and five on code and logs,
including recovery reads. Lower input here therefore measures the whole task,
not just how much text a compression algorithm removes.

Mean uncached input was also lower for Token Optimizer than HeadRoom on all three
tasks. Mean output was slightly higher on JSON (156 vs 148 tokens), and lower on
code and logs. There is **no claim of winning every metric**. Full cached/uncached,
output, and elapsed-time figures are in [summary.json](summary.json).

## Evidence and audit

- [manifest.json](manifest.json): model, tasks, arm order, repetitions.
- [provenance.json](provenance.json): installed versions and hashes of executed code.
- [results.json](results.json): original recorded per-run results and usage.
- [validation.json](validation.json): independent final artifact validation.
- [summary.json](summary.json): aggregates and ledger consistency checks.
- [mcp-smoke.json](mcp-smoke.json): a separate live Codex session using the built
  MCP server for three reads and an edit. The default repeat returned a cache hit
  with `No changes`, shrinking its response from 4,619 to 509 characters. The
  final forced read and on-disk check both confirmed the edit.

The original runner flagged six HeadRoom runs because a later recovery read was
truncated. Their controlled **initial** reads were complete. The corrected
validator checks that initial input, retains subsequent recovery behavior as part
of the task outcome, and independently checks answers and unchanged source files.
`validation.json` preserves both recorded and audited verdicts. No run or usage
measurement was discarded or changed. The compression code and task inputs were
unchanged throughout this campaign; only the artifact validator was corrected.

The local raw request corpus is at
`C:/Users/yolan/AppData/Local/Temp/codex-ab-DwIZ4r/run-rK7M68`.
It contains client instructions and reasoning items and is not copied into the
repository. Re-running the report requires that local corpus or a new campaign.

## Scope

Arm rotation balances position; it does not isolate shared provider caches.
Each workload has only three observations, with no statistical significance claim.
The fixtures contain 220 log lines, 220 JSON rows, and 300 search hits. Larger
pilot fixtures exposed client-side truncation and are excluded from this campaign.

Input includes cached tokens, so these are not dollar-cost figures. Elapsed time
includes process startup and does not establish steady-state proxy latency.
HeadRoom's recorder byte counts are taken before HeadRoom transforms a request
and cannot be used as its compressed byte count. The results concern the specific
versions, model, transport, and tasks above.

The MCP smoke exposed an outer response cache that replayed cold reads and an
inner read snapshot that did not advance after edits. Both were fixed and checked
with a production stdio regression: read, repeat, external edit, diff, repeat.
These MCP fixes do not affect the proxy-only campaign above.

See [the runner instructions](../../README.md) to reproduce.
