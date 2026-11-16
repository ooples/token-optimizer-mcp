"""Analyse a pre-registered campaign: per-task paired ratios, bootstrap CIs.

WHY NOT A RUN-WEIGHTED MEAN. The obvious `avg(cost) group by competitor` is
wrong whenever arms do not have identical task coverage, and it was wrong here:
comparing a 17-run arm against a 48-run arm made `assist` look 9% cheaper than
control when the per-task paired figure was ~3%. The tasks differ in cost by an
order of magnitude, so a mean over an unmatched task set is mostly a statement
about which tasks each arm happened to run.

So every comparison is PAIRED BY TASK: compute each arm's mean on a task, take
the ratio against the baseline arm on that SAME task, and summarise the ratios.
A task missing from either arm is dropped from that comparison and reported.

The CI is a bootstrap over tasks (resampling which tasks are in the study, not
which runs), which is the axis the generalisation is over: "does this hold on
coding tasks", not "does this hold on these sixteen".

Usage:
    python bench/thol/analyse-campaign.py <results.sqlite> [baseline-arm]
"""

import json
import os
import random
import sqlite3
import statistics
import sys

DB = sys.argv[1]
BASELINE = sys.argv[2] if len(sys.argv) > 2 else "control"
METRICS = ("total_cost_usd", "cold_start_cost_usd", "num_turns", "score")

# COLD-START COST: THE FIRST REQUEST PRICED WITHOUT ANOTHER RUN'S CACHE.
#
# A run's first request can read its whole tool + system prefix from a cache
# entry some EARLIER run wrote. Arms are interleaved per task, so the arms that
# send plain Claude Code's prefix keep one shared entry warm for each other,
# and control rides on it. An arm whose prefix the server does not match -- for
# any reason, including server-side cache placement nobody outside can see --
# writes its prefix fresh every run. In #565 that alone was 0.057 of
# token-optimizer's 1.149 ratio and 0.070 of headroom-cache's 1.080, while
# its request prefix was byte-identical to control's when captured locally. No
# real user shares a cache with another product's sessions, so this is the
# rig's effect, not the arm's. Every arm's first request is repriced as if
# nothing earlier had been cached: its cache reads billed as cache writes at
# the tier it wrote at. Later requests are untouched -- they read what this run
# itself wrote. total_cost_usd stays the primary endpoint; this is the
# secondary one, pre-registered for every campaign after #565's first.
INPUT_USD_PER_MTOK = (
    # (model-id prefix, base input $/MTok). Longest prefix wins.
    ("claude-sonnet-", 3.0),
    ("claude-opus-4-5", 5.0), ("claude-opus-4-6", 5.0), ("claude-opus-4-7", 5.0),
    ("claude-opus-5", 5.0),
    ("claude-haiku-4-5", 1.0), ("claude-haiku-5", 1.0),
)


def input_price(model):
    hits = [p for prefix, p in sorted(INPUT_USD_PER_MTOK, key=lambda x: -len(x[0]))
            if model.startswith(prefix)]
    if not hits:
        raise SystemExit(f"no input price for model {model!r}: add it to "
                         "INPUT_USD_PER_MTOK rather than guessing")
    return hits[0]


def model_requests(run_id):
    """(usage, model) of every model request in the run, in order."""
    path = os.path.join(os.path.dirname(os.path.abspath(DB)), "artifacts",
                        run_id, "transcript.jsonl")
    if not os.path.exists(path):
        # A results file copied without its artifacts still has a primary
        # endpoint; only this one is unavailable, and the table says so.
        return None
    requests = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("type") == "assistant":
                msg = entry["message"]
                requests.append((msg.get("usage") or {}, msg.get("model") or ""))
    if not requests:
        raise SystemExit(f"run {run_id} has no model request in {path}")
    return requests


def written_tiers(usage):
    tiers = usage.get("cache_creation") or {}
    return {name for name, key in (("1h", "ephemeral_1h_input_tokens"),
                                   ("5m", "ephemeral_5m_input_tokens"))
            if tiers.get(key, 0) > 0}


WRITE_MULTIPLIER = {"5m": 1.25, "1h": 2.0}


def cold_start_cost(run_id, total_cost):
    requests = model_requests(run_id)
    if requests is None:
        return None
    usage, model = requests[0]
    read = usage.get("cache_read_input_tokens", 0)
    if read == 0:
        return total_cost
    # The transcript does not record the TTL a request asked for, only the
    # tiers it wrote at. A creation counter of zero says nothing was new, not
    # which TTL the cached prefix carries, so a fully warm first request
    # cannot be priced from its own counters. Its TTL is taken from the tier
    # it wrote at; failing that, from the one tier the run's other requests
    # wrote at. With no write, or writes at both tiers and none on the first
    # request, the TTL is unknown and the run's cold start is unavailable
    # rather than guessed.
    tiers = written_tiers(usage)
    if not tiers:
        for later, _ in requests[1:]:
            tiers |= written_tiers(later)
    if len(tiers) != 1:
        return None
    multiplier = WRITE_MULTIPLIER[tiers.pop()]
    return total_cost + read * (multiplier - 0.1) * input_price(model) / 1e6


