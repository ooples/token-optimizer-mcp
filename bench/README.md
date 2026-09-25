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
arm *of the same campaign*. Ratios are comparable across campaigns **only when
those campaigns share the same `THOL_REV`, task set, fixtures and scoring** --
the ruler has to be the same for two measurements of it to mean anything.
Absolute dollars are never comparable, because campaigns pin different Claude
Code versions. A `THOL_REV` bump therefore starts a new campaign whose numbers
do not line up with the previous one; see the publishing section below.
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

## Publishing a result

Write reports to `bench/results/` and **commit them**. `bench/.gitignore`
excludes `results/runs/` and `*.sqlite` — the large machine-written run data,
reproducible from a campaign — but not the reports themselves: a number nobody
can trace to the versions that produced it is not evidence.

Every report records the three things that make it reproducible:

| field | where it comes from | why it is not enough alone |
| --- | --- | --- |
| `tree` | git tree hash of exactly what `bench:pack` packed | the identity of record |
| `dirty` | whether the working tree had uncommitted changes | a dirty tree is not the commit |
| `head` / `branch` | the commit and branch it was built from | **cannot** identify a dirty input |
| Claude Code version | `CLAUDE_VERSION` in `thol/Dockerfile` | |
| THOL revision | `THOL_REV` in `thol/Dockerfile` | |

**`tree` is the identity, not `head`.** `bench:build` packs the WORKING TREE, so
two reports can share a commit and still have been built from different inputs.
The tree hash is what tells them apart, and `dirty` is what warns you that the
commit alone would mislead. Both are written to
`results/provenance-<campaign>.json` by every campaign.
**`THOL_REV` is pinned on purpose.** The harness is half of every measurement, so
cloning its default branch would let their task, fixture or scoring changes move
our numbers with nothing here having changed. Bumping it is a deliberate act that
starts a **new campaign**: results either side of a bump are not comparable, and
mixing them is exactly what the pin prevents. Record the bump next to the results
it produced.

## subscription/ — what a subscription is actually charged

Everything else here counts tokens with a local tokeniser and prices them with
the constants in `compression/cost-model.mjs`. Those constants (`cacheWrite:
1.25`, `cacheRead: 0.1`, `outputPerInput: 5`) are API list prices restated as if
they were a subscription's exchange rate, and until this directory existed
nothing had ever checked that. `bench/subscription/` checks it against the meter
a Claude subscription is actually rationed by.

Two instruments, neither of which spends quota:

| | what it gives | what it cannot give |
| --- | --- | --- |
| `meter.mjs` — `GET /api/oauth/usage` | the real metered quantity | whole percent only; `limit_dollars` is null on Max |
| `transcripts.mjs` — `~/.claude/projects/**/*.jsonl` | exact per-request `usage`, split five ways | says nothing about how the meter weights them |

`observe.mjs` pairs them into one line of `observations.jsonl`; `calibrate.mjs`
fits weights to those lines.

### The runbook

```bash
npm run bench:subscription:check      # solver self-test, synthetic, no network
npm run bench:subscription:observe    # one free reading -> observations.jsonl
npm run bench:subscription:calibrate  # fit, once enough readings exist
```

To measure a workload, bracket it:

```bash
node bench/subscription/observe.mjs --label before-<workload>
#   ... run the workload ...
node bench/subscription/observe.mjs --label after-<workload>
```

**The quantum sets the minimum experiment.** The meter reports whole percent, so
a workload that moves the five-hour window by less than 1 is invisible however
precisely its tokens were counted. On a Max 20x plan 1% is roughly 1.5M
cache-read-equivalent tokens — a real session, not a single request. Runs
smaller than that produce rows `calibrate.mjs` will correctly refuse to fit.

**Run it with the machine idle.** A transcript row is written after its response
completes, so a reading taken seconds after a live turn can miss requests the
meter has already counted. `observe.mjs` records `secondsSinceLastRequest` and
`requestsLast10Min` so a contaminated reading is identifiable rather than
invisible; the session doing the observing burns the same window it is reading.

### What it will and will not tell you

It solves for `theta = 100 * w / L`, not for `w`. The cap `L` is null on this
plan, so weights are only ever recoverable up to a common factor — which is
enough, because every claim the benchmark makes is a ratio and the factor
cancels. It is **not** enough to print "this workload cost $N", and the rig
never does.

Three states, not two, and the report distinguishes them:

- **solved** — a weight with a standard error small enough to use.
- **unidentifiable** — no observation moved the coordinate (on a machine that
  only ever writes 1h cache entries, `cacheWrite5m` is permanently here), or it
  moved only in lockstep with another. Reported by name, never by value.
- **identifiable but imprecise** — moved, but by far less than the 1% quantum.
  This is where `input` sits on a normal Claude Code workload, buried under cache
  reads three orders of magnitude larger. A number is printed with its error bar
  and flagged `TOO IMPRECISE TO PUBLISH`.

The default fit uses **differences** between consecutive readings inside one
window. Usage from claude.ai, another machine on the same subscription, or any
client that writes no transcript lands on the meter and never on this disk; in a
delta a steady unobserved baseline cancels, in a level fit it biases every
weight. `--levels` runs the level fit as a cross-check — agreement is evidence,
disagreement localises the problem to coverage.
