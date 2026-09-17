# Exporting v7 verification records

Keep raw logs and private proof records outside the tracked `docs/` directory.
Export public receipts through the shared writer:

```sh
node scripts/export-v7-proof.mjs <private-proof.json> docs/v7-installed-live-proof.json
node scripts/export-v7-proof.mjs <private-proof.json> docs/v7-postrelease-live-proof.json
```

Generators can import `writeV7Proof` from `scripts/export-v7-proof.mjs` instead.
The exporter replaces `runtime`, `root`, `launch`, and `work` location fields,
including nested records, with neutral placeholders. It preserves hashes,
versions, request routes, and measured results, and does not change private inputs.
Review other free-text fields before publishing; this is location redaction for
these receipts, not a general-purpose log sanitizer.
