"""Offline self-test of bench/recall: no session is run and nothing is spent.

    python3 -m unittest discover -s bench/recall -p "test_*.py"

A recall measurement is only as good as its verifiers, and a verifier that is
wrong is wrong silently: it scores real sessions, nobody re-reads the replies,
and a benchmark that passes everything or nothing looks exactly like one that
works. So every verifier is exercised here against answers whose score is
known before it runs, and every fixture is checked to carry the defect its
pair is about.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASKS = HERE / "tasks"
FIXTURES = HERE / "fixtures"
TRUTH = FIXTURES / "truth"
PAIRS = sorted(json.loads(p.read_text())["pair"] for p in TRUTH.glob("*.json"))


def record(pair):
    return json.loads((TRUTH / f"{pair}.json").read_text())


def score(pair, role, reply, workspace):
    with tempfile.TemporaryDirectory() as scratch:
        answer = Path(scratch) / "answer.txt"
        answer.write_text(reply)
        run = subprocess.run(
            [sys.executable, str(TASKS / f"{pair}-{role}" / "verify.py")],
            env={**os.environ, "WORKSPACE": str(workspace), "ANSWER_FILE": str(answer), "TRUTH_DIR": str(TRUTH)},
            capture_output=True,
            text=True,
            timeout=60,
        )
    if run.returncode != 0:
        raise AssertionError(f"verifier broke: {run.stderr}")
    line = next(l for l in run.stdout.splitlines() if l.startswith("score="))
    return float(line.split("=", 1)[1])


class Workspace:
    """A fresh copy of a pair's fixture, as THOL hands one to each session."""

    def __init__(self, pair):
        self.fixture = record(pair)["fixture"]

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ws"
        shutil.copytree(FIXTURES / self.fixture, self.path, ignore=shutil.ignore_patterns("__pycache__"))
        return self.path

    def __exit__(self, *exc):
        self.tmp.cleanup()


