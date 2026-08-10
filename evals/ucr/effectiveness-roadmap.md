# Universal Cognitive Runtime effectiveness roadmap

This roadmap separates implemented mechanisms from empirical proof. A checkbox
closes only after its code, deterministic/adversarial tests, live evidence, and
exit gate all pass. Signed negative runs remain in the evidence index.

## Current failure ledger

- The original Claude-to-Codex pilot consumed 40,668 input tokens versus
  13,248 in control (+208%) while delivering no applicable context. The model
  was expected to remember to call `context_page`; it did not.
- Adapter-controlled pre-action retrieval removed the optional-retrieval
  failure. A later answer-echo pilot passed Claude-to-Codex, but
  Codex-to-Claude correctly rejected the hidden-answer injection as untrusted.
  That benchmark was confounded and is superseded by stateful end-state grading.
- The current four-call stateful smoke passes Codex-to-Claude and
  Claude-to-Codex. Each direction uses a matched no-capture predecessor, an
  in-turn model-authored capture predecessor, a blinded control successor, and
  a runtime successor. Both fresh successors produced correct repository state
  and neither runtime successor repeated the generated-only edit.
- The stricter matched rerun gives control and treatment producers byte-identical
  prompts and equivalent client surfaces, and loads identical native guard
  transport in both consumer arms. Full pipeline traffic fell from 702,243 to
  662,510 (5.66%), while latency rose from 146,289 ms to 153,210 ms (4.73%).
  Codex-to-Claude used 11.56% fewer tokens but 10.87% more latency;
  Claude-to-Codex used 0.58% fewer tokens and 0.53% less latency. Both controls
  completed correctly without the target mistake, so the rerun is not evidence
  of a correctness lift or mistake prevention.
- A minimal Claude plugin transport attempt increased traffic 25.0% and latency
  25.3% without exercising the guard. It remains negative evidence and caused
  the harness to use a one-hook native settings file instead of loading the
  plugin during treatment.
- Claude-to-Copilot reached the consumer step but the installed account returned
  HTTP 402 for exhausted quota. The failed signed row is retained; Copilot is
  not live-certified by this run.

## Non-negotiable runtime contract

```text
external observation -> host authentication -> active model authors semantics
  -> strict validation/quarantine -> graph activation

user task -> host pre-action retrieval -> scope/receipt/budget validation
  -> bounded lifecycle injection -> model action -> independent outcome grader
```

The active model owns semantic interpretation. The host owns authentication,
mandatory retrieval, scope, budgets, persistence, and enforcement. No model is
responsible for remembering to retrieve prerequisite context.

## All 18 workstreams

