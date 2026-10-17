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
rig in `bench/thol`. Each arm, pair and repetition gets its own empty graph
directory, mounted for that pair's two sessions only. **Calls avoided** is the
control arm's reuse tool calls minus the arm's, counted only for repetitions in
which both answered correctly: a cheap wrong answer is not a saving.

## Verifiers

Scored from ground truth in `fixtures/truth/`, which the agent never sees. A
verifier awards nothing for an empty workspace, a changed fixture file, an empty
reply, or (on `reuse`) the right answer hedged with a wrong one.

    python3 -m unittest discover -s bench/recall -p "test_*.py"

runs every verifier against answers whose score is known in advance, checks that
no workspace file or prompt states a pair's conclusion, and checks that each
fixture really carries its defect. It runs no session and spends nothing; CI
runs it on every pull request.

## Running it

    python3 bench/recall/recall.py plan out/recall --reps 3
    python3 bench/recall/recall.py run out/recall --approve-spend
    python3 bench/recall/recall.py report out/recall/results/results.sqlite

`plan` prints every docker command and spends nothing. `run` refuses without
`--approve-spend`, because every step is a real, billed Claude Code session.
The default arms are `control` and `token-optimizer-proxy-knowledge`, whose
manifest points the graph at `/proxy-graph`.

Changing a fixture? Re-hash it, or every verifier will score a real session 0:

    python3 bench/recall/hash_fixtures.py