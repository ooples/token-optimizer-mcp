# Multi-agent token waste, measured (issue #533)

Produced by `bench/field/multi-agent-waste.mjs` (ranking) and
`bench/field/compaction-replay.mjs` (before/after) over this machine's Claude
Code transcripts: 4 main sessions and 25 subagent transcripts, 480 MB, 30,933
requests, frozen at `--until 2026-10-28T14:00:00Z`. Only pattern names, counts
and sizes appear here; no paths, commands or content.

- **tokens**: chars/4, what entered context.
- **resident**: tokens x requests that followed in the same transcript, up to
  the next client compaction. Each later request re-reads it (as cache reads).
- **already compacted**: share of results carrying our `[token-optimizer:` marker.

## Ranked: whole corpus (2026-10-06 .. 2026-10-28)

| # | pattern | n | tokens | % tokens | resident (tok x later requests) | % resident | max single (tok) | tokens in results >= 6 KB | already compacted (n) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | shell:other | 10,444 | 3,042,600 | 23.7% | 937,653,549 | 26.9% | 7,160 | 23.3% | 0.1% |
| 2 | read:shell | 3,662 | 2,588,987 | 20.2% | 785,087,029 | 22.5% | 7,459 | 39.2% | 0.2% |
| 3 | search | 4,252 | 1,466,790 | 11.4% | 435,961,976 | 12.5% | 5,889 | 15.7% | 0.0% |
| 4 | read:file | 1,010 | 1,170,264 | 9.1% | 299,273,538 | 8.6% | 14,084 | 60.4% | 0.0% |
| 5 | inject:claude-md | 109 | 1,441,703 | 11.2% | 132,675,777 | 3.8% | 18,641 | 100.0% | 0.0% |
| 6 | git:diff-log | 643 | 407,982 | 3.2% | 126,143,235 | 3.6% | 5,296 | 42.3% | 0.0% |
| 7 | build-test:log | 2,926 | 421,985 | 3.3% | 120,307,235 | 3.5% | 3,650 | 10.8% | 0.0% |
| 8 | inject:skill-listing | 79 | 330,201 | 2.6% | 76,053,126 | 2.2% | 7,222 | 98.4% | 0.0% |
| 9 | inject:token-optimizer:repeat | 3,120 | 244,333 | 1.9% | 68,711,603 | 2.0% | 1,446 | 0.0% | 0.0% |
| 10 | inject:token-optimizer | 954 | 159,208 | 1.2% | 58,066,958 | 1.7% | 1,471 | 0.0% | 0.0% |
| 11 | gh:api | 625 | 161,842 | 1.3% | 47,669,364 | 1.4% | 7,320 | 22.6% | 0.2% |
| 12 | shell:other:error | 742 | 143,335 | 1.1% | 41,332,323 | 1.2% | 2,662 | 13.5% | 0.0% |
| 13 | build-test:log:error | 686 | 151,613 | 1.2% | 39,962,856 | 1.1% | 2,510 | 7.9% | 0.0% |
| 14 | ci:status | 598 | 94,234 | 0.7% | 33,844,253 | 1.0% | 3,654 | 10.9% | 0.0% |
| 15 | edit | 2,676 | 115,007 | 0.9% | 31,393,846 | 0.9% | 99 | 0.0% | 0.0% |
| 16 | inject:other-hook:repeat | 1,814 | 90,033 | 0.7% | 27,413,290 | 0.8% | 1,038 | 0.0% | 0.0% |
| 17 | agent:report | 574 | 90,219 | 0.7% | 25,081,225 | 0.7% | 2,797 | 16.5% | 0.0% |
| 18 | gh:issue-pr-body | 183 | 84,372 | 0.7% | 22,306,440 | 0.6% | 4,597 | 23.6% | 0.5% |
| 19 | ci:log | 128 | 62,128 | 0.5% | 22,226,409 | 0.6% | 3,793 | 26.4% | 0.0% |
| 20 | tool:ScheduleWakeup | 632 | 36,870 | 0.3% | 21,508,418 | 0.6% | 93 | 0.0% | 0.0% |

## Ranked: the 2026-10-28 multi-agent session (main + 8 subagents)

