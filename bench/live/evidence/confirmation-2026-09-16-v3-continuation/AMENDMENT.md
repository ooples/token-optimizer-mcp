# Bounded-memory verifier and continuation of the original schedule

Registered after a between-case harness allocation failure and **before any
continuation call or cost analysis**. The original protocol and schedule are
copied unchanged. This is an amended execution, not an uninterrupted completion
of the original frozen harness. Report this deviation with every resulting claim.

## What changes

- SHA-256 reads use 64 KiB streaming chunks instead of whole-file buffers.
  Digests retain the same definition and are checked against the original freeze.
- The runner accepts an independently audited complete prefix from a separate
  interrupted directory. It runs only the remaining scheduled pairs, in exactly
  the original order. Original evidence is never overwritten.
- A new frozen continuation registration identifies the 22 completed pairs and
  hashes the original journal, original freeze, integrity check, protocol, plan,
  and every original/copied pair artifact. The runner checks them before calls.
- All original frozen artifacts must still match except the hashing and runner
  implementation files. New continuation support and checks are frozen too.
  Products, Codex, analysis, task generator, prompts, arm settings and schedule
  remain unchanged. Provider cache state remains uncontrolled and observed.

## Adversarial review and constraints

An outcome-selected restart would invalidate inference. This continuation keeps
all 22 completed pairs, regardless of their outcomes, and runs exactly the 48
unattempted pairs. There are no replacement cases, repeats, extra samples or
new seeds. No cost comparison or significance analysis informed this repair.

A partial pair might hide paid requests or duplicate an attempt. Therefore the
continuation rejects every partial/running pair and every source stop reason
other than this exact between-case hash allocation failure. It also rejects a
changed schedule, changed product, missing audit arm, unfrozen registration,
altered original/copied artifacts, or both-arm initial-exposure failure. Existing
consecutive-infrastructure-failure accounting carries across the boundary.

Changing a prompt or transform could mix treatments. Only the two named hashing
and execution modules may differ from the original freeze. Independent streaming
verification recorded all 800 original files unchanged before this repair.

The interruption may change temporal provider/cache conditions. Report the
execution boundary and this limitation; do not describe either period as an
experimentally cold/warm cohort. All original statistical methods, rates,
complete-ledger gates, quality gates and fixed sample size remain unchanged.
Any interval is conditional on this disclosed amendment and the original
independence assumptions. Do not call it an unamended preregistered result.

The original evidence remains incomplete. The amended directory includes its
22-pair prefix by byte-identical copy, with provenance retained. At completion,
report results for the fixed 70-pair schedule, the interruption, all failed
attempts, per-family losses and the previously specified sensitivities.
