# Conditions before another paid comparison

The maintainer explicitly required adversarial review before further spend.
**No new paid benchmark is authorized by completing this document.** The
previous candidate failed; no numerical gate or threshold is being relaxed.

1. Independently validate evidence. Reject missing native-hook/settings/model
   records, out-of-range scores and inconsistent success flags. Match all usage
   and source hashes. Keep original failures and unknown usage visible.
2. Correct reproducible product failures offline. The qualified Python-anchor
   failure already has a no-model reproduction. Diagnose remaining unrooted and
   empty-anchor failures and the smart_edit failure separately. Do not infer a
   general solution from task pass flags.
3. Account for all 47 external products in COMPETITORS.md. Resolve unavailable
   upstreams and renamed projects; select the latest supported release or an
   immutable source commit where there is no release. Resolve monorepo tags and
   Squeez's registry/release gap. Capture artifact digests and actual binary
   versions; freeze the check date. A current source lookup is not an installed
   and qualified product.
4. Use each vendor's documented complete integration in a fresh home/workspace.
   Run free installer/config/activation tests, known-answer tool tests, failed
   call recovery and teardown checks. Prove native hooks, MCP/proxy activation
   and unchanged model routing. Fix Edgee's runtime compatibility before even
   considering a paid smoke. Do not treat an upstream unverified badge as an
   exclusion rule or count patched/configuration variants as extra products.
   Verify that these probes cannot call billable LLM, embedding or gateway
   services: mock those providers or use a documented local-only path. An
   installer or indexer is not free merely because no agent CLI was launched.
5. Define supported-client cohorts. Many latest products document Codex, but
   the existing manifests are Claude configurations. OpenCode-only and static
   CLAUDE.md integrations need faithful vendor-supported configurations or
   explicitly labelled adapted cohorts. Use the same model, reasoning level,
   task set, success checks and accounting within a cohort. Never rank different
   models/clients as if they were one matched experiment.
6. Add a true no-optimizer control alongside the current candidate. Comparing
   two optimized versions measures a product change, not savings against no
   optimizer. If the old shipped product is another arm, name it separately.
7. Isolate graders/truth from the agent runtime. Archive final workspace state
   and grader hashes for free regrading. Explicitly control live web access and
   preserve all outputs needed for audit. Separate setup, agent and grading time.
8. Review the paid design and budget before launch. A literal full matrix of
   47 products + candidate + control, 17 tasks and five reps is **4,165 runs**;
   adding our master is 4,250. This is about 24.5 times the prior 170-run count.
   At the observed 2.23024 scored credits/run, a purely illustrative linear
   extrapolation is about **9,289 estimated credits**, before failed attempts,
   setup or competitor-specific overhead. That is not an account invoice or a
   reliable forecast, and exceeds the old 1,750-credit cap. The actual eligible
   cohorts remain unknown until free qualification finishes. Do not silently
   increase the cap or decide a smaller competitor field on the user's behalf.
9. Pre-register staged exposure. Separate integration smokes, exploratory
   screening and confirmation. Cover every admitted competitor under the agreed
   design, use paired/randomized order, report quality and raw usage, and retain
   all failed attempts. Any reduced scope or early-stop selection must be explicit
   before results, with its limits reported. Reusing development tasks is not
   fresh independent validation.
10. Provide real monitoring. A supervisor must write milestone and terminal
    status, stop immediately on infrastructure failure or unknown exposure,
    account for setup/attempt costs, and generate the final report automatically.
    It must not claim chat notifications were delivered merely because a local
    file changed. Establish an actual update mechanism before detaching work.

The current code rollback at 5e74f277 is unmeasured. The optional classifier's
09eff404 source and private model remain frozen for the human-validation study.
Neither this review nor the historical competitor studies clears either gate.
