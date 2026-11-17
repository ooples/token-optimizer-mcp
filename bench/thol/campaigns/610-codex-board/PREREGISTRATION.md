# Task categorization: Codex comparison

Written before task measurements. The user clarified on 2026-11-17 that the
plan permits any AI CLI. Claude's exhausted quota blocks the old Claude
campaign, not this work. Its 17 account refusals remain separate and are not
measurements. This campaign supersedes that CLI dependency without pooling
results from different clients or models.

## Frozen comparison

- Candidate #610: `6c3bd71d52e7ae65d496e9b0100f474bcada5c3b`, tree
  `55cfe5467358a265bf609b4dd232a8e2e8cd9a4c`.
- Baseline: `1518a5d7c41f342e65dd10c89ee2595826607828`, tree
  `8b68d518a20e069fa09bc39c6fffff737ff7edf6`.
- Codex CLI `0.169.0`, model `gpt-6.1-sol`, reasoning effort `high` in both.
  A no-tools availability preflight succeeded before this protocol was written.
- Same 17 tasks, source fixtures and independent THOL graders as `610-board`.
  Five repetitions per product, alternating candidate/baseline order by rep.
- Identical pinned Codex installation added to the two existing product images.
  Fresh per-run HOME, Codex config, optimizer state and task workspace.
  Credentials are mounted read-only and never copied into evidence or images.
- Use each product's shipped Codex hook entries and MCP server. Audit wrapper
  records each native hook input/output while forwarding them unchanged. No
  simulated prompt classification or hand-injected category instructions.
- Before measurements, prove the live CLI invokes the prompt hook and selects
  the expected changed settings. Unsupported events or absent hooks are a failed
  integration preflight, not evidence that categorization ran.
- Optional learned classifier #611 is not enabled or changed by this campaign.
  Its source/model and independent human-validation protocol remain frozen.

## Metrics and gates

Codex JSONL `turn.completed.usage` supplies input, cached-input and output
tokens. Input includes cached tokens: uncached = input minus cached. Preserve
reasoning tokens separately when available. They must not be added to an
output total that already includes them. These are provider-reported tokens,
not actual subscription billing. Preserve time, task scores, successes, native
hook invocations, observed categories and settings, and all attempts.

Primary comparison: geometric mean of per-task median **estimated standard
Codex credits**, candidate / baseline, <= 1.00 with no lower summed success
rate. The matching GPT-6.1 Sol rates were checked before scored tasks at
https://developers.openai.com/codex/pricing on 2026-11-17: 50 / 2.5 / 250 credits
per million uncached-input / cached-input / output tokens. `rate-card.json`
freezes that scenario. It makes no claim about the user's actual invoice or
included subscription allowance. Also report total tokens and uncached input,
cached input and output separately. Do not reuse GPT-6 Astra's cached rate.

Category thresholds retain the old protocol: survey/rewrite >1.03 require
removing the override; unchanged fix/build/locate >1.05 require investigation.
Read transcripts for task ratios outside [0.67, 1.5] before a verdict. Report
five-repetition variability and the one-task limits for rewrite/locate.

The default 10% task-settings holdout remains enabled and its observed share
is reported. It dilutes the candidate's effect. Preflight may explicitly disable
holdout solely to prove that each changed settings row is reachable.

Infrastructure failures remain visible, stop the campaign for diagnosis, and
never count as free successes. Repaired infrastructure requires a recorded
amendment before retry; retain original attempts. No aggregate verdict until
all 170 task measurements are valid. Stop at 1,750 estimated standard credits
or 8 hours of agent time, checked after every run, with no automatic retries.
This is an exposure cap, not a claim about actual subscription charges.

## Preflight correction (before scored tasks)

The first survey probe invoked the raw package entries but found no category
ledger. The package deliberately composes client libraries at installation,
so calling those entries without the documented installer leaves them inert.
The harness now runs `install-client-hooks.mjs --client codex --dest ...`
before wiring the installed hooks. The failed probe and its reported usage
are retained as setup evidence, outside the scored battery. Codex HOME also
moves outside `/tmp`, where Codex refuses to create its helper aliases.

All runs share the existing candidate campaign's read-only fixture and pinned
repository volume. This prevents independent fixture regeneration from adding
differences between the products; product state remains fresh for each run.
