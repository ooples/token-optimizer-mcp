# Universal Cognitive Runtime program

- Status: implementation foundation delivered; empirical release gates open
- Planning baseline: `master` at `59656c2`
- Empirical baseline: draft PR
  [#302](https://github.com/ooples/token-optimizer-mcp/pull/302) at `8023ac9`

## Executive decision

Token Optimizer will not be designed as another memory plugin or graph-RAG
implementation. The target is a **Universal Cognitive Runtime (UCR)**: a
model-independent external cognition layer that lets any conforming agent
inherit verified experience, active work, procedures, constraints, and failure
knowledge from any other agent while using less context and preserving or
improving correctness.

RAG, lexical search, vector search, graph traversal, temporal lookup, and
workflow retrieval become interchangeable kernels below the runtime. They are
implementation techniques, not the product abstraction.

The north-star claim is:

> A fresh agent can enter a new session, client, model, machine, or compatible
> project with no hidden transcript dependency; reconstruct the relevant state
> of work; inherit verified skills and failure guards; continue safely; and
> improve measurably as audited experience accumulates.

That claim is not considered proven by configuration checks, successful
retrieval, seeded findings, model prose, or lower token use alone. It requires
correctness-first, cross-model, cross-client, long-horizon causal evidence.

## Why this program exists

PR #302 demonstrated that accepted findings can survive process boundaries,
concurrent writers, and Codex/Claude handoffs. It also found the more important
negative result: successful capture and pre-action delivery did not establish
mistake prevention, and one three-finding natural consumer was less correct
than its empty-graph match.

That result changes the architecture. The runtime must learn **which verified
experience should affect which decision**, enforce known invariants through
safe executable guards, and assign outcome credit after use. Increasing the
quantity or semantic similarity of injected prose is not an acceptable answer.

## Non-negotiable design principles

1. **Correctness precedes savings.** A cheaper incorrect result is a loss.
2. **The active model owns semantic harvesting.** The capable model doing the
   work decides what it learned and authors the semantic record. Infrastructure
   validates, scopes, attributes, and measures it; a detached weak summarizer
   does not silently replace that judgment.
3. **Evidence is immutable.** Derived beliefs can be superseded or quarantined,
   but the observation and reasoning provenance that created them remains.
4. **Delivery may be empty.** Abstaining is better than injecting irrelevant,
   stale, contradictory, or harmful guidance.
5. **Known failures become guards, not just reminders.** When a verified lesson
   can be expressed safely as a validation or action constraint, the runtime
   should make recurrence mechanically harder across models.
6. **No hidden client claims.** A client is certified only for lifecycle events
   its actual protocol exposes. Rules-only clients are never presented as
   observing invisible built-in actions.
7. **One protocol, many adapters.** Client integrations translate events; they
   do not carry divergent cognition logic.
8. **Cross-project is deny-by-default.** Transfer requires compatible scope,
   policy, provenance, and applicability.
9. **Every automatic behavior has shadow mode, a kill switch, and an audit
   trail.**
10. **Claims remain falsifiable.** Null and harmful results stay in the evidence
    set, and gates are frozen before paid live runs.

## Runtime architecture

```text
client/model adapter
        |
        v
universal cognitive event log -------> immutable artifact/evidence store
        |                                      |
        v                                      v
typed temporal/causal graph <---- semantic compiler + validators
        |                                      |
        v                                      v
adaptive retrieval planner ----------> executable memory/guard runtime
        |                                      |
        v                                      v
context virtual machine -------------> agent action and environment outcome
        ^                                      |
        |                                      v
consolidation/forgetting <------------- causal credit + harm quarantine
```

The event log is authoritative. Graph indexes, retrieval indexes, summaries,
utility scores, and dashboards are rebuildable projections.

## Canonical cognition objects

The existing `file`, `symbol`, `task`, and `finding` graph is retained as a
compatible subset. UCR adds first-class objects for:

| Object       | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `event`      | immutable observation or action envelope                           |
| `artifact`   | content-addressed file, tool result, document, image, or trace     |
| `entity`     | project, repository, symbol, service, dependency, user, or concept |
| `episode`    | bounded attempt with task, actions, observations, and outcome      |
| `claim`      | semantic belief with confidence and evidence                       |
| `decision`   | chosen option and rejected alternatives                            |
| `failure`    | attempted action, symptom, cause, correction, and proof            |
| `procedure`  | reusable ordered or conditional workflow                           |
| `guard`      | executable or declarative constraint on a proposed action          |
| `goal`       | desired state, dependencies, owner, and completion evidence        |
| `hypothesis` | unresolved explanation and discriminating tests                    |
| `constraint` | policy, invariant, compatibility, or safety requirement            |
| `checkpoint` | resumable projection of active work, not a transcript summary      |
| `outcome`    | correctness, side effects, cost, latency, and grader evidence      |

All belief-like objects use bitemporal semantics: when the statement was valid
in the represented world and when the runtime learned or changed it. Updates
create `supersedes` or `contradicts` relationships; they do not rewrite history.

## Program workstreams

All 18 workstreams below are required. A workstream is complete only when its
deliverables and exit gates pass; landing code is not by itself completion.

### 1. Universal Cognitive Event Protocol

**Objective:** define the stable model/client-independent contract from which
all cognition, attribution, recovery, and coordination can be rebuilt.

Deliverables:

- Versioned event envelope with UUIDv7 event identity, trace identity, causal
  parents, writer sequence, hybrid logical time, wall time, idempotency key,
  client/model/agent identity, task/session/project/workspace scope, capability
  tier, sensitivity label, payload hash, and schema version.
- Canonical event vocabulary for task, goal, hypothesis, proposed action, tool
  call/result, observation, mistake, correction, verification, decision,
  finding, checkpoint, handoff, feedback, and outcome events.
- Content-addressed payload references so raw artifacts need not be copied into
  the event log or model context.
- Forward-compatible schema negotiation and explicit unknown-event handling.
- Ordering, replay, duplication, partial-write, and clock-skew semantics.
- Open JSON Schema and language-neutral conformance fixtures.

Exit gates:

- Two independent adapter implementations replay the same fixture to an
  identical canonical event stream.
- Duplicate and out-of-order delivery produces the same projection.
- Unknown optional fields survive round trips; unknown required semantics fail
  closed with a diagnostic.
- A redacted stream can reproduce every published metric without transcripts.

Dependencies: none. This is the root of the program dependency graph.

### 2. Typed temporal and causal cognitive graph

**Objective:** evolve the append-only wiki graph into a rebuildable world,
experience, procedure, and belief model rather than a collection of prose
findings.

Deliverables:

- Typed nodes listed in `Canonical cognition objects` and typed relationships
  including `derived_from`, `verified_by`, `applies_to`, `invalidated_by`,
  `requires`, `blocks`, `causes`, `claimed_causes`, `used_in`, `supersedes`,
  `contradicts`, `owns`, and `generalized_from`.
- Bitemporal validity, confidence distributions, compatibility predicates,
  provenance paths, and materialized active-belief views.
- Immutable event-log source plus transactional projections for graph,
  temporal, lexical, and optional vector indexes.
- Schema migrations, deterministic rebuild, integrity repair, and export.
- Explicit distinction between observation, model-authored interpretation, and
  causally established conclusion.

Exit gates:

- A projection rebuilt from the event log is byte-equivalent after canonical
  ordering.
- Contradictory and superseding claims remain queryable with their valid-time
  intervals and provenance.
- One million synthetic events rebuild within a pre-registered time/memory
  budget without losing accepted writes.
- Current wiki data migrates without silently broadening project scope.

Dependencies: workstream 1.

### 3. Model-native semantic compiler

**Objective:** let the active frontier model convert verified experience into
minimal, durable cognition objects without outsourcing judgment to a detached
harvester.

Deliverables:

- A two-phase `propose -> verify -> activate` write protocol.
- Required semantic fields: trigger, attempted action, observed failure, root
  cause, correction, verification evidence, applicability, non-applicability,
  invalidators, scope, confidence, and expected outcome.
- Structured compilers for claims, failures, decisions, procedures, goals,
  hypotheses, and guards.
- Evidence-receipt validation: a `verified` object must reference a successful
  observation or deterministic grader event.
- Active-model completion reflection with loop protection for lifecycle clients
  and explicit-write policy for rules-only clients.
- Optional peer challenge by another capable model. Peer output can attach a
  critique or test but cannot silently rewrite the producer's record.
- Semantic quality fixtures measuring over-generalization, missing negative
  applicability, unsupported causality, duplicate knowledge, and secret
  leakage.

Exit gates:

- Unsupported `verified` claims are rejected deterministically.
- At least 95% of accepted benchmark objects contain usable positive and
  negative applicability conditions.
- Cross-model reviewers can trace every compiled field to producer evidence.
- The runtime records harvest cost separately from consumer context cost.

Dependencies: workstreams 1 and 2.

### 4. Executable memory and action guards

**Objective:** convert verified lessons into safe behavior-changing artifacts
so another model need not remember or interpret prose perfectly.

Deliverables:

- Memory forms for contextual guidance, declarative guards, validators, tests,
  queries, workflows, and parameterized procedures.
- A capability-safe guard language with explicit trigger, allowed observation,
  proposed intervention, verification, timeout, and failure behavior.
- Enforcement modes `shadow`, `observe`, `advise`, `require-verification`, and
  `deny`, controlled by user/project policy.
- Tool-call interception for capable clients and advisory equivalents for
  clients without veto surfaces.
- Guard simulation against captured action traces before activation.
- Signed provenance and a rule that graph content cannot introduce arbitrary
  code execution without an independently granted capability.
- Mistake-immunity templates for generated sources, destructive commands,
  weak validation, wrong working directories, stale dependencies, and
  repository-specific invariants.

Exit gates:

- A verified guard prevents its target mistake across at least two model
  families without exposing the hidden task answer.
- Irrelevant guards activate in fewer than 1% of adversarial negative cases and
  never execute an ungranted capability.
- Every enforced intervention names its evidence, scope, replacement action,
  and rollback path.
- Guard failure cannot block emergency disable or corrupt the underlying task.

Dependencies: workstreams 1 through 3.

### 5. Causal credit and harm quarantine

**Objective:** learn which memory changed behavior and whether the change
helped, rather than equating retrieval or model acknowledgement with value.

Deliverables:

- Exact joins among candidates, deliveries, guards, actions, outcomes, and
  deterministic graders using event/episode/tool/injection identities.
- Outcome priority: correctness, harmful side effects, executed recurrence,
  first-pass completion, tool work, latency, tokens, then cost.
- Shadow selection, controlled replay, matched live arms, and counterfactual
  metadata without contaminating controls.
- Per-object utility distributions conditioned on task, model, client, scope,
  recency, and delivery form.
- Automatic quarantine after one verified severe regression or a
  pre-registered accumulation of lesser harm evidence.
- Appeals, revalidation, and audit flow; quarantine never deletes provenance.
- A conservative policy learner that may allocate context only after minimum
  evidence and always retains an abstention action.

Exit gates:

- Synthetic causal fixtures detect deliberately confounded joins and refuse to
  publish an effect.
- Harmful-memory experiments quarantine the responsible object before the next
  automatic delivery.
- No token or cost improvement is labelled a win when correctness regresses.
- Utility estimates include sample size and uncertainty, never a bare score.

Dependencies: workstreams 1 through 4 and the benchmark schema from 14.

### 6. Context virtual machine

**Objective:** provide effectively unbounded external cognition through
decision-specific semantic paging rather than startup context accumulation.

Deliverables:

- Context tiers: dormant graph (`L0`), active-goal/checkpoint header (`L1`),
  decision guard (`L2`), evidence capsule (`L3`), and on-demand raw artifact
  (`L4`).
- A context capsule format carrying object IDs, concise payload, provenance,
  applicability, uncertainty, and expansion handles.
- Per-task and per-action budgets optimized for expected correctness gain per
  token, with a hard maximum and an explicit zero-result path.
- Page-fault events triggered by task, plan, file, symbol, tool, command, and
  validation decisions.
- Working-set retention across turns and invalidation when task state changes.
- Progressive expansion that never reruns an expensive source operation merely
  to recover previously observed output.
- Instrumentation separating static schemas, hooks, capsule tokens, expansion,
  induced tool behavior, cache reads, and model output.

Exit gates:

- With no applicable knowledge, p50 overhead is below 2%, p95 below 5%, and at
  most one additional tool round trip versus an isolated no-system baseline.
- Applicable single-decision capsules have p50 at or below 128 tokens and p95
  at or below 512 while meeting retrieval-recall gates.
- Raw history can grow by 100x without proportional working-context growth.
- Capsule eviction and restoration preserve active goals and required guards.

Dependencies: workstreams 1, 2, 3, 5, and 11.

### 7. Complete agent checkpoints and cross-model takeover

**Objective:** let a fresh agent resume work from verified state instead of
re-reading a transcript, `AGENTS.md`, scratch memory, or an informal summary.

Deliverables:

- Checkpoint schema containing goal DAG, plan state, current hypothesis,
  decisions and rejected alternatives, workspace/artifact hashes, edits,
  attempted actions, known failures, validations, invariants, permissions,
  blockers, ownership leases, unresolved questions, and next safe action.
- Incremental checkpoints at meaningful boundaries: plan approval, edit batch,
  validation, delegation, compaction, handoff, and session end.
- Cold reconstruction by replay plus a compact hot checkpoint for low-latency
  resume.
- Compatibility checks against repository head, dependencies, environment,
  policy, and active graph beliefs before restoration.
- Takeover receipt recording what the consumer restored, rejected, refreshed,
  and acted on.
- Recovery procedures for interrupted checkpoint writes and partially applied
  workspace changes.

Exit gates:

- Codex, Claude, and one additional model/client family can take over the same
  interrupted task without transcript or private client-memory access.
- Takeover correctness is statistically non-inferior to an uninterrupted agent
  within a pre-registered two-percentage-point margin.
- Consumers do not repeat any verified failed action in the checkpoint suite.
- A stale checkpoint is detected before its first incompatible action.

Dependencies: workstreams 1 through 6.

### 8. Distributed multi-agent coordination

**Objective:** make the runtime a shared coordination substrate for many active
agents, not merely a concurrent append log.

Deliverables:

- Agent identity, capabilities, availability, task ownership, leases,
  heartbeats, delegation, cancellation, and completion receipts.
- Goal/task dependency DAG with atomic claim, renew, release, and handoff
  transitions.
- Idempotent multi-writer ingestion, optimistic concurrency, deterministic
  merge policies, and explicit conflict objects.
- Duplicate-work detection from goals, affected artifacts, and planned actions.
- Dependency-aware notifications and bounded context updates rather than global
  broadcast.
- Failure recovery for expired leases, dead writers, network partitions, and
  replay after reconnect.
- Coordination adapters that do not require agents to parse another agent's
  natural-language transcript.

Exit gates:

- 100 concurrent writers complete a mixed read/write/delegate workload with
  zero lost accepted events and a deterministically rebuildable graph.
- Conflicting edits and goals produce explicit conflicts, never silent
  last-writer-wins belief changes.
- Duplicate task execution falls by at least 80% against an uncoordinated
  multi-agent baseline without reducing task completion.
- A later agent can identify authoritative results and abandoned partial work.

Dependencies: workstreams 1, 2, and 7.

### 9. Autonomous consolidation, contradiction handling, and forgetting

**Objective:** make accumulated experience improve in quality rather than grow
indefinitely into an expensive and hazardous archive.

Deliverables:

- Scheduled and threshold-triggered consolidation proposals that group repeated
  episodes into procedures, split over-broad claims, and identify conflicts.
- Active-model-authored source memories remain immutable. A consolidation model
  creates a separately attributed derived proposal and cannot silently alter
  producer-authored meaning.
- Evidence-weighted contradiction resolution, supersession, and version-aware
  validity windows.
- Utility-, recency-, confidence-, scope-, and dependency-aware decay.
- States for active, speculative, stale, superseded, quarantined, archived, and
  tombstoned-from-retrieval while retaining audit evidence.
- Revalidation triggers from code/dependency/schema/policy changes.
- Storage compaction that preserves logical history and published hashes.

Exit gates:

- A 100-session accumulation test keeps active-context cost bounded while
  increasing or preserving downstream correctness.
- Deliberate contradictions are surfaced and resolved with provenance; neither
  view disappears from history.
- Removing low-utility memories improves or preserves the correctness/token
  Pareto frontier against naive append-only retrieval.
- Consolidation never upgrades confidence without new verification evidence.

Dependencies: workstreams 2, 3, and 5.

### 10. Secure cross-project federation

**Objective:** enable useful cross-project and cross-organization learning
without leaking secrets, transferring incompatible assumptions, or allowing
untrusted memory to control tools.

Deliverables:

- Scope hierarchy for session, workspace, branch, repository, project, user,
  organization, and explicitly published global knowledge.
- Compatibility predicates covering language, framework, version, operating
  system, toolchain, repository policy, and artifact lineage.
- Identity, authentication, authorization, encryption, retention, residency,
  export, and deletion policy surfaces.
- Sensitivity classification, secret detection/redaction, source licensing,
  tenant isolation, and data-loss-prevention hooks.
- Trust and taint propagation from source artifact through claim, procedure,
  guard, capsule, action, and outcome.
- Prompt-injection resistance: retrieved content is data unless a separately
  authorized, validated executable object grants behavior.
- Signed bundles for intentionally shared procedures and guards.

Exit gates:

- Cross-tenant and incompatible-project attack suites produce zero unauthorized
  retrievals or guard executions.
- Every cross-project capsule explains why the source is compatible and who
  authorized its scope.
- Secret-seeded artifacts remain absent from exported graphs, dashboards, and
  redacted evidence ledgers.
- Revocation prevents future delivery without destroying required audit proof.

Dependencies: workstreams 1 through 4; required before global federation.

### 11. Adaptive multi-kernel retrieval

**Objective:** subsume RAG and memory retrieval approaches behind one planner
that chooses the cheapest reliable evidence path for the current cognitive
need.

Deliverables:

- Pluggable kernels for structural graph traversal, BM25/lexical search, vector
  similarity, temporal queries, causal paths, procedures, checkpoints,
  content-addressed artifacts, and hierarchical/global graph summaries.
- Query classification across factual-local, factual-global, activity-local,
  activity-global, workflow, failure, temporal, and coordination needs.
- Candidate union with calibrated relevance, compatibility, confidence,
  provenance, recency, expected utility, risk, and token cost.
- Learned or rules-based planning that retains deterministic fallbacks and an
  abstention option.
- Retrieval explanations showing kernel, path, filters, scores, and exclusions.
- Per-kernel ablation, latency, recall, precision, and cost telemetry.
- Backend interfaces that permit local-only, embedded, and service deployments
  without changing the client protocol.

Exit gates:

- No single retrieval kernel wins every registered task family; the adaptive
  planner matches or beats the best kernel per family within uncertainty.
- Applicability precision is at least 95% and stale/irrelevant automatic
  delivery is below 1% on adversarial controls.
- Multi-hop and temporal benchmarks improve over vector-only, lexical-only,
  traversal-only, and full-context baselines.
- Every delivered object has a reproducible retrieval explanation.

Dependencies: workstreams 1 through 3 and 9.

### 12. Minimal and lazy MCP capability surface

**Objective:** ensure the optimizer does not consume more context or induce more
work merely by being installed.

Deliverables:

- A bootstrap profile of no more than four cognitive operations: obtain/page
  context, record verified cognition, checkpoint/handoff, and report outcome.
- Administrative, benchmark, storage, optimization, and specialist tools moved
  behind capability discovery, CLI commands, or dashboard APIs.
- Dynamic/lazy tool exposure where supported and compact stable schemas where
  it is not.
- Removal of redundant static instructions and duplicate hook/plugin context.
- Per-client measurements for schema tokens, static instructions, hook output,
  capsule tokens, MCP round trips, induced calls, cache behavior, and results.
- Capability negotiation so advanced clients can request richer operations
  without charging every client by default.
- Compatibility aliases and a deprecation window for the existing essential
  and full tool profiles.

Exit gates:

- Empty-integration p50 token overhead is below 2% and p95 below 5% against a
  correctly isolated no-system client for each live-certified lifecycle family.
- Startup performs no cognition call when the current client protocol can wait
  for a task event.
- Default installation exposes no unused specialist schemas to the model.
- Existing explicit tool consumers receive migration diagnostics rather than a
  silent break.

Dependencies: workstreams 1, 6, and 13.

### 13. All-client adapter SDK and conformance certification

**Objective:** make UCR genuinely model- and CLI-independent while stating each
client's observable guarantees precisely.

Deliverables:

- Adapter SDK generated from the event protocol, with reference JavaScript,
  process-hook, in-process-plugin, MCP-only, and rules-only implementations.
- Capability tiers:
  `connected`, `observed`, `interceptable`, `continuable`, and `transactional`.
- Registry-owned lifecycle mappings, configuration schemas, installation,
  update, diagnostics, and clean removal for all 16 currently supported clients.
- Contract tests for Codex, Claude Code, Copilot CLI, Gemini CLI, Qwen Code,
  Cursor, Cline, OpenCode, Kilo, Windsurf, Roo Code, Zed, Amp, Continue, Crush,
  and Factory Droid.
- Generated adapters containing only protocol translation; all policy remains
  in the shared runtime.
- Local executable smoke certification when a CLI is installed and paid live
  paired certification for representative models from every lifecycle family.
- Third-party adapter certification kit and compatibility badge containing an
  exact protocol version and demonstrated tier.

Exit gates:

- All 16 clients pass deterministic schema and contract certification.
- At least one installed client in every lifecycle family passes an executable
  smoke test; unavailable clients are labelled unexercised rather than passed.
- Codex, Claude, and at least one additional model family pass bidirectional
  live handoff and checkpoint takeover.
- Generated-client drift fails CI.

Dependencies: workstream 1, with workstreams 4, 6, 7, 8, and 12 for higher
tiers.

### 14. Cognitive Continuity Benchmark

**Objective:** create a public benchmark that measures whether external
cognition makes agents better colleagues, not merely better fact retrievers.

Deliverables:

- Frozen hidden-grader suites for factual/temporal memory, knowledge updates,
  abstention, workflows, verified mistake immunity, checkpoint takeover,
  cross-model handoff, concurrent coordination, cross-project generalization,
  malicious/stale/contradictory memory, and long-horizon compounding.
- Deterministic end-state, tool-receipt, artifact-hash, and side-effect graders;
  model prose and LLM-as-judge are supplementary only.
- Public benchmark adapters for LongMemEval, LongMemEval-V2, LoCoMo,
  EverMemBench, WebArena/Mind2Web-style workflows, coding-agent tasks, and
  document/global-reasoning workloads where licensing permits.
- Hidden task variants, identifier/path rotation, contamination checks, and
  immutable dataset manifests.
- Cross-client/model matrix with exact versions, runner isolation, arm order,
  random seeds, sample-size analysis, and pre-registered exclusions.
- Privacy-preserving raw ledgers with hashes and reproducible aggregation.

Exit gates:

- Empty baselines exhibit measurable headroom without telling treated agents
  the answer or forcing an unnatural failure.
- A second implementation can reproduce deterministic grades and aggregate
  metrics from the published ledgers.
- Every headline has an appropriate confidence interval and powered sample
  size; five display rows never become a scientific threshold.
- Benchmark changes create a new version and never rewrite old outcomes.

Dependencies: workstream 1 for evidence schema; implementation arms consume all
runtime workstreams.

### 15. Reproducible competitive baseline harnesses

**Objective:** beat the strongest alternatives under equal models, tasks,
permissions, context budgets, and grader rules instead of comparing marketing
claims from unrelated experiments.

Deliverables:

- Containerized or scripted baselines for no memory, full history, static
  project instructions, vector RAG, graph RAG, temporal graph memory, memory
  operating systems, workflow/skill libraries, vendor-native memory where
  automatable, and oracle context.
- Reproduced configurations for relevant published systems and explicit notes
  where licensing or hosted behavior prevents exact reproduction.
- Equal model/version, retry, tool, data, context, latency, and spend budgets.
- Pareto analysis for correctness, harmful side effects, recurrence, context,
  total tokens, cost, latency, and operational complexity.
- Home-field evaluations: memory QA, temporal updates, global document
  reasoning, procedural workflows, coding continuity, and multi-agent work.
- Continuous competitor-version registry; results never pool unlike versions.

Category context includes MemGPT's virtual context, Mem0's extracted memory,
Zep/Graphiti's temporal graph, Microsoft GraphRAG's local/global retrieval,
Agent Workflow Memory's reusable routines, and Voyager-style executable skill
libraries. UCR must match them in their strong domains and win on the combined
continuity, action, coordination, and efficiency surface.

Exit gates:

- UCR improves correctness by more than 10 absolute percentage points over the
  strongest reproducible comparable baseline on the primary powered suite, with
  the 95% interval excluding zero.
- UCR lies on or beyond the correctness/token/latency Pareto frontier in every
  declared home-field category; exceptions block a universal superiority claim.
- Failed reproductions and systems that cannot be compared fairly are listed,
  not treated as losses for the competitor.
- Raw command manifests, versions, costs, and result hashes are published.

Dependencies: workstream 14 and stable candidate implementations.

### 16. Live compounding-learning experiments

**Objective:** prove that verified experience causes later heterogeneous agents
to improve over long horizons rather than merely answering isolated retrieval
questions.

Deliverables:

- Curricula of at least 100 linked tasks with changing repositories,
  dependencies, interfaces, naturally discoverable gotchas, and delayed reuse.
- Scheduled switches among model families, CLI families, machines, sessions,
  and compatible projects.
- Natural producer failures followed by correction and active-model semantic
  compilation; seeded findings are separate infrastructure controls.
- Empty, runtime, oracle, stale, irrelevant, contradictory, and intentionally
  harmful arms with counterbalanced order.
- Compounding curves for first-pass correctness, recurrence, rediscovery work,
  takeover time, context, tool calls, cost, latency, and harm.
- Leave-one-memory-out and combination replays for harmful or surprising
  episodes.
- Long-running concurrency and partition/recovery experiments.

Exit gates:

- Verified mistake recurrence falls at least 80% against the matched strongest
  baseline with correctness non-inferior within two percentage points.
- Later-agent first-pass success has a significantly positive learning slope
  while baseline difficulty is held constant.
- Cross-model takeover is within two percentage points of uninterrupted-agent
  correctness and uses at least 50% less reconstruction context.
- No severe harmful memory remains automatically active after its first
  verified regression.

Dependencies: workstreams 3 through 15.

### 17. Effectiveness dashboard and release gates

**Objective:** make capability, uncertainty, efficiency, and harm visible at
the level required to prevent misleading product claims.

Deliverables:

- Complete funnel:
  `captured -> verified -> eligible -> retrieved -> delivered -> used ->`
  `behavior changed -> mistake prevented -> task correct`.
- Separate views for cognition object, task, project, client, model, version,
  lifecycle tier, benchmark, and time period.
- Correctness and harm first; resource savings displayed only after those gates.
- Applicability precision/recall, abstention, staleness, contradictions,
  quarantine, provenance coverage, causal join coverage, uncertainty, sample
  size, and confidence intervals.
- Context breakdown for schemas, hooks, capsules, evidence expansion, cache,
  induced tool use, output, cost, and latency.
- Competitive Pareto, compounding-learning, checkpoint takeover, and
  concurrency views backed by downloadable redacted ledgers.
- Machine-readable release verdict API and signed evidence manifest.

Release gates:

- Applicability precision at least 95%; accepted-finding pre-action delivery at
  least 95%; stale/irrelevant delivery below 1%.
- Verified recurrence reduction at least 80% and paired confidence interval
  excluding zero.
- Natural correctness non-inferior within two percentage points and zero
  observed severe unquarantined regressions.
- Empty-integration p95 overhead below 5%; applicable tasks use at least 50%
  fewer reconstruction tokens at equal or better correctness.
- 100-writer integrity passes with zero lost accepted events.
- Cross-client/model and competitive gates from workstreams 13 through 16 pass.

The API must return `insufficient`, `failed`, or `harmful` instead of `passed`
when any required evidence dimension is missing or regresses.

Dependencies: workstreams 5, 13, 14, 15, and 16.

### 18. Shadow mode, canary rollout, rollback, and production hardening

**Objective:** deploy a self-modifying cognition layer without letting uncertain
memory silently degrade real agent behavior.

Deliverables:

- Rollout stages: offline replay, shadow selection, visible observe-only,
  advisory canary, verification-required canary, scoped enforcement, stable.
- Per-object, project, client, model, organization, and global kill switches.
- Automatic rollback on correctness, harm, latency, context, availability, or
  data-policy regression.
- Schema downgrade/upgrade strategy, backup/restore, disaster recovery,
  corruption repair, and read-only safe mode.
- Resource limits, backpressure, timeouts, circuit breakers, rate limits, and
  offline behavior.
- SLOs and alerts for event acceptance, projection lag, retrieval latency,
  guard latency, checkpoint recovery, data loss, and unauthorized access.
- Install doctor, signed releases, checksums, migration preview, clean uninstall,
  and preservation/export of user-owned cognition data.
- Incident playbooks for harmful guard, poisoned memory, secret exposure,
  writer loss, projection divergence, and benchmark regression.

Exit gates:

- Fault-injection and disaster-recovery exercises meet defined recovery point
  and recovery time objectives with no accepted-event loss.
- A harmful canary automatically disables the responsible behavior before
  broader rollout.
- The runtime remains usable in read-only or disconnected mode and never blocks
  the user's emergency disable path.
- Stable promotion requires every workstream 13-17 release gate and a signed
  evidence manifest.

Dependencies: all preceding workstreams.

## Dependency and delivery sequence

The 18 workstreams are one program, not one unreviewable implementation diff.
They should land as gated, independently reversible PRs while remaining on one
program board and evidence contract.

```text
1 Event protocol
├── 2 Cognitive graph
│   ├── 3 Semantic compiler
│   │   ├── 4 Executable memory
│   │   │   └── 5 Causal credit
│   │   ├── 9 Consolidation
│   │   ├── 10 Federation/security
│   │   └── 11 Retrieval kernels
│   ├── 7 Checkpoints
│   │   └── 8 Coordination
│   └── 14 Benchmark schema
├── 13 Client SDK
└── 14 Benchmark schema

5 + 11 + 12 + 13 ──> 6 Context VM integration
13 + 14 ────────────> 15 Competitive harness
3..15 ──────────────> 16 Compounding experiments
5 + 13..16 ─────────> 17 Dashboard/release gates
1..17 ──────────────> 18 Production rollout
```

## Milestones and program exits

### M0 — Contract freeze

Workstreams: 1, planning portions of 14 and 17.

Exit:

- Event, evidence, identity, redaction, and metric contracts are versioned.
- Existing graph/evidence data has a documented migration path.
- No implementation team needs to invent a private event shape.

### M1 — Cognitive kernel

Workstreams: 2, 3, and foundational 10.

Exit:

- Active models author evidence-backed typed cognition objects.
- The graph rebuilds deterministically and enforces scope/provenance.
- Existing wiki behavior can run through compatibility projections.

### M2 — Behavior and efficiency

Workstreams: 4, 5, 6, 11, and 12.

Exit:

- Verified lessons can become safe guards or procedures.
- Effects and harm are joined to outcomes.
- Context is paged just in time with bounded empty-system overhead.

### M3 — Continuity and coordination

Workstreams: 7, 8, and 9.

Exit:

- Fresh heterogeneous agents resume active work without transcripts.
- Concurrent agents coordinate through typed state with no lost accepted work.
- Memory quality improves or remains bounded over long histories.

### M4 — Universal client and federation layer

Workstreams: 10 and 13.

Exit:

- All supported clients have honest protocol-tier certification.
- Cross-project transfer is compatible, authorized, explainable, and revocable.

### M5 — Category proof

Workstreams: 14, 15, 16, and 17.

Exit:

- Public and internal benchmarks meet powered correctness, recurrence,
  continuity, efficiency, and harm gates.
- UCR beats the strongest reproducible baselines on the declared combined
  category surface.

### M6 — Production system

Workstream: 18.

Exit:

- Shadow, canary, rollback, recovery, security, SLO, and release-evidence gates
  pass under fault injection and real client traffic.

## Competitive proof matrix

UCR must compete with systems in their strongest domain, not only on a custom
task optimized for this architecture.

| Domain                     | Required baselines                                                  | Primary result                                                  |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Long conversational memory | full context, vector RAG, extracted memory, temporal graph memory   | factual, temporal, update, abstention correctness               |
| Global document reasoning  | vector RAG, GraphRAG-style local/global search, long context        | answer correctness and evidence coverage per token              |
| Environment experience     | raw trajectory, RAG runbook, coding-agent evidence search           | static state, dynamic state, workflow, gotcha, premise accuracy |
| Procedural action          | no memory, workflow memory, executable skill library                | end-state success, steps, side effects, transfer                |
| Coding continuity          | static instructions, transcript summary, vendor memory, checkpoints | takeover correctness and reconstruction cost                    |
| Mistake transfer           | empty, prose finding, oracle, executable guard                      | verified recurrence and final correctness                       |
| Multi-agent work           | isolated agents, shared text log, shared vector memory              | completion, duplicate work, conflicts, lost writes              |
| Adversarial memory         | naive append-only and top-k retrieval                               | abstention, harm, poisoning resistance, quarantine time         |

Relevant public reference points include:

- [MemGPT](https://arxiv.org/abs/2310.08560) for virtual context management.
- [Mem0](https://arxiv.org/abs/2504.19413) for extracted conversational and
  graph memory.
- [Zep/Graphiti](https://arxiv.org/abs/2501.13956) for temporal agent memory.
- [Microsoft GraphRAG](https://www.microsoft.com/en-us/research/project/graphrag/)
  for local/global graph retrieval.
- [HippoRAG](https://arxiv.org/abs/2405.14831) for graph-based multi-hop
  retrieval.
- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) and
  [Voyager](https://arxiv.org/abs/2305.16291) for procedures and executable
  skills.
- [LongMemEval](https://arxiv.org/abs/2410.10813),
  [LongMemEval-V2](https://arxiv.org/abs/2605.12493), and
  [EverMemBench](https://arxiv.org/abs/2602.01313) for long-term memory and
  environment experience.

The LongMemEval-V2 paper reports 72.5% for its strongest method and 48.5% for
its strongest RAG baseline. The program target is above 82.5% on a faithfully
reproduced compatible configuration while also improving its accuracy/latency
Pareto frontier. This is a target, not a present product claim.

## Program-wide measurement contract

### Correctness and safety

- Deterministic task correctness and required proof artifacts.
- First-pass correctness and recovery correctness.
- Executed and attempted recurrence of verified mistakes.
- Unnecessary destructive or externally visible side effects.
- Applicability precision, recall, abstention, stale delivery, and contradiction
  exposure.
- Severe and non-severe harm, quarantine latency, and residual exposure.

### Continuity and learning

- Checkpoint restoration completeness and takeover time.
- Rediscovery work avoided without transcript leakage.
- Cross-model, cross-client, cross-session, cross-machine, and cross-project
  transfer rates.
- Learning-curve slope across controlled task curricula.
- Procedure reuse and composition success.

### Efficiency

- Static schema/instruction tokens.
- Hook, capsule, evidence, expansion, uncached input, cached input, output, and
  total tokens where clients expose them.
- Tool calls, failed calls, retries, latency, price, energy/compute proxy where
  observable, and storage/index cost.
- Correctness-adjusted Pareto position; raw savings never override correctness.

### Reliability and operations

- Accepted-event durability, projection lag, graph/index rebuild time, conflict
  rate, lost-write rate, and checkpoint recovery.
- Availability, tail latency, timeout rate, offline degradation, and rollback
  time.
- Unauthorized retrieval, secret exposure, policy denial, audit coverage, and
  revocation latency.

## Statistical and experimental rules

1. Freeze tasks, graders, arms, primary outcomes, exclusions, and sample-size
   rules before live runs.
2. Use matched runs, rotate arm order, and isolate plugins, MCP servers, rules,
   memories, transcripts, environment state, and graph state.
3. Separate client, client version, model, model version, task family, and
   runtime version unless a pre-registered hierarchical model supports pooling.
4. Use deterministic bootstrap intervals for continuous paired effects and
   Wilson or exact intervals for rates.
5. Estimate variance in pilots, then power primary studies. Display thresholds
   are never claim thresholds.
6. Preserve producer failures, capture failures, null effects, negative
   controls, and harmful outcomes.
7. Do not use model assertions as correctness or memory-use evidence when a
   state, receipt, action, or hidden grader can decide it.
8. Publish missing usage as `null`; never manufacture totals or costs.
9. Correctness and safety gates are non-inferiority constraints even when the
   primary hypothesis concerns efficiency.
10. Competitor comparisons use equal accessible models, permissions, budgets,
    retries, and task inputs, with deviations disclosed.

## Migration and compatibility strategy

- Existing wiki JSONL remains readable and migrates into `event`, `artifact`,
  `claim`, `task`, and provenance objects.
- Existing file/symbol anchors remain structural graph entities.
- Existing `wiki_write` maps to the semantic compiler compatibility endpoint
  and returns migration diagnostics for missing evidence or applicability.
- Existing dashboards continue reading a compatibility projection until the
  UCR evidence API replaces it.
- Existing tool profiles receive a deprecation period. The minimal cognitive
  profile is opt-in until client certification and overhead gates pass.
- Existing generated integrations remain produced from the registry; adapters
  migrate one lifecycle family at a time behind capability flags.
- No current graph is automatically promoted beyond project scope.
- PR #302 ledgers remain immutable before-state evidence and are never rewritten
  to make a later cohort look better.

## PR #303 implementation and evidence boundary

PR #303 implements the runtime mechanisms, independent verifiers, executable
harnesses, and signed evidence plumbing for all 18 workstreams. It does **not**
promote the runtime to production or convert deterministic fixtures into live
effectiveness. Automatic behavior remains fail-closed and the release verdict
remains `insufficient` until powered natural-task, competitive, and production
traffic studies pass.

The evidence contract has six non-interchangeable classes: transport,
conformance, executable smoke, effectiveness, superiority, and production.
`evals/ucr/results/evidence-index-v2.json` verifies 11/11 current artifacts and
contains signed, hash-chained, redacted ledgers. Conformance and executable
smoke are present; effectiveness, superiority, and production remain missing.

## Workstream evidence matrix

|   # | Implemented in PR #303                                                                                                 | Evidence now                                                                                                                                 | Program exit still open                                      |
| --: | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
|   1 | Signed run identity, versioned events, content-addressed artifacts, migrations, canonical replay                       | 29/29 runtime checks plus byte-equivalent independent Python replay                                                                          | Production redacted replay corpus                            |
|   2 | Typed bitemporal/causal graph and streaming validated projection                                                       | 1,000,000 events, 44,475 events/s, zero duplicates/orphans/diagnostics                                                                       | Full legacy-wiki migration audit                             |
|   3 | Model-authored `propose -> verify -> activate`, receipt verification, dedupe, provenance, hard negatives               | Forged receipts rejected; unfamiliar evidence is verified read-only before persistence                                                       | Powered semantic-quality corpus                              |
|   4 | Scoped guard DSL, timeouts/fail behavior, five modes, audit, disable/downgrade, FPR/FNR                                | 101 traces, zero false positives and misses                                                                                                  | Powered live prevention study                                |
|   5 | Exact causal joins, ablations, confounder refusal, quarantine latency                                                  | Confounded credit rejected; counterfactual and quarantine tests pass                                                                         | Matched live causal cohorts                                  |
|   6 | L0-L4 Context VM, native tokens, persistent working sets, deltas, zero-work starts                                     | 118/128-token applicable capsule; native accounting tests                                                                                    | Paired live empty-session p50/p95                            |
|   7 | Complete signed checkpoints, atomic storage, deltas, takeover/staleness study                                          | Stale workspace rejected before action; multi-family fixture study                                                                           | Powered live takeover non-inferiority                        |
|   8 | SQLite/WAL tasks, transactions, leases, recovery, conflict and partition reconciliation                                | 100 physical workers, zero lost writes, 100% duplicate suppression                                                                           | Multi-host production contention                             |
|   9 | Immutable consolidation proposals, contradictions, decay, bounded growth                                               | 100 sessions, zero source mutations, 88/88 delayed reuse retained                                                                            | Powered semantic retention quality                           |
|  10 | Negotiation, authenticated principals, taint/redaction, revocation, red-team transfer suite                            | Signed transfer accepted; injection/revoked transfer denied                                                                                  | External security assessment                                 |
|  11 | BM25, vector, temporal, causal, structural, procedure, checkpoint, and global kernels with calibrated routing          | Kernel, abstention, compatibility, and calibration tests pass                                                                                | Frozen live recall/cost/latency comparison                   |
|  12 | Four-operation cognitive MCP surface with real `tools/list` native-token audit                                         | 1,162 tokens versus 4,815 core and 30,593 full; 96.2% reduction versus full                                                                  | Paired provider prompt-overhead distribution                 |
|  13 | One adapter SDK and honest capability tiers for 16 clients                                                             | 16 distinct child processes, 16/16 certified, four lifecycle families, semantic parity                                                       | Paid native CLI execution for unavailable clients            |
|  14 | Frozen 11-family, seven-arm benchmark, hidden variants, signed graders, preregistration and power analysis             | 11 natural fixtures; required sample size 357 per arm                                                                                        | Full powered model execution                                 |
|  15 | Ten executable reference implementations, fairness and Pareto gates                                                    | 1,000 reference cases; all labelled non-product baselines                                                                                    | Fair strongest-product reproductions                         |
|  16 | Linked 100-task/700-arm curriculum, immutable ledger, learning and explicit ablations                                  | 0.88 recurrence and 0.65 reconstruction reductions in deterministic policy fixtures                                                          | Paid live compounding execution                              |
|  17 | Tiered evidence contract, funnel, release gate, API, dashboard, blinded cross-CLI harness                              | Three committed edges passed with zero repeated failures; a repeated two-direction pilot passed 1/2 and remained smoke-tier; dashboard 31/31 | Powered effectiveness and third-family provider availability |
|  18 | SLO aggregation, six-class fault injection, staged rollout, scoped kills, safe mode, breaker, recovery, readiness gate | 6/6 local faults contained, zero event loss, signed ledger                                                                                   | Staged production traffic and production-tier SLO window     |

## PR #303 implementation task checklist

- [x] 1. Universal Cognitive Event Protocol foundation
- [x] 2. Typed temporal and causal cognitive graph foundation
- [x] 3. Model-native semantic compiler foundation
- [x] 4. Executable memory and action guards foundation
- [x] 5. Causal credit and harm quarantine foundation
- [x] 6. Context virtual machine foundation
- [x] 7. Complete agent checkpoints and cross-model takeover foundation
- [x] 8. Distributed multi-agent coordination foundation
- [x] 9. Autonomous consolidation, contradiction handling, and forgetting foundation
- [x] 10. Secure cross-project federation foundation
- [x] 11. Adaptive multi-kernel retrieval foundation
- [x] 12. Minimal and lazy MCP capability surface
- [x] 13. All-client adapter SDK and conformance certification foundation
- [x] 14. Cognitive Continuity Benchmark protocol
- [x] 15. Reproducible competitive baseline harness foundations
- [x] 16. Live compounding-learning experiment protocol
- [x] 17. Effectiveness dashboard and fail-closed release gates
- [x] 18. Shadow mode, canary rollback, and production-hardening controls

These checks mean the PR implementation exists and is tested. They do not
override the exit-gate definition above; the matrix names every empirical gate
that remains open.

## Definition of program success

The program is complete only when all 18 tasks pass their exit gates and the
evidence supports every part of this bounded claim:

> Across the certified clients, models, tasks, and scopes in the published
> evidence manifest, UCR transfers verified cognition and active work across
> agents, reduces repeated mistakes and reconstruction effort, maintains or
> improves correctness, bounds irrelevant context, coordinates concurrent work,
> and fails safely when knowledge is uncertain or harmful.

“Replaces all RAG and memory systems” remains a product direction until the
competitive matrix is passed. The project may claim superiority only for the
domains, versions, budgets, and confidence bounds actually tested.
