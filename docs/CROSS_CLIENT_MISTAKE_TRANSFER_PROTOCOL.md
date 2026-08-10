# Cross-client mistake-transfer protocol

Status: pre-registered implementation plan  
Base commit: `59656c2c64399165157ad2ba6564fef5a0991798`  
Primary live matrix: Codex `gpt-5.6-sol` and Claude Code `claude-sonnet-5`

## Question

Can one active coding model encounter a mistake, correct it, record the durable
lesson through `wiki_write`, and cause a fresh agent in another CLI to avoid the
same preventable mistake while completing related work?

The existing evidence does not answer this question. A seeded finding proves
delivery, and a single-client A/B run can estimate retrieval overhead, but
neither proves natural semantic capture or behavioral transfer between agents.

## Claims kept separate

1. **Graph integrity:** concurrent and sequential writers do not corrupt or lose
   findings.
2. **Natural capture:** the producer records the target lesson without a seeded
   finding or detached semantic model.
3. **Cross-client delivery:** the consumer receives that exact finding with
   producer/client/model provenance.
4. **Preventive timing:** delivery occurs before execution of the preventable
   action, not merely after its failure.
5. **Behavioral transfer:** the consumer avoids the producer's mistake and still
   completes the task correctly.
6. **Efficiency:** any behavioral gain is worth its token, call, latency, and
   monetary cost.

No lower-numbered claim is evidence for a higher-numbered claim. Deterministic
fixtures may establish integrity and grading, but only live model runs count as
behavioral evidence.

## Experimental unit

One matched pair begins with exactly one fresh producer run. After the producer
finishes, the harness freezes:

- the post-producer workspace;
- the natural graph and its hash;
- a redacted producer ledger;
- the producer client/model/session identity; and
- hidden grader state recording the mistake, recovery, and final result.

The harness then clones the same post-producer workspace for every consumer
arm. Producer transcripts, CLI session files, memory files, debug logs, and raw
responses are removed before cloning. The graph is the only producer-derived
artifact that differs between consumer arms.

A producer that fails to make, correct, or harvest the target lesson remains in
the dataset as an end-to-end capture failure. It is never silently excluded.

## Consumer arms

| Arm | Integration | Graph contents | Purpose |
| --- | --- | --- | --- |
| `empty` | full local hooks/MCP | empty | isolates ordinary client behavior with equal optimizer overhead |
| `natural` | full local hooks/MCP | producer's active-model graph | measures the complete product |
| `oracle` | full local hooks/MCP | only a pre-registered ideal finding | estimates the upper bound of perfect harvesting |
| `irrelevant` | full local hooks/MCP | applicable-looking but unrelated finding | measures retrieval precision and distraction |
| `stale` | full local hooks/MCP | invalidated target finding | measures stale-evidence harm avoidance |

An optional `no-system` arm may estimate total plugin/MCP overhead, but it is not
the primary graph-transfer contrast. The primary causal comparison is
`natural` versus `empty` because both load the same integration.

Consumer order uses a generalized cyclic Latin rotation. Every arm occupies
every order position before the rotation repeats. Each consumer is a fresh CLI
process with a fresh session and hook-state directory.

## Scenarios

### Verification entry point

The producer is required to try a tempting unsupported verification script,
observe the failure, recover through the package-level command, and complete a
small change. The consumer receives a related subsystem whose tempting script
has the same failure mode.

Hidden audit files distinguish an attempted command from an executed command
and from a successful supported verification. Final prose alone cannot pass.

### Generated source of truth

The producer first changes a generated client copy, observes the synchronization
failure, then corrects the source module and regenerates the clients. The
consumer must make an analogous change for another generated client.

The hidden grader checks which file was changed, whether generated outputs are
in sync, and whether the behavioral test passes.

### False-positive validation

The producer runs a plausible validation from the wrong scope, observes that it
did not exercise the target, and corrects it with the scoped command. The
consumer must validate a sibling target where the same false-positive trap is
present.

The hidden grader requires the target sentinel to be exercised. A zero exit
code from the wrong command is recorded as a preventable mistake, not success.

### Negative and stale controls

Irrelevant guidance must not be delivered or followed. Guidance whose anchor or
invalidator changed after capture must be withheld, marked stale, or explicitly
re-verified before use.

## Natural-finding contract

The producer finding must be `origin: agent` and include:

- a concrete claim describing the corrected failure;
- a real anchor;
- observed evidence;
- applicability;
- `verified`, `probable`, or `speculative` confidence;
- project/organization/global scope; and
- at least one invalidator.

