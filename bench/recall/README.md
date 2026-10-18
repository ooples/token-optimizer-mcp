# bench/recall: calls avoided across sessions

Does what one session works out save the next session tool calls? Every
single-session benchmark, THOL included, is blind to this by construction:
each run starts from nothing. This one runs sessions in pairs.

| half     | asks                                                            |
| -------- | --------------------------------------------------------------- |
| `derive` | work something out that the workspace does not state            |
| `reuse`  | a fresh session, fresh workspace: a question that depends on it |

Three pairs, each a real defect in a small standard-library Python project:

| pair             | fixture    | derived                                  | reused                                    |
| ---------------- | ---------- | ---------------------------------------- | ----------------------------------------- |
| `recall-tz`      | `tzbook`   | day buckets use the machine's local time | the variable CI sets to make it pass      |
| `recall-quota`   | `quotasvc` | a window documented in s is read in ms   | the value that gives a 90-second window   |
| `recall-migrate` | `migrun`   | migrations sort as strings               | which migration a fresh database runs first |

The tasks are THOL tasks (`prompt.md`, `task.json`, `verify.py`) and run on the
rig in `bench/thol`. Each arm, pair and repetition is one unit: every attempt
at it gets a new directory with an empty graph and its own THOL results
volume, shared by that unit's two sessions only. **Calls avoided** is the
control arm's reuse tool calls minus the arm's, counted only for repetitions in
which both answered correctly: a cheap wrong answer is not a saving.

**The truth never enters a session's container.** THOL runs the agent and its
verifier as one user on one filesystem, so a mounted truth file is one the
agent could read. None is mounted: in the container the verifier records a
deferred 0, workspaces are kept, and `score` re-runs every verifier on the host.

## Verifiers

Scored from ground truth in `fixtures/truth/`, which the agent never sees. A
verifier awards nothing for an empty workspace, a fixture file changed, removed
or added, an empty reply, a `derive` explanation that states the cause in the
right words but denies it, or a `reuse` answer hedged with a wrong one.

    python3 -m unittest discover -s bench/recall -p "test_*.py"

runs every verifier against answers whose score is known in advance, checks that
no workspace file or prompt states a pair's conclusion, and checks that each
fixture really carries its defect. It runs no session and spends nothing; CI
runs it on every pull request.

## Running it

    python3 bench/recall/recall.py plan out/recall --reps 3
    python3 bench/recall/recall.py run out/recall --approve-spend
    python3 bench/recall/recall.py score out/recall
    python3 bench/recall/recall.py report out/recall

`plan` needs a new directory and prints every docker command; it spends
nothing. `run` refuses without `--approve-spend`, because every session is a
real, billed Claude Code session. Re-running `run` after a failure skips every
finished unit and restarts the failed one from an empty graph. `--campaign` is
THOL's Claude Code version pin, not a label.
The default arms are `control` and `token-optimizer-proxy-knowledge`, whose
manifest points the graph at `/proxy-graph`.

Changing a fixture? Re-hash it, or every verifier will score a real session 0:

    python3 bench/recall/hash_fixtures.py