| # | pattern | n | tokens | % tokens | resident (tok x later requests) | % resident | max single (tok) | tokens in results >= 6 KB | already compacted (n) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | read:file | 126 | 208,935 | 14.3% | 54,415,237 | 21.1% | 11,059 | 71.5% | 0.0% |
| 2 | shell:other | 716 | 228,636 | 15.6% | 43,913,558 | 17.0% | 4,025 | 28.8% | 1.0% |
| 3 | read:shell | 351 | 286,137 | 19.6% | 42,367,330 | 16.4% | 6,045 | 48.6% | 2.3% |
| 4 | search | 427 | 159,507 | 10.9% | 34,255,866 | 13.3% | 5,533 | 15.6% | 0.5% |
| 5 | inject:claude-md | 16 | 232,729 | 15.9% | 16,386,448 | 6.4% | 18,641 | 100.0% | 0.0% |
| 6 | docs:write | 80 | 31,068 | 2.1% | 10,468,036 | 4.1% | 10,807 | 34.8% | 0.0% |
| 7 | git:diff-log | 55 | 35,989 | 2.5% | 9,931,197 | 3.9% | 2,757 | 45.1% | 0.0% |
| 8 | tool:Artifact | 4 | 12,602 | 0.9% | 7,234,926 | 2.8% | 4,067 | 96.8% | 0.0% |
| 9 | build-test:log | 160 | 33,948 | 2.3% | 6,587,266 | 2.6% | 3,650 | 15.3% | 0.0% |
| 10 | inject:skill-listing | 16 | 64,422 | 4.4% | 4,457,928 | 1.7% | 6,423 | 98.7% | 0.0% |

## What the data says about the issue's suspected wastes

| suspected | measured | verdict |
|---|---|---|
| Claude Docs reads of 50-74 KB, re-read after edits | 31 `docs:read` calls in the corpus, largest 1.7k tokens; 24 re-reads after an edit total 16k tokens | not confirmed: reads are small, not a top waste |
| `gh run view --log-failed` dumps | 128 calls, 62k tokens, largest 3.8k tokens (0.6% resident) | not confirmed: agents already filter before transfer |
| build/test logs re-read for one line | 2,926 + 686 (error) results, 574k tokens; 6 KB floor caught 17 | confirmed, mid-size: fixed below |
| the same issue/PR bodies read repeatedly | 218 repeats, 55k tokens (0.4% resident) | confirmed but small |
| identical results across agents of one session | 3 identical results (>1 KB) across agents in the whole corpus | not a waste here |

## Fixes and measured savings

I replayed every recorded Bash/PowerShell/Grep response (23,866 results,
8.66M tokens) through the compactor: base `c20a1bd9` against this branch's
head, on the same frozen corpus, both with the same `--artifacts` directory.
The compactor's notice includes the artifact path, so the directory has to be
the same on both sides. The default temp dir has a longer path than a short
`--artifacts` dir and adds about 9k tokens to either side.

| pattern | base: tokens after compactor | branch | saved | saved x mean residency |
|---|---:|---:|---:|---:|
| search | 1,362,470 | 1,294,653 | 67,817 | 20.1M |
| build-test:log | 390,496 | 349,359 | 41,137 | 11.8M |
| git:diff-log | 375,814 | 362,870 | 12,944 | 4.0M |
| shell:other | 2,821,446 | 2,811,557 | 9,889 | 3.0M |
| ci:log | 57,911 | 55,673 | 2,238 | 0.8M |
| gh:issue-pr-body | 126,027 | 124,335 | 1,692 | 0.4M |
| gh:api | 148,203 | 148,232 | -29 | 0.0M |
| read:shell | 2,417,899 | 2,433,926 | -16,027 | -4.9M |
| **total** | **7,789,896** | **7,670,235** | **119,661 (1.4% of all shell output)** | |

The residency column applies each pattern's mean residency as measured for
the previous version of this table. About 5k of the total comes from the
multi-line and pipeline fixes in item 4. Measured against the previous head
with the same directory, the total goes from 7,675,264 to 7,670,235.

1. **Shell searches grouped by file** (`isShellSearchCommand`). The 4,234 shell
   searches (1.50M tokens) never got the lossless `groupGrepByFile` that the Grep
   tool gets. Results changed went from 151 to 557.
