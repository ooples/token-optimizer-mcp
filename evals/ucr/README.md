# UCR evidence

UCR keeps deterministic conformance, executable model smokes, and release
evidence separate. Passing a lower evidence tier never implies that a higher
tier passed.

## Deterministic conformance

Run:

```sh
npm run verify:ucr
```

The command verifies the committed artifact at
`results/deterministic-verification-v1.json`. Intentional metric changes require
review followed by:

```sh
npm run evidence:ucr:update
```

The artifact currently records 26/26 deterministic checks, 16/16 schema-level
client certifications, a 118-token applicable capsule under a 128-token budget,
100 simulated coordinated writers, an 11-family benchmark, ten competitor
manifests, and a 100-task/700-run compounding schedule.

## Executable Codex-to-Claude smoke

Preview installed-runner availability without invoking a model:

```sh
npm run eval:ucr:handoff:plan
```

Run the paid smoke only with explicit authorization:

```sh
npm run build
npm run eval:ucr:handoff
```

The harness generates a fresh hidden recovery code, obtains an external signed
grader receipt, runs a blinded empty-memory Claude control, asks Codex to author
the verified semantic failure, and asks a fresh Claude process to page it. Raw
model transcripts and the recovery code are not published. Failed and passing
attempts remain in `results/live-cross-model-handoff-attempts.jsonl`.

The committed passing smoke proves executable cross-process and cross-model
transfer for one pair. It does not establish efficiency, statistical
non-inferiority, compounding learning, or competitive superiority.

## Release evidence

The dashboard and `/api/ucr/evidence` expose both committed evidence tiers, but
the correctness-first release verdict remains `insufficient` until every field
in the program measurement contract is backed by powered live studies.
