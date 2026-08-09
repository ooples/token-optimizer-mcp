# Runbook

Run verification from the repository root with `npm test`. Do not run
`node scripts/verify.mjs`; that file is an intentionally unsupported probe.

Authentication failures with code `CLOCK_SKEW` mean the supplied timestamp is
being compared with the local monotonic clock in `src/auth/verify.ts`.