The target-finding grader uses pre-registered semantic anchors and observable
behavior. It does not require one exact sentence. A weak, unrelated, or missing
finding is recorded as a capture failure even if another finding exists.

## Pre-registered outcomes

### Primary

- `attemptedPreventableMistake`: the consumer selected the known bad action.
- `executedPreventableMistake`: the bad action actually ran.
- `mistakeRecurrenceRate`: consumers with the executed mistake divided by all
  included consumers in the arm.
- `correct`: hidden behavioral grader passes and the runner completes.
- `firstPassSuccess`: the first relevant validation exercises the target and
  succeeds.

Attempted and executed mistakes are separate because a preventive hook may
correctly block an action after the model selects it but before execution.

### Transfer chain

- `captureSuccess` and semantic-contract completeness;
- producer client/model/session and finding IDs;
- `findingDelivered`, delivery surface, and delivery order relative to the first
  relevant tool call;
- `findingAdheredTo`: the next relevant behavior follows the finding;
- exact/fallback causal join coverage; and
- graph and redacted-artifact hashes.

### Efficiency and harm

- uncached, cache-creation, cached, output, and total tokens;
- tool calls, failed tool calls, latency, and cost;
- injected tokens and time-to-correct completion;
- irrelevant/stale delivery rate;
- new errors attributable to transferred guidance; and
- harmful feedback/quarantine events.

Positive efficiency deltas always mean the treatment improved the metric.
Correctness and mistake prevention take precedence over token savings.

## Isolation and exclusions

Both runner profiles must declare exact baseline isolation and exact local
treatment configuration. The harness verifies loaded client, version, model,
plugin, MCP server, graph directory, and session identity before accepting a
cohort.

Allowed exclusions are limited to:

- authentication or provider outage before model work begins;
- runner/fixture failure before model work begins; and
- machine termination that leaves no gradable artifact.

Timeouts, missing findings, incorrect work, malformed findings, repeated
mistakes, and missing token usage remain recorded. Missing values stay `null`
and are never converted to zero.

No `AGENTS.md`, `CLAUDE.md`, auto-memory, transcript, prior CLI session, or git
commit message may carry the producer lesson into a consumer arm. All arms
receive the same code and git state. Raw transcripts are excluded by default;
published ledgers retain identities, grades, whitelisted tool classes, and
cryptographic hashes.

## Live matrix

The first effectiveness claim requires both directions:

1. Codex / `gpt-5.6-sol` producer to Claude Code / `claude-sonnet-5` consumer.
2. Claude Code / `claude-sonnet-5` producer to Codex / `gpt-5.6-sol` consumer.

Same-client fresh-agent cohorts (Codex to Codex and Claude to Claude) separate
cross-session behavior from CLI interoperability. A mixed concurrent cohort
runs two producers against one graph and a third fresh consumer after both
finish.

Packaged lifecycle simulations still cover every supported client, but they are
reported as wiring certification rather than live behavioral proof.

## Claim gates

Five matched pairs per direction are the minimum dashboard display threshold.
Ten matched pairs per direction are required before making an effectiveness
claim for a scenario.

For a positive cross-client mistake-transfer claim:

- target natural capture succeeds in at least 80% of producer runs;
- the natural arm reduces executed mistake recurrence by at least 50% versus
  empty graph;
- the paired 95% interval for recurrence improvement excludes zero;
- natural-arm correctness is not more than 10 percentage points below empty;
- delivery is observed before execution in at least 80% of successful captures;
- the irrelevant and stale controls introduce no correctness regression; and
- the complete redacted ledger, including failures, is published.

The concurrent cohort additionally requires a parseable graph, zero lost
accepted writes, unique producer provenance, and successful retrieval of every
applicable finding in all repetitions.

If a gate fails, the result is published as mixed, harmful, or not established.
Zero observed mistakes in a finite cohort is evidence for that cohort, never a
guarantee that an agent will make no future mistakes.

## Required implementation and evidence

- [ ] Generic sequential producer/consumer runner.
- [ ] Reproducible hidden-grader fixtures for all three mistake families.
- [ ] Natural, empty, oracle, irrelevant, and stale graph arms.
- [ ] Pre-action delivery available consistently across lifecycle clients.
- [ ] Cross-client episode/finding/delivery/outcome provenance.
- [ ] Concurrent live-writer and later-reader runner.
- [ ] Transfer and recurrence aggregation in the evidence API/dashboard.
- [ ] Deterministic protocol, isolation, security, and UI tests.
- [ ] Live bidirectional, same-client, negative-control, and concurrent cohorts.
- [ ] Redacted result reports and an honest PR evidence summary.
