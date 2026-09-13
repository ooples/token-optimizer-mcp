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
import random
import sqlite3
import statistics
import sys

DB = sys.argv[1]
BASELINE = sys.argv[2] if len(sys.argv) > 2 else "control"
METRICS = ("total_cost_usd", "num_turns", "score")

con = sqlite3.connect(DB)

arms = [r[0] for r in con.execute(
    "SELECT DISTINCT competitor FROM runs WHERE status='ok' ORDER BY 1")]
tasks = [r[0] for r in con.execute(
    "SELECT DISTINCT task FROM runs WHERE status='ok' ORDER BY 1")]

# cell[(arm, task)] = {metric: mean, 'n': reps}
cell = {}
for arm in arms:
    for task in tasks:
        row = con.execute(
            "SELECT COUNT(*), AVG(total_cost_usd), AVG(num_turns), AVG(score) "
            "FROM runs WHERE status='ok' AND competitor=? AND task=?",
            (arm, task)).fetchone()
        if row[0]:
            cell[(arm, task)] = {
                "n": row[0],
                "total_cost_usd": row[1],
                "num_turns": row[2],
                "score": row[3],
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
            if not a or not b or not b[metric]:
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
