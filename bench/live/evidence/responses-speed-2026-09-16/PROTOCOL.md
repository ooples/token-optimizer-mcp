# Responses speed follow-up — 2026-09-16

Fixed development schedule before provider calls:
- Actual installed HeadRoom 0.37.0 versus our proxy, Codex local, default model and reasoning.
- heldout-v1 json with REPEAT_READS=3, seeds 3141592301 and 3141592302.
- heldout-v1 refresh with REPEAT_READS=1, seeds 1618034101 and 1618034102.
- Two repetitions per group; proxy/headroom order rotates through the existing harness.
- Natural reads, tool-code experiment disabled. No retries or excluded failures.
- Report validator outcomes, estimated cost, agent elapsed time and per-request timing.
- Four pairs are diagnostic development evidence, not proof of universal speed superiority.
- Local baseline is 5d749774. The change reuses exact token counts and shell envelope metadata with bounded caches. No token threshold or representation change.

Local replay: four alternating before/after process pairs, ten captured requests each, twelve warm passes. Every output SHA-256 agrees. Allocation sampling is a separate single process per arm, 150 calls, 32 MiB V8 old-space cap; it does not measure native/WASM allocation or peak RSS.