con = sqlite3.connect(DB)

arms = [r[0] for r in con.execute(
    "SELECT DISTINCT competitor FROM runs WHERE status='ok' ORDER BY 1")]
tasks = [r[0] for r in con.execute(
    "SELECT DISTINCT task FROM runs WHERE status='ok' ORDER BY 1")]

# REFUSE A BASELINE THAT RAN NOTHING, rather than reporting every arm as having
# "no paired tasks" and exiting 0. A misspelled arm name, or one whose runs all
# failed, produced a clean-looking report in which every comparison was empty --
# indistinguishable at a glance from a campaign where nothing differed, and the
# exit code agreed with that reading. The whole file is a comparison AGAINST
# this arm, so its absence is not a degraded result, it is no result.
if BASELINE not in arms:
    print(f"baseline arm {BASELINE!r} has no successful runs in {DB}.",
          file=sys.stderr)
    print(f"  arms present: {', '.join(arms) if arms else '(none)'}",
          file=sys.stderr)
    print("  every comparison here is against the baseline, so there is "
          "nothing to report.", file=sys.stderr)
    sys.exit(2)

# cell[(arm, task)] = {metric: mean, 'n': reps}
cell = {}
for arm in arms:
    for task in tasks:
        rows = con.execute(
            "SELECT run_id, total_cost_usd, num_turns, score "
            "FROM runs WHERE status='ok' AND competitor=? AND task=?",
            (arm, task)).fetchall()
        if rows:
            cold = [cold_start_cost(r[0], r[1]) for r in rows]
            cell[(arm, task)] = {
                "n": len(rows),
                "total_cost_usd": statistics.mean(r[1] for r in rows),
                # One run without a transcript makes the cell unknown, not
                # the mean of the rest: a partial mean is a different sample.
                "cold_start_cost_usd": None if None in cold else statistics.mean(cold),
                "num_turns": statistics.mean(r[2] for r in rows),
                "score": statistics.mean(r[3] for r in rows),
            }


def bootstrap_ci(values, iters=10000, seed=20260913):
    """Percentile CI over TASKS. Seeded, so the interval is reproducible."""
    if len(values) < 2:
        return (float("nan"), float("nan"))
    rng = random.Random(seed)
    means = []
    for _ in range(iters):
        sample = [values[rng.randrange(len(values))] for _ in values]
        means.append(statistics.mean(sample))
    means.sort()
    return (means[int(0.025 * iters)], means[int(0.975 * iters)])


print(f"baseline: {BASELINE}")
print(f"arms: {len(arms)}   tasks: {len(tasks)}")

# Coverage first: a comparison over a subset must say so, not quietly average.
print("\ncoverage (tasks with >=1 ok run, and total reps):")
for arm in arms:
    cells = [c for (a, t), c in cell.items() if a == arm]
    reps = sum(c["n"] for c in cells)
    print(f"  {arm:<26} {len(cells):>2}/{len(tasks)} tasks  {reps:>3} runs")

for metric in METRICS:
    print(f"\n=== {metric}, paired by task, ratio vs {BASELINE} ===")
    print(f"{'arm':<26} {'tasks':>5} {'mean':>7} {'median':>7} "
          f"{'95% CI':>16} {'min':>6} {'max':>6}")
    for arm in arms:
        if arm == BASELINE:
            continue
        ratios = []
        for task in tasks:
            a, b = cell.get((arm, task)), cell.get((BASELINE, task))
            if not a or not b or a[metric] is None or not b[metric]:
                continue
            ratios.append(a[metric] / b[metric])
        if not ratios:
            print(f"{arm:<26} {'-':>5}  no paired tasks")
            continue
        lo, hi = bootstrap_ci(ratios)
        # A CI spanning 1.0 is NOT a direction. Said in the output rather than
        # left for the reader to notice.
        flag = "" if (lo > 1.0 or hi < 1.0) else "   (spans 1.0: no detectable difference)"
        print(f"{arm:<26} {len(ratios):>5} {statistics.mean(ratios):>7.3f} "
              f"{statistics.median(ratios):>7.3f} "
              f"{'[%.3f, %.3f]' % (lo, hi):>16} "
              f"{min(ratios):>6.2f} {max(ratios):>6.2f}{flag}")

# Q4 is a single pre-registered cell, so it is printed explicitly rather than
# left to be eyeballed out of a table.
print("\n=== Q4: report-pdf score by arm (fix confirmed only at >= 0.9) ===")
for arm in arms:
    c = cell.get((arm, "report-pdf"))
    if c:
        print(f"  {arm:<26} score {c['score']:.2f}  (n={c['n']})")

print("\nper-task detail:")
detail = {}
for (arm, task), c in cell.items():
    detail.setdefault(task, {})[arm] = round(c["total_cost_usd"], 4)
print(json.dumps(detail, indent=2, sort_keys=True))
