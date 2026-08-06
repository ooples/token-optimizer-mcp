# Why the CLAUDE.md comparison could not be completed, and what that revealed

The comparison was: one rule, three deliveries — absent, CLAUDE.md, graph finding.
Measure whether the agent passes `--runInBand`. The rule is genuinely absent from
the repository (checked), so it cannot be re-derived.

Result: **no arm complied.** Control, CLAUDE.md and graph all reported `FLAGS: NONE`.
Three separate delivery defects explain it, and each is worth more than the
comparison was.

## 1. A CLAUDE.md in the directory you point an agent at is never loaded

Verified by asking directly. The agent's context contained
`C:\Users\yolan\CLAUDE.md` and `MEMORY.md`, and **no** CLAUDE.md from the
directory it was told to work in.

CLAUDE.md is loaded from the session's own project, not from wherever an agent
happens to be working. For subagent work in another checkout, it is not a
knowledge-delivery mechanism at all. That is the gap the graph is meant to fill —
findings are keyed by the ANCHOR's project, resolved per file.

## 2. A finding with a `trigger` is invisible on the touch path

`qualifies()` matches a finding's trigger against the context. On a file touch the
context is the path, so a trigger like `jest|npm (run )?test` never matches
`package.json` and the finding is skipped.

On the command path it does match — but a command injection arrives attached to
the tool call it fires on, **after** the agent has composed the command. It can
only influence the next one.

So the most actionable findings — commands — are the hardest to deliver in time:
too late on the command path, invisible on the touch path unless the trigger
happens to match a file path.

## 3. A refused read suppresses that file's findings entirely

`forTouch` is called on the ALLOWED branch only. A refused call returns before
reaching it.

That is fine for the large-file refusal, which consults the graph itself and says
"Nothing learned about this file yet". It is not fine for the "UNCHANGED since you
last read it" refusal, which carries no findings at all.

## The compounding failure

Those three combine into the observed result:

    bug #269 falsely marks package.json as already-read (cross-agent state)
      -> the read is refused
        -> forTouch never runs
          -> the finding anchored to package.json is never delivered

**#269 does not merely waste tokens. It disables the knowledge graph's delivery for
subagents**, which is the workload where the graph is worth the most. Both agents
in the arm-C runs reported being told they had "already read" files they were
opening for the first time.

## Consequence for the measurement

Arm C cannot be measured honestly until #269 ships. Any number taken now measures
a delivery path that is broken for reasons unrelated to whether the knowledge is
useful.

The v8-spread arm-C result (-18.6%) stands, because that injection arrived on a
Bash call rather than through a refused read — but it is one data point that got
lucky with routing, not evidence the path is reliable.