class TheTasksAreWellFormed(unittest.TestCase):
    def test_every_pair_has_both_halves(self):
        self.assertEqual(len(PAIRS), 3)
        for pair in PAIRS:
            for role in ("derive", "reuse"):
                task = json.loads((TASKS / f"{pair}-{role}" / "task.json").read_text())
                self.assertEqual(task["id"], f"{pair}-{role}")
                self.assertEqual(task["workspace"]["fixture"], record(pair)["fixture"])
                self.assertTrue((FIXTURES / task["workspace"]["fixture"]).is_dir())

    def test_the_fixture_hashes_are_current(self):
        spec = importlib.util.spec_from_file_location("hash_fixtures", HERE / "hash_fixtures.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.main(check=True), 0)


class TheConclusionIsNotInTheWorkspace(unittest.TestCase):
    """The reuse answer must come from session 1 or from doing the work again."""

    def test_no_workspace_file_or_prompt_states_it(self):
        for pair in PAIRS:
            t = record(pair)
            texts = {
                str(p.relative_to(FIXTURES)): p.read_text(encoding="utf-8").lower()
                for p in (FIXTURES / t["fixture"]).rglob("*")
                if p.is_file() and "__pycache__" not in p.parts
            }
            for role in ("derive", "reuse"):
                texts[f"{pair}-{role}/prompt.md"] = (TASKS / f"{pair}-{role}" / "prompt.md").read_text(encoding="utf-8").lower()
            for phrase in t["absent"]:
                for name, text in texts.items():
                    self.assertNotIn(phrase.lower(), text, f"{pair}: {name} states {phrase!r}")


class TheVerifiersScoreWhatTheySay(unittest.TestCase):
    def test_the_reference_answers_score_full_credit(self):
        for pair in PAIRS:
            t = record(pair)
            with Workspace(pair) as ws:
                self.assertEqual(score(pair, "derive", t["reference"]["derive"], ws), 1.0, pair)
                self.assertEqual(score(pair, "reuse", t["reference"]["reuse"], ws), 1.0, pair)

    def test_an_empty_reply_scores_nothing(self):
        for pair in PAIRS:
            with Workspace(pair) as ws:
                for role in ("derive", "reuse"):
                    self.assertEqual(score(pair, role, "  \n", ws), 0.0, f"{pair}-{role}")

    def test_wrong_and_hedged_answers_score_nothing(self):
        for pair in PAIRS:
            with Workspace(pair) as ws:
                for wrong in record(pair)["decoyAnswers"]:
                    self.assertEqual(score(pair, "reuse", wrong, ws), 0.0, f"{pair}: {wrong!r}")

    def test_an_empty_workspace_scores_nothing(self):
        for pair in PAIRS:
            t = record(pair)
            with tempfile.TemporaryDirectory() as empty:
                for role in ("derive", "reuse"):
                    self.assertEqual(score(pair, role, t["reference"][role], empty), 0.0, f"{pair}-{role}")

    def test_a_changed_fixture_scores_nothing(self):
        for pair in PAIRS:
            t = record(pair)
            with Workspace(pair) as ws:
                marker = ws / t["marker"]
                marker.write_text(marker.read_text() + "\n# edited\n")
                for role in ("derive", "reuse"):
                    self.assertEqual(score(pair, role, t["reference"][role], ws), 0.0, f"{pair}-{role}")

    def test_a_derive_reply_that_misses_the_cause_scores_nothing(self):
        vague = "The tests fail because of a bug in the code; it needs fixing."
        for pair in PAIRS:
            with Workspace(pair) as ws:
                self.assertEqual(score(pair, "derive", vague, ws), 0.0, pair)


class TheFixturesCarryTheirDefect(unittest.TestCase):
    def test_migrations_sort_as_strings(self):
        sys.path.insert(0, str(FIXTURES / "migrun"))
        try:
            from migrun.runner import pending

            self.assertEqual(pending(FIXTURES / "migrun" / "migrations")[0], "10_backfill_email.sql")
        finally:
            sys.path.remove(str(FIXTURES / "migrun"))
        with Workspace("recall-migrate") as ws:
            suite = subprocess.run(
                [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                cwd=ws, capture_output=True, text=True, timeout=120,
            )
        self.assertNotEqual(suite.returncode, 0, "a fresh database must fail to migrate")

    def test_the_window_is_read_in_milliseconds(self):
        sys.path.insert(0, str(FIXTURES / "quotasvc"))
        try:
            from quotasvc.limiter import from_env

            self.assertEqual(from_env({"QUOTA_WINDOW": "60"}).window_ms, 60)
        finally:
            sys.path.remove(str(FIXTURES / "quotasvc"))
        self.assertIn("in seconds", (FIXTURES / "quotasvc" / "README.md").read_text())

    @unittest.skipIf(not hasattr(__import__("time"), "tzset"), "time.tzset is POSIX-only")
    def test_the_days_depend_on_the_local_time_zone(self):
        def suite(zone):
            with Workspace("recall-tz") as ws:
                return subprocess.run(
                    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                    cwd=ws, env={**os.environ, "TZ": zone}, capture_output=True, text=True, timeout=120,
                ).returncode

        self.assertEqual(suite("UTC"), 0)
        self.assertNotEqual(suite("Pacific/Honolulu"), 0)


def runner():
    spec = importlib.util.spec_from_file_location("recall", HERE / "recall.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheRunnerKeepsThePairsApart(unittest.TestCase):
    """Nothing may reach a reuse session except what its own derive session left."""

    def plan(self, out, reps=2):
        import argparse
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            runner().plan(argparse.Namespace(out=str(out), arms="control,token-optimizer-proxy-knowledge", reps=reps, image="img"))
        return json.loads((Path(out) / "plan.json").read_text(encoding="utf-8"))

    def test_each_pair_arm_and_repetition_has_its_own_graph_shared_by_its_two_sessions(self):
        with tempfile.TemporaryDirectory() as out:
            steps = self.plan(out)
        self.assertEqual(len(steps), 3 * 2 * 2 * 2)
        graphs = {}
        for step in steps:
            graph = next(v.split(":/proxy-graph:")[0] for v in step if ":/proxy-graph:" in v)
            task = step[step.index("-t") + 1]
            graphs.setdefault(graph, []).append(task)
        self.assertEqual(len(graphs), 3 * 2 * 2)
        for tasks in graphs.values():
            self.assertEqual(len(tasks), 2)
            self.assertTrue(tasks[0].endswith("-derive") and tasks[1].endswith("-reuse"))
            self.assertEqual(tasks[0][: -len("-derive")], tasks[1][: -len("-reuse")])

    def test_a_session_sees_only_its_own_task_fixture_and_truth(self):
        with tempfile.TemporaryDirectory() as out:
            steps = self.plan(out, reps=1)
        for step in steps:
            task = step[step.index("-t") + 1]
            pair = task.rsplit("-", 1)[0]
            mounts = [v for i, v in enumerate(step) if i and step[i - 1] == "-v"]
            tasks = [m for m in mounts if "/tasks/recall-" in m]
            truths = [m for m in mounts if "/fixtures/truth/" in m]
            self.assertEqual(len(tasks), 1, task)
            self.assertIn(f"/tasks/{task}:", tasks[0])
            self.assertEqual(len(truths), 1, task)
            self.assertIn(f"/fixtures/truth/{pair}.json:", truths[0])

    def test_running_without_approval_is_refused(self):
        import argparse

        with tempfile.TemporaryDirectory() as out:
            self.plan(out, reps=1)
            with self.assertRaises(SystemExit) as refused:
                runner().run(argparse.Namespace(out=out, approve_spend=False))
        self.assertIn("approve-spend", str(refused.exception))

    def test_calls_avoided_counts_only_repetitions_both_arms_got_right(self):
        import argparse
        import contextlib
        import io
        import sqlite3

        with tempfile.TemporaryDirectory() as out:
            db = Path(out) / "results.sqlite"
            with contextlib.closing(sqlite3.connect(db)) as c, c:
                c.execute(
                    "CREATE TABLE runs (competitor TEXT, task TEXT, rep INTEGER, score REAL, "
                    "tool_calls INTEGER, num_turns INTEGER, total_cost_usd REAL, status TEXT)"
                )
                rows = [
                    ("control", "recall-tz-reuse", 1, 1.0, 12, 8, 0.2, "ok"),
                    ("control", "recall-tz-reuse", 2, 1.0, 10, 7, 0.2, "ok"),
                    ("knowledge", "recall-tz-reuse", 1, 1.0, 2, 2, 0.05, "ok"),
                    # Cheap and wrong: must not count as calls avoided.
                    ("knowledge", "recall-tz-reuse", 2, 0.0, 1, 1, 0.01, "ok"),
                ]
                c.executemany("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)", rows)
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                runner().report(argparse.Namespace(results=str(db)))
        line = next(l for l in buffer.getvalue().splitlines() if "knowledge" in l)
        self.assertIn("10.0 over 1", line)
        self.assertIn("1/2", line)


if __name__ == "__main__":
    unittest.main()