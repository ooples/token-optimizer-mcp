# Full UCR effectiveness, superiority, and production contract

The full program has three independent signed verdicts. Passing mechanism or
adapter tests cannot promote any of them.

## 1. Effectiveness

`npm run eval:ucr:full-study:powered-plan` freezes the complete study before any
provider call. The current design contains:

- all 11 benchmark families and all seven context arms;
- same-client and bidirectional cross-client handoffs across Codex, Claude Code,
  and a third independent model family;
- same-session, cross-session, same-project, cross-project, single-agent, and
  concurrent-agent trials;
- 363 paired empty/runtime observations per direction, exceeding the
  preregistered 357-pair correctness requirement;
- 1,056 opportunities per direction for each hard-negative arm. With zero
  false deliveries, the Bonferroni-adjusted 95% family-wise Wilson upper bound
  across 9 directions × 5 safety arms is below 1%; and
- a unique hidden variant, session, and mutable workspace for every arm.

The plan has 54,054 trial envelopes and 113,022 provider calls. Ordinary envelopes require a matched
predecessor and successor; concurrent-coordination envelopes require one
producer plus two overlapping successors. The larger count is deliberate: the
previous handoff plan made only 2,856 calls, repeated one handoff task, and could
not establish family coverage or a sub-1% negative-delivery confidence bound.

The parent process materializes each repository fixture and grades its filesystem
state after the model exits. Provider prose and claimed success are ignored.
Protected fixture changes fail the grade. Raw prompts, transcripts, and model
output are rejected anywhere in a signed evidence row, including nested fields.

## Driver contract for every CLI

Every direction driver receives one `ucr.study-trial-request/1` JSON object on
stdin and returns one `ucr.study-driver/1` object on stdout. The driver must:

1. invoke the producer on a fresh copy of the fixture;
2. let that active model author the compact semantic delta during its work turn;
3. let the host authenticate and activate or withhold that delta according to
   the randomized arm, with zero capture-only model calls;
4. run mandatory bounded pre-action retrieval;
5. invoke one fresh consumer, or two host-observed overlapping successors for
   concurrent-coordination trials, with zero MCP tools and zero static MCP schema;
6. retain complete pre-tool action telemetry; and
7. return provider-native token, cache, latency, cost, CLI/model version, and
   observed session/project/agent topology telemetry for every call, plus the
   executed top-level `promptHash`, `permissionsHash`, and `budgets` bindings.

Drivers may attest only the capture-through-use portion of the causal chain.
The parent grader alone appends behavior change, mistake prevention, and task
correctness after comparing the paired filesystem outcomes; model or driver
claims cannot populate those outcome stages.

The dispatcher reads a direction-specific environment variable such as
`UCR_STUDY_DIRECTION_CLAUDE_CODE_TO_CODEX`. Every registered CLI uses the same
protocol; lifecycle capability and live certification remain separate facts.
Missing executables, quotas, versions, action audits, native usage data, or
independent grades fail the trial and remain in the append-only attempt ledger.

Run a non-promotable qualification first:

```text
npm run eval:ucr:full-study:qualification
```

The repository ships `scripts/ucr-live-study-driver.mjs`, an executable
provider-CLI implementation of the shared driver protocol. Provision the
operator-owned signing identity and hidden-variant secret outside the repository
before qualification:

```text
npm run eval:ucr:identity:provision
```

The full-study runner also accepts comma-separated `--directions`, `--families`,
and `--arms` selectors for bounded qualification. Filtered runs remain
`executable-smoke` evidence and can never be promoted as powered effectiveness.
Every negative, invalid, or interrupted attempt remains in its append-only
attempt ledger.

The August 10 live qualification preserves every attempt rather than selecting
only favorable reruns. The initial Codex-to-Claude pair was valid but runtime
increased tokens and latency. The first Claude-to-Codex pair made runtime
incorrect while the empty control was correct. A hash-bound task-completion
instruction corrected the missing consumer result on the first retry, which
then exposed incomplete producer capture telemetry. The repaired driver moved
hidden context to stdin, normalized nested provider structured output, raised
the bounded producer budget, and recorded process completion telemetry. Its
next Claude-to-Codex pair was valid and correct in both arms while runtime used
34.9% fewer tokens and 38.2% less latency. A later Codex-to-Claude pair observed
the empty control repeat the predecessor mistake while runtime prevented it and
used 26.2% fewer tokens. These are signed qualification outcomes, not powered
effectiveness evidence.