2. **Read detection by the producing stage** (`isReadLikeCommand`). A pipeline
   was judged by its last stage, so `grep ... | head`, `git log | head` and
   `dotnet test | tail` were passed byte-exact up to 24 KB as if they were file
   reads. `git show <commit>`, which prints a diff, also counted as a file.
   The fix saves about 26k on searches, logs and diffs. The `read:shell`
   regression (-16.0k) is the other half of the same fix:
   `Get-Content f | Select-Object -First N` and `$x = Get-Content f` are reads,
   and they are now kept byte-exact instead of folded, because an Edit built from
   them needs the exact text.
3. **Build/test logs from 2 KB** (`isBuildOrTestCommand`, `BUILD_LOG_MIN_BYTES`).
   The budget is sized so that every verdict line and its two context lines
   survive selection. The full log stays one Read away. `85317f9e` judges each
   pipeline stage by the program it runs. The first version matched build words
   anywhere, so `grep make notes.txt` qualified.
4. **Multi-line commands and PowerShell pipelines.** Both detectors judged the
   last `;`/`&&` statement, but never split on newlines. So
   `cd C:\repo<newline>Get-Content A.cs`, which is the PowerShell tool's usual
   shape, was not a read, and its file text was folded. Newlines now separate
   statements, and a line ending in `|`, a backtick or a backslash continues
   onto the next. `| more` and `Select-Object -Index (10..20)` are now range
   stages. Search grouping now applies when any stage searches:
   `git ls-files | xargs grep -n X`, or PowerShell's
   `Get-ChildItem -Recurse | Select-String X`.

**False positives in the first build-log version.** I compared both
`isBuildOrTestCommand` versions result by result on the 2-6 KB band:

- At `99ec7c51`, the build branch compacted 145 results and saved 42,020 tokens.
- 16 of those results (3,088 tokens, **7.3% of that saving**) were not build
  runs. They were `cd ...; <script>` statements and `$out = ...` / `python -`
  heredocs that only mentioned a build word.
- At `85317f9e`, the same 129 genuine results save the same 38,932 tokens, plus
  1 new genuine match that saves nothing. There are no false positives.

**Correction to the figure first published in this PR.** The -6.1k build-log
saving (and the 79,136 total) was wrong. That replay ran at the same time as my
mutation checks. It loaded `output-compact.mjs` while the mutation that disables
the 2 KB build branch was on disk, so it measured the build branch switched off.
The table above comes from a clean run with no concurrent edits. The per-result
comparison above gives about 42k for the first version, in line with it.

## The 6 KB+ outputs that reached the model uncompacted

The replay finds 37 outputs of 6 KB or more in session `25a884d9` that the 7.7.1
compactor shrinks but that reached the model whole. All 37 come from a plugin
version that had no compactor. Neither the plugin's compaction path nor Claude
Code is at fault:

- All 37 are PowerShell calls in the main transcript, between
  2026-10-22T17:39Z and 2026-10-26T14:27Z.
- The hook did fire for every one of them. Each call has a `tool-outcome` record
  with its `toolCallId` in `~/.token-optimizer/unrooted/.token-optimizer/wiki/metrics.jsonl`.
  It is recorded as `toolName: "Bash"` because the adapter normalises
  PowerShell to Bash. Compaction receives the same normalised name, and later
  PowerShell results were compacted.
- `output-compact.mjs` first shipped in v7.7.0 (2026-10-26T00:58Z). The plugin
  cache holds `7.5.0`, `7.5.1` and `7.7.1`. Neither 7.5.x copy contains
  `output-compact.mjs`.
- The `7.7.1` cache directory was created at 2026-10-26T14:52Z, after the last of
  the 37. The session's next SessionStart came at 2026-10-26T15:24Z, and its
  first compacted result at 15:56Z. Hook commands resolve `${CLAUDE_PLUGIN_ROOT}`
  for the plugin version a session loaded, so a running session keeps the old
  hooks until it restarts.
- After 15:24Z, there is no eligible output in the session that the running
  version (7.7.1) would compact and did not.

## Not fixed here, and why

- `shell:other` (#1) is a long tail of 10,444 small results (77% of its tokens in results
  under 6 KB, spread over many command shapes); no one rule addresses it.
- `inject:claude-md` (1.44M tokens, 18.6k per agent start) is the user's own
  CLAUDE.md, delivered by the client to every subagent; not ours to shrink.
- `inject:token-optimizer:repeat` (244k) is almost entirely before 7.7.1; since
  its install (2026-10-26T14:13) our injections total 9.0k tokens with 0.6k repeated.
- `read:file` is the Read tool, which Claude Code pages and dedupes itself.
