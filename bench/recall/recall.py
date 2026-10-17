"""bench/recall: does what one session works out save the next one calls?

    python3 bench/recall/recall.py plan <out-dir> [--arms A,B] [--reps N]
    python3 bench/recall/recall.py run <out-dir> --approve-spend
    python3 bench/recall/recall.py report <results.sqlite>

Each pair is two THOL tasks run back to back on the rig (bench/thol): `derive`
works something out that the workspace does not state, then `reuse` starts a
FRESH session in a fresh copy of the same workspace and asks a question whose
answer depends on it. The knowledge graph is the one thing that may survive
from one to the other: every (arm, pair, repetition) gets its own empty graph
directory, mounted at /proxy-graph for both sessions and for nothing else, so
nothing can leak between pairs or between arms.

THE MEASUREMENT IS CALLS AVOIDED, COUNTED ONLY WHERE BOTH ARMS ARE RIGHT. The
control arm has no graph, so its reuse session must do the work again; an arm
that carries the conclusion should answer with fewer tool calls. A wrong reuse
answer is not a cheap one, so a pair counts toward calls avoided only for the
repetitions in which both arms scored 1.

`plan` writes the exact docker commands and the per-session arm-order files
and spends nothing. `run` executes them and refuses without --approve-spend,
because every session is a real Claude Code run.
"""

import argparse
import json
from contextlib import closing
import shlex
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RIG = HERE.parent / "thol"
THOL_HOME = "/home/bench/thol"
DEFAULT_ARMS = "control,token-optimizer-proxy-knowledge"


def pairs():
    records = (
        json.loads(p.read_text(encoding="utf-8"))
        for p in (HERE / "fixtures" / "truth").glob("*.json")
    )
    return sorted(records, key=lambda t: t["pair"])


def session(pair, role, arm, rep, out, image, graph):
    """One docker invocation of the rig's campaign mode for one session."""
    task = f"{pair['pair']}-{role}"
    order = out / "orders" / f"{arm}.json"
    label = f"recall {pair['pair']} {arm} rep{rep} {role}"
    mounts = [
        (RIG / "auth", "/auth", "ro"),
        (out / "results", "/results", "rw"),
        (graph, "/proxy-graph", "rw"),
        (order, "/arm-order.json", "ro"),
        (HERE / "tasks" / "_recall.py", f"{THOL_HOME}/tasks/_recall.py", "ro"),
        (HERE / "tasks" / task, f"{THOL_HOME}/tasks/{task}", "ro"),
        (HERE / "fixtures" / pair["fixture"], f"{THOL_HOME}/fixtures/out/{pair['fixture']}", "ro"),
        (
            HERE / "fixtures" / "truth" / f"{pair['pair']}.json",
            f"{THOL_HOME}/fixtures/truth/{pair['pair']}.json",
            "ro",
        ),
    ]
    command = ["docker", "run", "--rm"]
    for host, inside, mode in mounts:
        command += ["-v", f"{host}:{inside}:{mode}"]
    command += [
        "-e", "THOL_ARM_ORDER_FILE=/arm-order.json",
        "-e", f"THOL_CAMPAIGN={label}",
        image, "campaign", "-c", arm, "-t", task, "--reps", "1",
    ]
    return command


def plan(args):
    out = Path(args.out).resolve()
    arms = args.arms.split(",")
    if len(set(arms)) != len(arms) or "control" not in arms:
        sys.exit("recall: arms must be distinct and include control, which calls avoided is measured against")
    (out / "orders").mkdir(parents=True, exist_ok=True)
    (out / "results").mkdir(exist_ok=True)
    for arm in arms:
        (out / "orders" / f"{arm}.json").write_text(
            json.dumps({"arms": [arm], "orders": [[arm]]}) + "\n", encoding="utf-8"
        )
    steps = []
    for rep in range(1, args.reps + 1):
        for pair in pairs():
            for arm in arms:
                graph = out / "graphs" / f"{pair['pair']}-{arm}-rep{rep}"
                graph.mkdir(parents=True, exist_ok=True)
                for role in ("derive", "reuse"):
                    steps.append(session(pair, role, arm, rep, out, args.image, graph))
    (out / "plan.json").write_text(json.dumps(steps, indent=1) + "\n", encoding="utf-8")
    for step in steps:
        print(shlex.join(str(part) for part in step))
    print(f"\n{len(steps)} session(s) planned in {out}; nothing has run and nothing was spent.")


def run(args):
    if not args.approve_spend:
        sys.exit("recall: refusing to run without --approve-spend; every step is a real, billed Claude Code session")
    out = Path(args.out).resolve()
    steps = json.loads((out / "plan.json").read_text(encoding="utf-8"))
    for n, step in enumerate(steps, 1):
        print(f"[{n}/{len(steps)}] {step[step.index('-t') + 1]} as {step[step.index('-c') + 1]}", flush=True)
        if subprocess.run(step).returncode != 0:
            sys.exit(f"recall: step {n} failed; the steps before it are recorded and the plan can be re-run from it")


def report(args):
    with closing(sqlite3.connect(args.results)) as db:
        rows = db.execute(
            "SELECT competitor, task, rep, score, tool_calls, num_turns, total_cost_usd FROM runs "
            "WHERE task LIKE 'recall-%-reuse' AND status = 'ok'"
        ).fetchall()
    by = {}
    for arm, task, rep, score, calls, turns, cost in rows:
        by.setdefault(task, {}).setdefault(arm, {})[rep] = (score, calls, turns, cost)
    print("pair              arm                               right  calls  turns   cost  avoided")
    for task in sorted(by):
        control = by[task].get("control", {})
        for arm in sorted(by[task]):
            runs = by[task][arm]
            both = [r for r in runs if r in control and runs[r][0] == 1 and control[r][0] == 1]
            avoided = (
                sum(control[r][1] - runs[r][1] for r in both) / len(both)
                if both and arm != "control" else None
            )
            right = sum(1 for r in runs.values() if r[0] == 1)
            mean = lambda i: sum(r[i] or 0 for r in runs.values()) / len(runs)
            print(
                f"{task[:-6]:17} {arm:33} {right}/{len(runs):<4} {mean(1):6.1f} {mean(2):6.1f} "
                f"{mean(3):6.3f}  {'-' if avoided is None else f'{avoided:.1f} over {len(both)}'}"
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan")
    p.add_argument("out")
    p.add_argument("--arms", default=DEFAULT_ARMS)
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--image", default="thol-rig:local")
    r = sub.add_parser("run")
    r.add_argument("out")
    r.add_argument("--approve-spend", action="store_true")
    q = sub.add_parser("report")
    q.add_argument("results")
    args = parser.parse_args()
    {"plan": plan, "run": run, "report": report}[args.command](args)


if __name__ == "__main__":
    main()