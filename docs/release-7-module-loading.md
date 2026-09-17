# Load optional analysis implementations on demand

A Node CPU startup profile showed most sampled time in module format detection,
compilation, loading, and filesystem resolution. The default MCP server eagerly
imported six TypeScript compiler-backed implementations even though the default
core profile does not expose those tools.

Their schema objects now live in a dependency-free module, with byte-equivalent
JSON verified against the preceding commit. Existing implementation modules
re-export the same objects for compatibility. Typed async wrappers import each
implementation only when invoked; no tool is removed from any profile.

TokenCounter and TiktokenTokenizer now also load the tiktoken module on first
use. This avoids loading its WASM binary solely to import the classes. The
encoder and ownership behavior from the preceding fix is retained.

## Validation

Build and changed-file lint passed (existing warnings remain). Six targeted
suites passed 33 tests using the repository's ESM test configuration. A compiled
fresh-process regression checks that importing schemas and constructing an unused
counter load neither TypeScript nor tiktoken, then invokes counting and compiler
analysis to verify both deferred paths. Profile integration tests check discovery
and tool access. All six moved schemas match the baseline exactly.

[Local measurement receipt](release-7-module-loading-proof.json) retains all four
fresh-process samples before and after. The baseline is variable; sequential
batches do not establish a statistical or competitor win. RSS is resident-memory
growth, not cumulative allocation volume.

## Next live campaign, fixed before running

- Existing Codex account/model and the installed HeadRoom binary.
- Arms: full (core MCP plus proxy), headroom; alternating order by repetition.
- Tasks: logs, json, code; heldout-v1 fixtures; four repetitions per arm/task.
- Seed offset: 1900000701. Retain every attempt and failure; no winner selection.
- Independently validate artifacts and complete reads, then compare provider
  usage, the existing rate-card scenario, agent execution and total duration.
- Report each workload separately, including losses. This bounded synthetic
  campaign is not production-repository or universal-superiority proof.

The first campaign (`run-7Q1bSc`) stopped before logs repetition 2 on its memory
guard, after two passing attempts. Its samples and results remain intact.
Inspection found preflight could reuse a sample taken while the preceding arm
was still alive. Preflight now requires a sample after cleanup for every arm,
including when the preceding sample looked healthy. The same memory thresholds
apply; fresh low-memory readings still stop immediately.

The complete restart uses seed offset **1900000801**, with the same arms, tasks,
repetition count, and analysis criteria. The incomplete campaign is retained
separately and will not be pooled into a balanced result.
