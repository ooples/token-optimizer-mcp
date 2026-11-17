# Findings and dispositions

| Finding | Evidence | Disposition |
|---|---|---|
| Reinstall image omitted the local rewrite task | Preflight could not read its prompt; master contained it | Fixed the reinstall recipe to copy local tasks, then checked all 17 prompts inside the rebuilt image. No paid runs had started. |
| Slicing the order plan changes resume identity | Setup rejected the per-repetition file checksum | Added explicit prefix permission to the committed full plan; validate the complete plan and execute its prefix without changing the checksum. Four wrapper tests pass; the same wrapper is installed in both images. Preserved the old setup-only volumes. |
| A JavaScript comment in a shell string executed its backticks | Entrypoint printed a shell command-not-found error | Removed the comment's backticks in both images; no product or measurement logic changed. |
| Model account has exhausted weekly usage | 17 candidate attempts returned the weekly-limit message and $0 cost | Stopped the campaign, retained the refusal records, and withheld every aggregate/ship verdict. Await quota reset or a configured same-model API route. |
| Fixture accuracy overstates conversational coverage | Separate session-split model-consensus replay: 147/487 prompt-only, 155/487 contextual | Report this limitation explicitly. Human labels remain local and are collected without showing model predictions. Do not treat regression tests or this replay as an independent production-accuracy claim. |

No task-cost outlier can be reviewed yet because no valid comparative task
measurements exist. The threshold decisions in PREREGISTRATION.md are pending,
not passed. Any later product changes need a new recorded candidate identity.
