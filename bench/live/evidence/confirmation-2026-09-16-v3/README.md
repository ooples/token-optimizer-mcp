# v3 interruption: complete prefix retained

The runner completed 22 of the fixed 70 pairs (44 attempts). Both arms passed
all 22 audited tasks. It then stopped on `RangeError: Array buffer allocation
failed` during the post-case frozen-file hash check, before starting case 23.
No task or provider failure caused this interruption. This original execution
is **incomplete**, and establishes no confirmatory superiority claim.

The verifier read whole files into buffers, including a 298,169,136-byte Codex
executable. A separate Python SHA-256 check using 64 KiB chunks verified all 800
original hashes after the stop and before any harness edit; see freeze-at-stop.json.
This establishes artifact integrity, not the exact operating-system cause of
the allocation failure. No proxy/HeadRoom child process was left running.

The original execution, protocol, freeze, schedule and all 22 paired artifacts
remain here. The same precommitted schedule continues in the adjacent
[amended execution](../confirmation-2026-09-16-v3-continuation/AMENDMENT.md),
with only the 48 unattempted pairs receiving new model calls. No replacements,
extra repetitions, product changes, or interim cost-based decisions are allowed.

Original preregistration is retained in the signed Git tag
`evidence/confirmation-v3-preregistered` (a31fd34e). Two commit subjects were
corrected for conventional-commit lint without changing any file tree.
