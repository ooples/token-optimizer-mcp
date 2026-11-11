# Claude Sonnet 5 command-recovery cohort — August 9, 2026

This is the first live cohort produced while developing the four-arm evidence
system in PR #301. It records the result even though the result is mixed and
does not establish that the full system is more token-efficient.

## Protocol

- Client: Claude Code `2.1.225`.
- Observed model: `claude-sonnet-5` (`sonnet` runner alias).
- Task: `command-recovery` from `evals/task-suite.json`.
- Runs: five matched repetitions, 20 fresh sessions total.
- Order: Latin rotation; every arm occupied every order position in the first
  four repetitions. The fifth repetition supplied the configured minimum fifth
  pair.
- Baseline: `--setting-sources project`, strict empty MCP configuration, no
  plugin. An isolation smoke confirmed zero loaded plugins and zero MCP servers.
- Treated arms: the same setting source plus an explicit `--plugin-dir` for this
  checkout and a strict, uniquely named MCP configuration pointing to this
  checkout's built server. A smoke confirmed the local plugin and MCP server,
  and recorded a 24-token finding delivery.
- Transcripts: excluded. The artifact retained response hashes, session IDs,
  usage, grades, arm, pair, and order.
- Redacted JSONL SHA-256:
  `CAC6EEA6A2C4B1818B0B6D7EF166B1363C067EB78A5DAF34A75EE964117B50CF`.

The run used the measurement, comparison, Claude usage parsing, PowerShell
matching, and experiment-gating changes later committed in `1b09101`. The run
preceded the final artifact-provenance and aggregate-trace preservation edits
in that commit, so its raw rows report a dirty working tree and the previous
HEAD. No grading or effect calculation was changed after the run.

## Arm means

| Arm | Correct | Total tokens mean (95% bootstrap interval) | Tool calls | Latency | Cost | Finding tokens |
| --- | :---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 5/5 | 58,885 (58,537–59,214) | 4.8 | 16.390 s | $0.272727 | 0 |
| Optimizer | 5/5 | 59,898 (59,301–60,467) | 4.2 | 19.172 s | $0.269654 | 0 |
| Retrieval | 5/5 | 59,731 (59,367–60,308) | 3.4 | 17.839 s | $0.251858 | 24 |
| Full | 5/5 | 59,554 (59,114–60,235) | 3.2 | 16.798 s | $0.250657 | 24 |

Each arm's correctness Wilson interval is 56.6%–100% at `n=5`. That wide
interval is one reason this minimum-sufficiency cohort is not called a powered
study.

## Matched effects

Positive values mean the treatment improved the metric. Intervals are the
dashboard's deterministic paired percentile-bootstrap 95% intervals.

| Comparison | Tokens saved | Tool calls avoided | Latency saved | Cost saved | Correctness delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| Optimizer vs baseline | -1,012 (-1,627 to -517) | 0.6 (-1.2 to 1.8) | -2.782 s (-5.631 to -0.739) | $0.003073 (-$0.023449 to $0.029596) | 0 |
| Retrieval vs optimizer | 167 (-761 to 1,166) | 0.8 (-2.0 to 4.2) | 1.334 s (-1.994 to 4.789) | $0.017795 (-$0.020217 to $0.057976) | 0 |
| Full vs retrieval | 177 (-14 to 424) | 0.2 (0.0 to 0.6) | 1.041 s (-0.613 to 2.322) | $0.001201 (-$0.012692 to $0.016090) | 0 |
| Full vs baseline | -668 (-1,205 to -230) | 1.6 (-0.2 to 3.2) | -0.408 s (-4.226 to 4.487) | $0.022070 ($0.000935 to $0.039046) | 0 |

Interpretation:

- All 20 sessions were correct, so this task produced no evidence of a
  correctness improvement or regression.
- Retrieval delivered the seeded finding in all five retrieval and all five
  full runs. It did not deliver findings in baseline or optimizer.
- Retrieval's incremental token, tool-call, latency, and cost intervals crossed
  zero. The cohort does not establish a retrieval benefit.
- The full system used 668 more tokens than baseline on average, and that token
  interval did not cross zero. It nevertheless cost about $0.022 less because
  Claude's cached-token pricing differs from raw token count.
- The direction for tool calls favored full, but its interval crossed zero.
- This is one task, one client version, one model, and five pairs. It meets the
  dashboard's minimum display threshold; it is not a cross-task, cross-client,
  or statistically powered conclusion.

## Redacted run ledger

