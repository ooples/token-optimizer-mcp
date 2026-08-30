# Spike: can a hook rewrite a tool result before it reaches context?

**Date:** 2026-08-30
**Client:** Claude Code 2.1.x (`~/.local/bin/claude.exe`, 217 MB native binary)
**Feeds:** the P0 decision in
`docs/superpowers/specs/2026-08-29-benchmark-harness-and-competitive-program-design.md`
and M4 in #357.

A spike: the output is an answer, not code. The probe built for it was deleted.

## The question, and why it decides M4

Debug loops are our worst task family (**1.248**) and tokenade's best (**0.611**).
The spec's P0 assumed tokenade's mechanism and proposed to copy it: compact
`Bash` output in a `PostToolUse` hook, at zero turn cost, instead of refusing the
command — because a refusal costs approximately **one extra turn**, and
enforcement's turn count (12.6 → 20.9) is the whole measured deficit.

That design has one load-bearing assumption: **that a hook can rewrite a tool
result.** Nobody had checked.

## Answer

| surface | can it rewrite? | evidence |
| --- | --- | --- |
| `PostToolUse` output | **No** | output schema is `{hookEventName, additionalContext?, classifierContext?}` — it can only *add* context |
| `PostToolUse` on a **failed** call | **No failure ever observed** | 0 failures in 4,499 live outcomes; every `exit` `null` |
| `PreToolUse` input | **Yes** | `updatedInput` in the schema, and verified end-to-end |

### PostToolUse cannot rewrite output

The `PostToolUse` result schema carries no field for replacing the tool result:

```text
hookEventName: "PostToolUse", additionalContext?, classifierContext?
```

`tool_response` appears only as an **input** to the hook. `updatedOutput`,
`modifiedOutput`, `toolResponse`, `updatedResult` and `replaceOutput` occur zero
times anywhere in the binary.

### PostToolUse was never observed to see a failure

Counted over live capture on the measuring machine:

```text
tool-outcome events: 4499
success flag ->  {True: 4499}
exit codes   ->  {None: 4499}
top tools    ->  {'Bash': 4059, 'Edit': 344, 'Write': 96}
```

4,059 Bash calls, including many deliberately failing builds, failing test runs
and sabotage experiments — **not one failure recorded, and no exit code ever
delivered.** This reproduces the 2,238/2,238 figure already recorded in
`hooks-core/transcript.mjs` and extends it to the current client.

**Stated as what it is: an observation, not a contract.** 0 failures in 4,499
outcomes on Claude Code 2.1.x is strong evidence that this client does not
deliver them, and it is enough to design against — but it is an absence of
observation, not a documented guarantee, and it is scoped to the version
measured. A release could start firing them, which is why the invalidation note
at the end asks for it to be re-checked.

**A debug loop is a sequence of failing test runs.** So even if `PostToolUse`
could rewrite output, on this client it would be blind to the family P0 exists
to fix.

**P0 as specified is not implementable.** Both halves fail independently.

### PreToolUse can rewrite the command, and it runs

The `PreToolUse` result schema does carry it:

```text
hookEventName: "PreToolUse", permissionDecision?, permissionDecisionReason?,
updatedInput?: Record<string, unknown>, additionalContext?
```

The binary also holds the runtime's own validation message — *"PreToolUse hook
for … returned `updatedInput` that failed schema validation"* — which proves the
field is read from a **PreToolUse** result and not only from a permission
handler.

Verified end-to-end rather than inferred from strings. A throwaway hook was
registered through `claude -p --settings <throwaway>` (never this session's
settings), rewriting one marker command:

```text
prompt:   run: echo PROBE_ORIGINAL
hook saw: "echo PROBE_ORIGINAL"
hook emitted: permissionDecision: allow  +  updatedInput.command = "echo PROBE_REWRITTEN"
model received: PROBE_REWRITTEN
```

The rewritten command executed. **No refusal, no retry, no extra turn.**

## Recommendation

**Replace refusal with rewriting on the `PreToolUse` side.** It attacks the
measured mechanism directly: the deficit is turns, a refusal spends one, and a
rewrite spends none. It also works regardless of exit code, because it happens
before the command runs — which is the only way to reach the failing runs that
make up a debug loop.

This likely also explains tokenade: a command rewritten to pipe through a
compactor looks, from outside, exactly like "compacting Bash output in a hook".

### One constraint the probe surfaced, which the design must respect

The probe's own model **noticed** that the output did not match the command it
asked for, and flagged it as suspicious:

> *"the output does not match the command … Something in this session's tooling
> chain either rewrote the command before execution or rewrote the result. I'm
> reporting what I actually received rather than the expected string."*

A silent rewrite costs trust and can provoke exactly the re-run we are trying to
avoid — which would spend the turn we just saved. Any rewrite must be
**self-evident**: the bound has to be visible in the output (a truncation
marker), and `permissionDecisionReason` / `additionalContext` should state what
was capped and how to get the rest. Compaction the agent cannot see is
compaction it will fight.

## What this does not establish

- Only `Bash` was probed live. `Read`, `Grep` and `WebFetch` accept
  `updatedInput` per the same schema, but were not exercised.
- Nothing here measures a token saving. It establishes that the mechanism is
  available; whether bounding output moves the debug-loop family is M4's job to
  measure.
- The `PostToolUse`-never-fires-on-failure finding is a client behaviour, not a
  contract. It should be re-checked when the client updates, and it is worth
  reporting upstream — `derive.mjs`'s two strongest detectors are starved by it.
