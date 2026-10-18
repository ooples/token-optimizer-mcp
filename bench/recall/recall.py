"""bench/recall: does what one session works out save the next one calls?

    python3 bench/recall/recall.py plan <new-out-dir> [--arms A,B] [--reps N]
    python3 bench/recall/recall.py run <out-dir> --approve-spend
    python3 bench/recall/recall.py score <out-dir>
    python3 bench/recall/recall.py report <out-dir>

Each pair is two THOL tasks run back to back on the rig (bench/thol): `derive`
works something out that the workspace does not state, then `reuse` starts a
FRESH session in a fresh copy of the same workspace and asks a question whose
answer depends on it. The knowledge graph is the one thing that may survive
from one to the other.

ONE UNIT = ONE PAIR, ONE ARM, ONE REPETITION, AND IT IS ATOMIC. Every attempt
at a unit gets a new directory holding a new, empty graph and its own THOL
results volume. Its own volume because THOL resumes by skipping any
(competitor, task, rep) already recorded at the same Claude Code version, and
every session here is `--reps 1`: in a shared volume the second repetition of
a task would be skipped as done. A unit is recorded as done only when both of
its sessions finished; `run` skips done units, so re-running after a failure
repeats no completed (billed) unit, and the failed one starts again from an
empty graph rather than inheriting what half of it wrote.

THE TRUTH NEVER ENTERS A SESSION'S CONTAINER. THOL runs the agent and its
verifier as one user on one filesystem, so a mounted truth file is one the
agent can read. No truth is mounted; the in-container verifier records a
deferred 0, workspaces are kept (`--keep-workspaces`), and `score` runs each
verifier on the host against the kept workspace and answer. `report` uses
those scores only.

THE MEASUREMENT IS CALLS AVOIDED, COUNTED ONLY WHERE BOTH ARMS ARE RIGHT. The
control arm has no graph, so its reuse session must do the work again. A wrong
reuse answer is not a cheap one, so a repetition counts toward calls avoided
only when both arms' reuse answers scored 1.

`plan` spends nothing. `run` refuses without --approve-spend, because every
session is a real, billed Claude Code session.
"""

import argparse
import json
import os
import shlex
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

HERE = Path(__file__).resolve().parent
RIG = HERE.parent / "thol"
THOL_HOME = "/home/bench/thol"
DEFAULT_ARMS = "control,token-optimizer-proxy-knowledge"
# THOL_CAMPAIGN IS A VERSION PIN, NOT A LABEL: runner.py exits unless the
# installed Claude Code's `--version` starts with it. Same default as
# bench/thol/run-campaign.sh.
DEFAULT_CAMPAIGN = "2.1.251 (Claude Code)"
ROLES = ("derive", "reuse")


def pairs():
    records = (
        json.loads(p.read_text(encoding="utf-8"))
        for p in (HERE / "fixtures" / "truth").glob("*.json")
    )
    return sorted(records, key=lambda t: t["pair"])


def session(unit, role, attempt_dir, out, plan):
    """One docker invocation of the rig's campaign mode for one session."""
    task = f"{unit['pair']}-{role}"
    mounts = [
        (RIG / "auth", "/auth", "ro"),
        (attempt_dir / "results", "/results", "rw"),
        (attempt_dir / "graph", "/proxy-graph", "rw"),
        (out / "orders" / f"{unit['arm']}.json", "/arm-order.json", "ro"),
        (HERE / "tasks" / "_recall.py", f"{THOL_HOME}/tasks/_recall.py", "ro"),
        (HERE / "tasks" / task, f"{THOL_HOME}/tasks/{task}", "ro"),
        (HERE / "fixtures" / unit["fixture"], f"{THOL_HOME}/fixtures/out/{unit['fixture']}", "ro"),
    ]
    command = ["docker", "run", "--rm"]
    for host, inside, mode in mounts:
        command += ["-v", f"{host}:{inside}:{mode}"]
    command += [
        "-e", "THOL_ARM_ORDER_FILE=/arm-order.json",
        "-e", f"THOL_CAMPAIGN={plan['campaign']}",
        plan["image"], "campaign",
        "-c", unit["arm"], "-t", task, "--reps", "1", "--keep-workspaces",
    ]
    return command


def load(out):
    return json.loads((out / "plan.json").read_text(encoding="utf-8"))


def progress(out):
    path = out / "progress.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"done": {}, "attempts": {}}


