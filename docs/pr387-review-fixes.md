# PR #387 review fixes

All nine original review threads were addressed:

- Release verification checkout does not persist Git credentials.
- Chat probe recovery and answer auditing covers every generated tool payload,
  including backward references; later corruption and missing/duplicate samples
  fail the audit.
- Missing Claude option values fail before another flag can be consumed.
- The installation message includes OpenCode.
- Shell profile locks record PID, start timestamp and a nonce. Normal setup
  never steals a lock. Explicit recovery verifies that the owner PID no longer
  exists, rejects unknown ownership and permission errors, and checks the lock
  identity again before removal.
- Accounting extracts only structurally located JSON/SSE usage objects, with
  bounded memory and UTF-8 handling across chunks. Assistant text and unrelated
  nested objects cannot overwrite billing counters.
- Frozen knowledge blocks remain for the proxy instance's lifetime. At capacity
  (1,000 openings), new conversations proceed without knowledge injection instead
  of evicting an existing prefix. Memory remains bounded.
- Windows edit replacement retries EPERM at most three times with short delays.
  Each retry rechecks the original; persistent errors and external edits fail
  without unlinking the target.
- Test junction cleanup removes only the link, without recursion.

## Recovering an abandoned shell profile lock

Inspect the owner information at the lock path reported by installation. From
the installed package directory, run:

```text
node scripts/recover-profile-lock.mjs "FULL_PATH_TO_PROFILE"
```

This command refuses a live/reused PID, inaccessible process status, invalid
metadata, or a changed lock. It does not recover an abandoned recovery guard;
that exceptional case requires operator inspection. Retry setup or uninstall
only after recovery succeeds.

## Validation

Six targeted suites: 51 tests passed, two platform-specific skips. Build,
changed-file lint and the repository source-format check passed. The package
gate includes the new recovery command and usage parser (30 required assets).
The real local HTTP comparison against installed HeadRoom passed the strengthened
audit for all 15 tool payloads in eight samples; corruption/reference regression
cases independently verified that the audit rejects broken later payloads.

The two formatting failures and uppercase commit subjects previously blocking
CI were also corrected. Fresh GitHub checks run on the implementation PR.
