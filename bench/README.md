# bench/

The harness that grades this project, kept beside the code it grades so a
behaviour change and its measured effect can land in the same commit.

It runs the **real** [Token-Harness Optimizer Leaderboard][thol] harness — cloned
pinned at run time, with none of its code vendored here. The only artifacts we
own are the manifests under `thol/manifests/`, which describe how *this* product
is installed, and which are the same files we would submit upstream.

[thol]: https://github.com/pi-infected/token-harness-optimizer-leaderboard

Excluded from the npm `files` list, so users never download any of it.

## Run it

```bash
npm run bench:build

# screen: 1 rep, cheap, for triage
REPS=1 SEGMENTS_MAX=4 npm run bench:screen     # ~48 runs, ~$13, ~1h

# confirm: 3 reps, for anything published
npm run bench:confirm
```

`SEGMENTS_MAX=4` skips the last segment, whose single task
(`web-research-oss-inventory`) costs ~$5.01/run — over half the battery's total —
and discriminates poorly between tools.

## Authentication

The campaign stages a **trimmed** copy of your Claude Code credentials into
`bench/auth/` (gitignored): the `claudeAiOauth` key only, so OAuth secrets for
unrelated MCP servers stay on the host.

Credentials are re-staged **between segments** on purpose. THOL gives every run a
throwaway `HOME` and copies credentials into it, so a token refresh that happens
inside a sandbox dies with that sandbox. A full battery runs longer than an
access token lives, and without re-staging the campaign fails partway with
expired credentials.

## What the numbers mean

**Cost ratio** is a task's cost divided by the same task's cost on the `control`
arm *of the same campaign*. Ratios are comparable across campaigns; absolute
dollars are not, because campaigns pin different Claude Code versions.

**`score`** is the task verifier's 0–1 correctness, from ground truth that is
never present in the workspace. **A cost figure without its paired score is not a
result** — a compressor that eats the answer looks excellent on cost alone.

**`competitor_tool_calls` vs `tool_calls`** is the adoption signal: how much of
the work went through our tools rather than the built-ins. High adoption is not
success on its own; the tool that achieved the highest adoption on the public
board also finished second-to-last on cost.

## What it does not measure

Every run gets a throwaway `HOME` and a fresh workspace, so **the knowledge graph
starts empty on every run**, and a finding harvested at `Stop` cannot help the
session that produced it. Single-shot ratios are therefore the graph's *worst
case*, not a measurement of it. Measuring what the graph is actually for needs a
multi-session benchmark, which is separate work.

## Gotchas that cost real time

Each of these is encoded in the scripts rather than left to be rediscovered:

- **All three fixture generators must run.** THOL's `CONTRIBUTING.md` documents
  only `generate_fixtures.py`; without `gen_longtasks.py` and
  `gen_megatasks.py` the selftest aborts with `fixture 'cascade-debug' missing`.
- **Fixtures are generated once and reused.** Regeneration is not reproducible in
  practice despite the fixed seeds — repeated runs produced `cascade-debug` at
  30/44, then 25/44, then 30/44. Within one segment every arm sees the same
  files; across segments they would not, which would quietly make arms
  incomparable.
- **`/results` is a Docker named volume (`thol-results`), never a Windows bind
  mount.** Deep trees such as a django checkout cannot be deleted through a bind
  mount even from inside a Linux container. The volume is created root-owned and
  must be chowned to the container's non-root user.
- **The selftest workspace is cleared before each run.** `runner.py selftest`
  builds scratch workspaces with `shutil.copytree`, which refuses a directory
  that already exists, so a persistent `runs_root` makes the second segment die
  with `FileExistsError` before spending anything.
- **Containers are named** (`thol-campaign`) so a stray one can be found and
  killed. An unnamed container outliving its wrapper held a directory lock and
  produced two failures that looked like harness bugs.
- **The manifest needs an `mcpServers` wrapper.** Without it every run dies in
  ~1s with `Invalid MCP configuration: mcpServers: Invalid input`.
- **The optimizer version must be pinned via a pre-seeded runtime.**
  `plugin/launch.mjs` on a cold runtime serves whatever the npx cache holds, so
  an image pinned to one version can measure another.

## Reading results

Results live in the `thol-results` volume, not on the host:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v thol-results:/results \
  --entrypoint /bin/bash thol-rig:local -c \
  'sqlite3 -column -header /results/results.sqlite "
     select competitor, count(*) n, round(avg(total_cost_usd),4) mean_cost,
            round(avg(num_turns),1) turns, sum(competitor_tool_calls) own,
            sum(tool_calls) all_calls, round(avg(score),3) score
     from runs where status=\"ok\" group by competitor;"'
```

Write anything published to `bench/results/`, including the pinned Claude Code
and product versions, so a number can always be traced to what produced it.