def save_progress(out, state):
    tmp = out / "progress.json.tmp"
    tmp.write_text(json.dumps(state, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, out / "progress.json")


def plan(args):
    out = Path(args.out).resolve()
    # A NEW DIRECTORY, ALWAYS. Re-planning into an old one would hand the next
    # derive session whatever graph the last plan's sessions wrote.
    if out.exists() and any(out.iterdir()):
        sys.exit(f"recall: {out} is not empty; plan into a new directory")
    arms = args.arms.split(",")
    if len(set(arms)) != len(arms) or "control" not in arms:
        sys.exit("recall: arms must be distinct and include control, which calls avoided is measured against")
    (out / "orders").mkdir(parents=True)
    for arm in arms:
        (out / "orders" / f"{arm}.json").write_text(
            json.dumps({"arms": [arm], "orders": [[arm]]}) + "\n", encoding="utf-8"
        )
    units = [
        {"id": f"{p['pair']}-{arm}-rep{rep}", "pair": p["pair"], "fixture": p["fixture"], "arm": arm, "rep": rep}
        for rep in range(1, args.reps + 1)
        for p in pairs()
        for arm in arms
    ]
    record = {"campaign": args.campaign, "image": args.image, "units": units}
    (out / "plan.json").write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    for unit in units:
        for role in ROLES:
            print(shlex.join(str(part) for part in session(unit, role, out / "units" / unit["id"] / "try1", out, record)))
    print(f"\n{len(units)} unit(s), {2 * len(units)} session(s) planned in {out}; nothing has run and nothing was spent.")


def run(args, execute=subprocess.run):
    if not args.approve_spend:
        sys.exit("recall: refusing to run without --approve-spend; every step is a real, billed Claude Code session")
    out = Path(args.out).resolve()
    record = load(out)
    state = progress(out)
    for n, unit in enumerate(record["units"], 1):
        if unit["id"] in state["done"]:
            continue
        attempt = state["attempts"].get(unit["id"], 0) + 1
        state["attempts"][unit["id"]] = attempt
        save_progress(out, state)
        attempt_dir = out / "units" / unit["id"] / f"try{attempt}"
        (attempt_dir / "graph").mkdir(parents=True)
        (attempt_dir / "results").mkdir()
        for role in ROLES:
            print(f"[{n}/{len(record['units'])}] {unit['id']} {role} (attempt {attempt})", flush=True)
            if execute(session(unit, role, attempt_dir, out, record)).returncode != 0:
                sys.exit(
                    f"recall: {unit['id']} {role} failed. Completed units are recorded; run again "
                    "to resume, and this unit restarts from an empty graph."
                )
        # A ZERO EXIT IS NOT A RECORDED SESSION. THOL exits 0 after a run it
        # recorded as a timeout or a claude_error too, and `score` reads only
        # `ok` rows, so a unit marked done here with a role missing would be
        # scored on one session and never retried.
        missing = [role for role in ROLES if role not in ok_roles(attempt_dir, unit["pair"])]
        if missing:
            sys.exit(
                f"recall: {unit['id']} has no ok run for {', '.join(missing)}. Completed units are "
                "recorded; run again to resume, and this unit restarts from an empty graph."
            )
        state["done"][unit["id"]] = attempt_dir.relative_to(out).as_posix()
        save_progress(out, state)


def ok_roles(attempt_dir, pair):
    """The roles of `pair` that THOL recorded as ok in this attempt's volume."""
    db_path = attempt_dir / "results" / "results.sqlite"
    if not db_path.is_file():
        return set()
    with closing(sqlite3.connect(db_path)) as db:
        try:
            tasks = {t for (t,) in db.execute("SELECT task FROM runs WHERE status = 'ok'")}
        except sqlite3.OperationalError:
            return set()
    return {role for role in ROLES if f"{pair}-{role}" in tasks}


def sessions_of(out, unit_dir):
    """THOL's rows for one attempt, with where each run's workspace and answer are."""
    results = out / unit_dir / "results"
    with closing(sqlite3.connect(results / "results.sqlite")) as db:
        rows = db.execute(
            "SELECT run_id, task, tool_calls, num_turns, total_cost_usd FROM runs WHERE status = 'ok'"
        ).fetchall()
    for run_id, task, calls, turns, cost in rows:
        yield {
            "run_id": run_id, "task": task, "calls": calls, "turns": turns, "cost": cost,
            "workspace": results / "runs" / run_id / "workspace",
            "answer": results / "artifacts" / run_id / "answer.txt",
        }


class ScoringError(RuntimeError):
    """A session that cannot be scored, which is a setup error and never a 0."""


def verify_on_host(task, workspace, answer):
    """Run a task's verifier against the real truth, outside any session container.

    Every way this can go wrong raises: a missing workspace, answer or truth
    file, a verifier that crashed or printed no score, and a deferred score --
    the in-container result, which on the host can only mean the truth was not
    found. Recording any of them as a 0 would count a broken setup as a wrong
    answer.
    """
    truth_dir = HERE / "fixtures" / "truth"
    pair = task.rsplit("-", 1)[0]
    for path, what in ((workspace, "workspace"), (answer, "answer"), (truth_dir / f"{pair}.json", "truth")):
        if not path.exists():
            raise ScoringError(f"{task}: no {what} at {path}")
    env = {**os.environ, "WORKSPACE": str(workspace), "ANSWER_FILE": str(answer), "TRUTH_DIR": str(truth_dir)}
    result = subprocess.run([sys.executable, str(HERE / "tasks" / task / "verify.py")],
                            env=env, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise ScoringError(f"{task}: the verifier exited {result.returncode}: {result.stderr.strip()[-400:]}")
    if "detail=deferred" in result.stdout:
        raise ScoringError(f"{task}: the verifier deferred on the host, so it did not find {truth_dir}")
    line = next((l for l in result.stdout.splitlines() if l.startswith("score=")), None)
    if line is None:
        raise ScoringError(f"{task}: the verifier printed no score")
    return float(line.split("=", 1)[1])


def score(args):
    out = Path(args.out).resolve()
    record = load(out)
    state = progress(out)
    # A rescore replaces the scores whole: if it fails partway, report must
    # find nothing rather than the scores of an earlier, smaller run.
    (out / "scores.json").unlink(missing_ok=True)
    scores = []
    for unit in record["units"]:
        unit_dir = state["done"].get(unit["id"])
        if unit_dir is None:
            continue
        for s in sessions_of(out, unit_dir):
            role = s["task"].rsplit("-", 1)[1]
            try:
                value = verify_on_host(s["task"], s["workspace"], s["answer"])
            except ScoringError as error:
                sys.exit(f"recall: cannot score {unit['id']}: {error}; no scores.json is left behind")
            scores.append({
                "unit": unit["id"], "pair": unit["pair"], "arm": unit["arm"], "rep": unit["rep"],
                "role": role, "calls": s["calls"], "turns": s["turns"], "cost": s["cost"],
                "score": value,
            })
    (out / "scores.json").write_text(json.dumps(scores, indent=1) + "\n", encoding="utf-8")
    print(f"scored {len(scores)} session(s) from {len(state['done'])} completed unit(s)")


def report(args):
    out = Path(args.out).resolve()
    if not (out / "scores.json").is_file():
        sys.exit(f"recall: no scores.json in {out}; run score first")
    rows = [r for r in json.loads((out / "scores.json").read_text(encoding="utf-8")) if r["role"] == "reuse"]
    by = {}
    for r in rows:
        by.setdefault(r["pair"], {}).setdefault(r["arm"], {})[r["rep"]] = r
    print("pair              arm                               right  calls  turns   cost  avoided")
    for pair in sorted(by):
        control = by[pair].get("control", {})
        for arm in sorted(by[pair]):
            runs = by[pair][arm]
            both = [k for k in runs if k in control and runs[k]["score"] == 1 and control[k]["score"] == 1]
            avoided = (
                sum(control[k]["calls"] - runs[k]["calls"] for k in both) / len(both)
                if both and arm != "control" else None
            )
            right = sum(1 for r in runs.values() if r["score"] == 1)
            mean = lambda key: sum(r[key] or 0 for r in runs.values()) / len(runs)
            print(
                f"{pair:17} {arm:33} {right}/{len(runs):<4} {mean('calls'):6.1f} {mean('turns'):6.1f} "
                f"{mean('cost'):6.3f}  {'-' if avoided is None else f'{avoided:.1f} over {len(both)}'}"
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan")
    p.add_argument("out")
    p.add_argument("--arms", default=DEFAULT_ARMS)
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--image", default="thol-rig:local")
    p.add_argument("--campaign", default=DEFAULT_CAMPAIGN)
    r = sub.add_parser("run")
    r.add_argument("out")
    r.add_argument("--approve-spend", action="store_true")
    for name in ("score", "report"):
        sub.add_parser(name).add_argument("out")
    args = parser.parse_args()
    {"plan": plan, "run": run, "score": score, "report": report}[args.command](args)


if __name__ == "__main__":
    main()