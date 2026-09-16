# Tool-code development experiment

Registered before live execution. This experiment addresses a measured initial
tool-description overhead; it does not assume that cache misses are fixed.

- Candidate: current proxy with `TOOL_CODE=1` in the runner, enabling
  `TOKEN_OPTIMIZER_PROXY_TOOL_CODE=1`. The feature is off by default.
- Competitor: installed HeadRoom, default compression settings, through the
  same local Codex runner and independent quality/cost auditors.
- Nullable, adversarial-v1: seeds 2494523015 and 2494523016.
- JSON, heldout-v1: seeds 3141592001 and 3141592002.
- Two repetitions per family, arms `proxy,headroom`, with order rotated on the
  second repetition: four pairs / eight attempts total. The first seed in each
  family deliberately repeats the observed cost loss; these are development
  cases and cannot establish held-out superiority.
- Keep every attempt, failure and unknown charge. No replacement runs or
  extending the schedule until the desired number of wins appears.
- Report independent quality, each pair's estimated cost and agent time, cache
  usage, and first-request input. Do not attribute a cache hit to the code
  change without causal evidence. Compare input reduction separately from cost.
- Existing Windows memory preflight/telemetry applies symmetrically. Stop if
  the guard fails; preserve earlier results and report incomplete execution.

Adversarial review: flattening all description whitespace can change code
examples and quoted values. The candidate only removes selected whitespace
inside supported fenced code, preserves comments/strings/newlines, skips
templates, continuations and ambiguous slashes, and never walks JSON Schemas or
grammars. Tests compare TypeScript tokens and JSON values, check fallback and
idempotence, and verify opt-in behavior and stable historical request items.
The bounded description cache cannot retain an unlimited set of definitions.

The two observed cost gaps are $0.006250 (nullable) and $0.039722 (JSON).
Cache-discount differences outweighed our lower input/output in both. Their
recorded cache keys and initial prefixes were stable across requests; local
replay preserves historical items after appending a new question. The candidate
saves 140 o200k_base estimated tokens from the additional-tools item in each
replayed request. This diagnostic tokenizer count is not provider billing.
