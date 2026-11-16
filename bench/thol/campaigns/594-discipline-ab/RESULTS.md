# #594 output-discipline A/B: results

**Verdict under the pre-registered rule (tag `thol-594-discab-prereg`): the block is the cause.**
The block is to be removed or rewritten before the full board.

- **Product:** `thol-rig:candidate`, token-optimizer-mcp b727e502.
- **Model:** claude-sonnet-4-6 on Claude Code 2.1.325.
- **Runs:** 45, all `ok`, all successful. Spend: $7.38.

## Median cost per task (5 reps)

| Task | Control | Ours | No-discipline | Ours / control | Nodisc / control | Nodisc / ours |
|---|---|---|---|---|---|---|
| code-bugfix-py | $0.093 | $0.105 | $0.096 | 1.13 | 1.03 | **0.91** |
| log-needle-zh | $0.141 | $0.145 | $0.138 | 1.03 | **0.98** | **0.95** |
| seo-audit | $0.255 | $0.233 | $0.243 | **0.91** | **0.95** | 1.04 |

## The rule

1. **`nodisc` below ours on at least 2 of 3 tasks: met** (bugfix and log-needle).
2. **seo-audit `Read` calls, `nodisc` at least ours in at least 4 of 5 runs: met (5 of 5).**
   Ours made 0 `Read` calls in every run; `nodisc` made 12 in two runs and 0 in three.
   - Ties count as met, so this part is weaker than it reads.
   - The decision rests mainly on part 1 and on the behaviour below.

## What the transcripts show

- **The block changes tool strategy, and the change costs turns.**
  - **bugfix:** with the block, every run made 1 or 2 extra Bash calls (`| tail -30`,
    then a separate `find` and `grep` before `Read`): 6 turns against 5.
    - Without the block, the model folded `find` and the test run into one call, as
      control does.
    - The block did not even cut output tokens here: 767 against 662 for nodisc.
  - **log-needle:** with the block, 0 of 5 runs used `Read`; they used `cat -n` and 5 to 6
    narrow greps instead. Without the block, 5 of 5 runs used `Read`, as control does.
- **Where the block helps:** output tokens on log-needle (1,195 against 1,313) and seo-audit
  (5,453 against 5,971). On seo-audit, ours was the cheapest arm.
- **The #594-check seo-audit loss (1.60x) did not reproduce.** All three arms used 6 or fewer
  turns against control's 15, and printing the HTML with Bash loops was *cheaper* than
  control's 12 `Read` calls.
  - So the theory that "avoiding `Read` costs money on seo-audit" in the earlier `RESULTS.md`
    is wrong for this task.
  - What changed between the two products (052f5a53 and b727e502) includes the in-band cut
    marker replacing the per-call bound notice, and the 3 runs of #594-check could have been
    variance. Neither cause has been tested.

## Findings recorded (each with a disposition)

1. **The output-discipline block adds turns on small tasks** (bugfix +13%, log-needle +3%
   against control). Fix in #594: remove the block, or rewrite it to keep the output-token
   guidance without steering tool choice. Needs a decision.
2. **Double pointer on an oversized `cat`** (log-needle, ours, 5 of 5 runs):
   - Claude Code persisted the 549 KB output to a file and showed a 2 KB preview. Our
     compaction marker inside that preview points to a second full copy that we wrote.
   - The result was 982 characters against the 371 of control's `Read` refusal, plus a
     duplicate artifact on disk.
   - Open item: skip the artifact write and marker when the output exceeds the host's
     persistence threshold.
3. **No hook acted wrongly.** Injected context was identical across both arms except for the
   block. No recording ask fired. Compaction fired only on log-needle's large greps.
4. **No missed savings found in tool results.** The 7-9 KB seo-audit file prints are first
   reads that the model needs whole. Nothing on these tasks was a repeat that compaction
   could fold.

Three tasks and five reps are a diagnosis, not a benchmark.