Every bounded execution emits a separate `ucr.study-qualification/1` verdict.
That gate requires complete selected execution, signed trial integrity,
independent grading, no severe harm, correct treatment and safety arms,
pre-action runtime delivery, control and hard-negative withholding, paired
coverage, correctness non-inferiority, and at most 5% observed token overhead.
An empty control may fail because prevention of that failure is a primary study
outcome; changing prompts, graders, powered thresholds, or source after the
gate passes invalidates scale-up.

The immediate machine-gated Codex-to-Claude repetition kept integrity and
correctness but failed token non-inferiority: runtime used 76,748 tokens versus
58,983 for the empty control (+30.1%). This conflicts with the prior repetition
where runtime prevented the control mistake with 26.2% fewer tokens. Both are
retained. The direction is therefore unstable, and the powered run remains
blocked rather than selecting the favorable sample.

After every configured direction passes qualification without changing prompts,
graders, thresholds, or source, run the frozen powered study:

```text
UCR_STUDY_SECRET=<private frozen secret> npm run eval:ucr:full-study
```

Promotable effectiveness, superiority, and production ledgers must use the same
externally provisioned Ed25519 identity. Configure
`UCR_EVIDENCE_SIGNING_KEY_ID`, `UCR_EVIDENCE_PRIVATE_KEY_FILE`, and
`UCR_EVIDENCE_PUBLIC_KEY_FILE`; artifacts retain only the published key id, not
either key. Production assembly additionally requires
`UCR_TRAFFIC_PSEUDONYM_SECRET` and `UCR_TRAFFIC_PSEUDONYM_KEY_ID`, and persists
only stable pseudonyms for client and project identifiers.

The effectiveness verdict additionally requires all-family and all-arm coverage,
direction- and family-level correctness non-inferiority, direction-level token
non-inferiority, multiplicity-adjusted confidence-bound retrieval safety, a complete causal chain in
every family, complete trial integrity, independent grading, zero consumer MCP
schema, and zero capture-only inference.

## 2. Competitive superiority

`npm run eval:ucr:competitive:plan` audits the registry. Internal reference
algorithms are controls but cannot support a product claim. A promotable registry
must contain live, pinned, reproducible configurations for no memory, full
history, static instructions, vector RAG, graph RAG, memory OS, and vendor-native
memory. Product categories require a named product and published configuration.

`npm run eval:ucr:competitive` reuses the exact effectiveness tasks, models,
permissions, context/retry/tool budgets, and independent graders. Every baseline
is repeated at least twice. UCR must improve correctness by more than ten points,
the paired confidence lower bound must exceed zero, and UCR must remain on the
correctness/harm/tokens/latency Pareto frontier for every required baseline.

## 3. Production readiness

`npm run eval:ucr:production:traffic:plan` prints the privacy-safe JSONL contract.
Local fault exercises never count as production traffic. Promotion requires at
least 1,000 opt-in samples across at least three clients and three projects over
at least seven days, covering shadow, observe-only, advisory canary, verification
canary, and scoped enforcement. It also requires passed SLOs, every fault
exercise, zero-loss recovery, zero privacy violations, zero severe harm, and the
stable rollout stage.

The production assembler rejects prompt, transcript, or raw-output fields,
creates a signed production ledger, and keeps rollback/readiness separate from
effectiveness and superiority.

## CI and dashboard

`npm run verify:ucr:study-design` fails CI if any release metric loses its study,
any family/arm/client/mode disappears, or either the paired or hard-negative
sample size becomes underpowered. The dashboard renders effectiveness,
superiority, and production separately, along with missing metrics, family/arm
coverage, the worst hard-negative confidence upper bound, and the worst
directional token bound.

No documentation or dashboard may call UCR a RAG/memory replacement until all
three signed verdicts pass. Negative and incomplete runs are evidence, not
artifacts to delete.