| Pair | Order | Arm | Correct | Total tokens | Tool calls | Failed | Latency ms | Cost USD | Injected | Session | Stdout SHA-256 |
|---:|---:|---|:---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 1 | baseline | yes | 58952 | 5 | 1 | 15057 | 0.269255 | 0 | ec6a248e-afe1-4963-86f5-9b6493e8fdb9 | f6819e8929367767eec2f490435f07592233624219c966f440f258074d7f2ed8 |
| 1 | 2 | optimizer | yes | 60981 | 8 | 1 | 23292 | 0.309967 | 0 | 6d18e3b6-b52e-46cb-b689-6c09a5d6a4ec | 0945dc1f59c5a3b49971e89b5aa2a7aed463b5db4f7481fc77b47a6ca2bd8733 |
| 1 | 3 | retrieval | yes | 59449 | 2 | 1 | 18503 | 0.233175 | 24 | 3ac45a98-b9a8-4d85-b87b-97c2b2c674e0 | d8b16154f97bf14ba6df9c861e9dc8276644b5966460194056e285029e12a1bf |
| 1 | 4 | full | yes | 59246 | 2 | 1 | 15796 | 0.232961 | 24 | b1ccc65e-9640-41f7-92e9-0b62edaef1b4 | 28f6449ab2919ad0210d336ab65a5153340d1f4270e56621df1602ff16e97aa9 |
| 2 | 1 | optimizer | yes | 59112 | 2 | 1 | 14042 | 0.232497 | 0 | a41812f5-3e87-4fb3-b47c-777518946068 | c2fda5854bbe7d16be3093bdeb93cb07c538801740898f24ae9695d40843f7bb |
| 2 | 2 | retrieval | yes | 59642 | 3 | 1 | 16429 | 0.254194 | 24 | 704513d0-9a34-43db-b0b5-4474478bc5df | 5888d609bd108c149b75d2b4d093db7c9520dcf2ff344e843ebda027e79e31af |
| 2 | 3 | full | yes | 58979 | 2 | 1 | 14399 | 0.227507 | 24 | 7b09cd0e-bda1-4fc0-b9df-11fb4308db15 | e4073529f49ea34af234b7e4fef863ef47956c7cb362cbb9ed6ac71ba1d93c5f |
| 2 | 4 | baseline | yes | 58326 | 4 | 1 | 13588 | 0.262676 | 0 | d078bb07-0b38-4bbb-8ca6-219465d1500d | 4671818768715dc43accd63e0146db54d42ad150bb5cd54a4c7062cecf7badb5 |
| 3 | 1 | retrieval | yes | 59222 | 2 | 1 | 15418 | 0.232830 | 24 | f3f6e5ba-419d-43ba-aabe-b2372d612004 | 55aca41f14af201797082627ad8415dbbe6e0bb45fa064fe9855f8459bd5a5e4 |
| 3 | 2 | full | yes | 59295 | 2 | 1 | 13335 | 0.231842 | 24 | 702cbed4-1f1e-4faa-b5c2-6dc9b1871764 | 749529fa32add888fa9ed50cb9a99a51dacc5b77f17129813778a6ed50fb776b |
| 3 | 3 | baseline | yes | 59341 | 6 | 0 | 21354 | 0.275579 | 0 | 433926fa-6151-4bec-aef4-d064e04e6bc3 | 2f890dcf95ca9c22ef4a5961f7204532e757e3c612879417bbd3da99dbf2184f |
| 3 | 4 | optimizer | yes | 60395 | 5 | 1 | 21862 | 0.299266 | 0 | 38a64d09-fc21-417f-a3a8-d7f008cef50d | 8c7a103230faf939c7bda590d6a46a2cda18482bca82b453ffcd851d8019f06c |
| 4 | 1 | full | yes | 59386 | 3 | 1 | 15996 | 0.252178 | 24 | eb453f6f-76a3-446d-a0ab-26e9d4048ccc | db5e7cbed486d459c2f214c91c0b2db38a78e23d9b8ba9dd1ad8cb1da650d34c |
| 4 | 2 | baseline | yes | 58590 | 4 | 1 | 13991 | 0.266553 | 0 | a1e8bd2b-9b24-4764-9e3f-41fecdf0634a | b38517d60d524ceb4af9e0a18a325c084b4e5ff272715570271ec544dab45431 |
| 4 | 3 | optimizer | yes | 59585 | 3 | 1 | 16988 | 0.255003 | 0 | 28a1bd29-d29f-4277-bbaf-189e6a64466a | 37f200dae00c5b7e9e536fbe179690009cc8a126fbf73a3b43d4acae492043df |
| 4 | 4 | retrieval | yes | 59525 | 3 | 1 | 16148 | 0.251578 | 24 | e9a53f35-9b96-46d2-88c9-944b857d325e | 3d2647d0e449bbd0b2686da41991cc25215c18f3b6b714cd2c47e6fc0202a010 |
| 5 | 1 | baseline | yes | 59217 | 5 | 1 | 17960 | 0.289571 | 0 | cf5708a2-d934-4124-bc85-c37024d256bc | 207533a66f5f2bda2033baa626993e8578f1707196fab26f9ee73635082972d7 |
| 5 | 2 | optimizer | yes | 59415 | 3 | 1 | 19677 | 0.251536 | 0 | 5709afd3-9043-4bee-b7ce-c26f74019847 | 37d85165e2ea26f88a6c8634bc69b0d31bd316a1f9f437e93bafa2ccbadfc6aa |
| 5 | 3 | retrieval | yes | 60817 | 7 | 1 | 22695 | 0.287513 | 24 | cad14682-5b04-411b-ae52-ddc80fb3ec78 | 78c1005c52dd6a17fdde55a77c28d0183678965eeef057532c8ad5934e9c7ff6 |
| 5 | 4 | full | yes | 60862 | 7 | 1 | 24462 | 0.308797 | 24 | 9f0a3096-e4bd-4c7f-9ea3-3c0daa616806 | 6560605eda62d7f2d88b9e0731452d9687809e12cd7ef64563cc388c8ea8b9ce |