| #   | Workstream                                    | Current state                                                                     | Required exit                                                                                                                                                                                      |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Universal Cognitive Event Protocol            | Mechanism implemented                                                             | Version/migration replay, signatures, redaction allowlist, and independent verifier all pass on every promoted artifact                                                                            |
| 2   | Typed temporal and causal graph               | Conformance implemented                                                           | Million-event integrity plus adversarial malformed, duplicate, causal-cycle, and bounded-resource runs pass without overstating memory guarantees                                                  |
| 3   | Model-native semantic compiler                | Strengthened in this PR                                                           | Active model authors exact persisted bytes only after host-authenticated evidence; malformed output retries once; poisoned or unverifiable semantics never activate                                |
| 4   | Executable memory and action guards           | Shared runtime, ten native adapters, and one live denial implemented              | Verified corrections compile into scoped pre-tool guards; every interceptable client blocks or redirects the repeated action before execution; advisory clients are labeled                        |
| 5   | Causal credit and harm quarantine             | Deterministic mechanism implemented                                               | Blinded ablations attribute benefit without confounders; severe harm is quarantined before reuse; false-credit and quarantine-latency gates pass                                                   |
| 6   | Context virtual machine                       | One-capsule delivery and phase accounting implemented; powered traffic gate open  | Report added active context separately from total traffic, cached traffic, turns, latency, and cost; p95 added context stays under the preregistered budget and total traffic is non-inferior      |
| 7   | Complete checkpoints and cross-model takeover | Stateful primary smoke passes                                                     | Ten consecutive fresh-session pairs per primary direction pass compatibility, delivery, end-state correctness, zero-repeat, and efficiency gates                                                   |
| 8   | Distributed multi-agent coordination          | Physical-process conformance implemented                                          | Multiple real agents concurrently publish, lease, conflict, recover, and take over the same task with no lost accepted writes or duplicate work                                                    |
| 9   | Autonomous consolidation and forgetting       | Deterministic mechanism implemented                                               | Long-horizon live reuse retains delayed-value cognition, removes stale/low-value items, bounds growth, and never mutates source evidence                                                           |
| 10  | Secure cross-project federation               | Policy conformance implemented                                                    | Cross-project opt-in, principals, taint, redaction, revocation, and scope isolation pass adversarial live transfer with zero unauthorized delivery                                                 |
| 11  | Adaptive retrieval                            | Exact scope kernel and fallback hardened                                          | Hidden hard-negative suite reaches <1% irrelevant/stale delivery with calibrated abstention and no empty calibrated route disabling retrieval                                                      |
| 12  | Minimal MCP capability surface                | Measured and strengthened                                                         | Normal consumers expose zero tools; continuity is 480 tokens, optional attestation 71, extended cognitive 694, core 4,815, and full 30,125; provider wrappers are measured separately              |
| 13  | All-client adapter SDK                        | Ten generated native guard adapters pass conformance; two primary live edges pass | Every supported CLI is certified against the same contract, with task/pre-tool guarantees stated per lifecycle family and paid live edges for available providers                                  |
| 14  | Cognitive Continuity Benchmark                | Stateful runner implemented                                                       | Natural tasks grade executable end state rather than answer echoes; hidden variants, signed graders, contamination checks, and preregistration all pass                                            |
| 15  | Competitive baseline harness                  | Deterministic harness implemented; product runs open                              | AGENTS.md, transcript, RAG/vector, and product-memory arms use identical tasks, models, budgets, tool access, and independent graders                                                              |
| 16  | Compounding-learning experiments              | Deterministic study only                                                          | Longitudinal live model study shows increasing first-pass correctness and decreasing repeated errors/context traffic with confidence intervals, not fixture-only gains                             |
| 17  | Effectiveness dashboard and release gates     | Dashboard and fail-closed tiers implemented                                       | Dashboard displays signed positive and negative stateful directions, active-context versus traffic metrics, confidence intervals, and refuses effectiveness/superiority promotion until gates pass |
| 18  | Shadow/canary/production hardening            | Fault mechanism exercise only                                                     | Real shadow/canary window meets SLOs with scoped kill switch, rollback, breaker recovery, immutable incidents, privacy review, and no severe unquarantined harm                                    |

## Execution sequence

The authoritative executable design is now
[`FULL_STUDY_CONTRACT.md`](./FULL_STUDY_CONTRACT.md). It supersedes the earlier
single-fixture powered estimate below: repeating one handoff task cannot establish
all-family generalization or confidence-bounded hard-negative safety.

1. Ship the mandatory `PreActionController`, exact-scope retrieval, model-authored
   harvest receipts, zero-tool consumer path, capability guarantees, and the
   stateful bidirectional evidence now implemented on this branch.
2. Connect verified failure objects to the existing `GuardRuntime` in shared
   hook core, then regenerate native client adapters and prove pre-tool blocking
   on every interceptable lifecycle family.
3. Keep the adversarial retrieval/poisoning/scope suites and phase-scoped
   accounting as release gates for maximum active context, total traffic, cache
   traffic, model turns, latency, and cost. Investigate the Codex-to-Claude
   latency regression before promotion.
4. Run ten consecutive stateful pairs in every available direction. Acquire or
   replenish provider quota before calling Copilot or unavailable clients live;
   never substitute a deterministic adapter test for a paid live edge.
5. Freeze graders and hidden variants, then execute the full preregistered matrix
   (363 pairs per direction and 1,056 hard-negative opportunities per direction
   and arm; 54,054 trials / 113,022 provider calls for three clients and
   nine same/cross-client directions). Require at
   least a 10-point correctness lift with confidence-interval lower bound above
   zero, zero severe unquarantined harm, and the efficiency SLO.
6. Run fair competitive baselines, then shadow/canary production. Only those
   completed evidence tiers may support replacement, superiority, or production
   claims.

## Claim boundary

Current evidence supports conformance and two primary stateful executable-smoke
directions. It does not support universal efficiency, powered effectiveness,
competitive superiority, or production readiness. Implementation volume never
promotes those claims; only the exit evidence above can.
