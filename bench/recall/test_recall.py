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

    def test_a_derive_reply_that_denies_the_cause_in_the_right_words_scores_nothing(self):
        # "Sorting is alphabetical, so 1_create_users.sql runs first" names both
        # the sort and 10_ and says the opposite of what the fixture does.
        for pair in PAIRS:
            with Workspace(pair) as ws:
                for wrong in record(pair)["deriveDecoys"]:
                    self.assertEqual(score(pair, "derive", wrong, ws), 0.0, f"{pair}: {wrong!r}")

    def test_an_added_fixture_file_scores_nothing(self):
        # migrations/0_x.sql changes which migration runs first without
        # touching any listed file, so the listed hashes alone cannot see it.
        for pair in PAIRS:
            t = record(pair)
            with Workspace(pair) as ws:
                extra = ws / Path(t["marker"]).parent / "0_added.sql"
                extra.write_text("SELECT 1;\n")
                for role in ("derive", "reuse"):
                    self.assertEqual(score(pair, role, t["reference"][role], ws), 0.0, f"{pair}-{role}")

    def test_bytecode_and_a_clients_own_state_are_not_the_fixture(self):
        for pair in PAIRS:
            t = record(pair)
            with Workspace(pair) as ws:
                (ws / "__pycache__").mkdir()
                (ws / "__pycache__" / "x.cpython-313.pyc").write_bytes(b"\0")
                (ws / ".token-optimizer" / "wiki").mkdir(parents=True)
                (ws / ".token-optimizer" / "wiki" / "nodes.jsonl").write_text("{}\n")
                self.assertEqual(score(pair, "reuse", t["reference"]["reuse"], ws), 1.0, pair)

    def test_a_right_cause_told_in_other_words_scores_full_credit(self):
        # The contradiction check must reject named wrong causes only: "comes
        # from migration 10 referencing a missing table." is the symptom, and
        # the next sentence gives the ordering cause.
        for pair in PAIRS:
            with Workspace(pair) as ws:
                for right in record(pair)["deriveAccepts"]:
                    self.assertEqual(score(pair, "derive", right, ws), 1.0, f"{pair}: {right!r}")

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


def quiet(fn, *args, **kwargs):
    import contextlib
    import io

    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*args, **kwargs)


def make_plan(out, reps=2):
    import argparse

    quiet(runner().plan, argparse.Namespace(
        out=str(out), arms="control,knowledge", reps=reps, image="img", campaign="2.1.251 (Claude Code)"))
    return json.loads((Path(out) / "plan.json").read_text(encoding="utf-8"))


def mounts_of(step):
    return [v for i, v in enumerate(step) if i and step[i - 1] == "-v"]


class Ok:
    returncode = 0


class Fail:
    returncode = 1


def thol_records(step, status="ok"):
    """Write the row THOL would for the session `step` ran, into its own volume."""
    import sqlite3
    from contextlib import closing

    results = Path(next(m for m in mounts_of(step) if ":/results:" in m).split(":/results:")[0])
    task = step[step.index("-t") + 1]
    with closing(sqlite3.connect(results / "results.sqlite")) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS runs (run_id TEXT, task TEXT, tool_calls INTEGER, "
                   "num_turns INTEGER, total_cost_usd REAL, status TEXT)")
        db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?)", (task, task, 1, 1, 0.0, status))
    return Ok()


class TheRunnerKeepsThePairsApart(unittest.TestCase):
    """Nothing may reach a reuse session except what its own derive session left."""

    def test_a_plan_is_one_unit_per_pair_arm_and_repetition(self):
        with tempfile.TemporaryDirectory() as out:
            plan = make_plan(Path(out) / "p")
        self.assertEqual(len(plan["units"]), 3 * 2 * 2)
        self.assertEqual(len({u["id"] for u in plan["units"]}), len(plan["units"]))

    def test_planning_into_a_used_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as out:
            make_plan(Path(out) / "p")
            with self.assertRaises(SystemExit) as refused:
                make_plan(Path(out) / "p")
        self.assertIn("not empty", str(refused.exception))

    def test_a_session_sees_its_own_task_and_fixture_and_never_the_truth(self):
        r = runner()
        with tempfile.TemporaryDirectory() as out:
            out = Path(out) / "p"
            plan = make_plan(out, reps=1)
            for unit in plan["units"]:
                for role in r.ROLES:
                    step = r.session(unit, role, out / "units" / unit["id"] / "try1", out, plan)
                    mounts = mounts_of(step)
                    self.assertEqual([m for m in mounts if "truth" in m], [], unit["id"])
                    tasks = [m for m in mounts if "/tasks/recall-" in m]
                    self.assertEqual(len(tasks), 1)
                    self.assertIn(f"/tasks/{unit['pair']}-{role}:", tasks[0])
                    self.assertIn("--keep-workspaces", step)
                    self.assertIn("THOL_CAMPAIGN=2.1.251 (Claude Code)", step)

    def test_the_two_sessions_of_an_attempt_share_one_graph_and_results_volume(self):
        r = runner()
        with tempfile.TemporaryDirectory() as out:
            out = Path(out) / "p"
            plan = make_plan(out, reps=1)
            unit = plan["units"][0]
            attempt = out / "units" / unit["id"] / "try1"
            steps = [r.session(unit, role, attempt, out, plan) for role in r.ROLES]
        for wanted in (":/proxy-graph:", ":/results:"):
            found = {next(m for m in mounts_of(s) if wanted in m) for s in steps}
            self.assertEqual(len(found), 1, wanted)

    def test_running_without_approval_is_refused(self):
        import argparse

        with tempfile.TemporaryDirectory() as out:
            make_plan(Path(out) / "p", reps=1)
            with self.assertRaises(SystemExit) as refused:
                runner().run(argparse.Namespace(out=str(Path(out) / "p"), approve_spend=False))
        self.assertIn("approve-spend", str(refused.exception))

    def test_a_rerun_repeats_no_finished_unit_and_restarts_a_failed_one_clean(self):
        import argparse

        r = runner()
        with tempfile.TemporaryDirectory() as out:
            out = Path(out) / "p"
            plan = make_plan(out, reps=1)
            calls = []

            def flaky(step):
                calls.append(step)
                graph = next(m for m in mounts_of(step) if ":/proxy-graph:" in m).split(":/proxy-graph:")[0]
                # Each session leaves something in the graph, as a real one would.
                (Path(graph) / f"left-{len(calls)}").write_text("x")
                return Fail() if len(calls) == 4 else thol_records(step)

            args = argparse.Namespace(out=str(out), approve_spend=True)
            with self.assertRaises(SystemExit):
                quiet(r.run, args, execute=flaky)
            self.assertEqual(len(calls), 4)
            first = plan["units"][0]["id"]
            failed = plan["units"][1]["id"]
            self.assertIn(first, r.progress(out)["done"])
            self.assertNotIn(failed, r.progress(out)["done"])

            calls.clear()
            quiet(r.run, args, execute=lambda step: (calls.append(step), thol_records(step))[1])
            touched = {m for s in calls for m in mounts_of(s) if ":/results:" in m}
            self.assertFalse(any(f"units{os.sep}{first}{os.sep}" in m or f"units/{first}/" in m for m in touched))
            self.assertEqual(len(calls), 2 * (len(plan["units"]) - 1))
            retry = out / "units" / failed / "try2" / "graph"
            self.assertEqual(r.progress(out)["done"][failed], f"units/{failed}/try2")
            self.assertTrue(retry.is_dir())
            self.assertFalse(any(p.name.startswith("left-") and int(p.name[5:]) <= 4 for p in retry.iterdir()))


    def test_a_zero_exit_without_an_ok_row_does_not_complete_a_unit(self):
        # THOL exits 0 after recording a timeout too; score reads only ok rows.
        import argparse

        r = runner()
        with tempfile.TemporaryDirectory() as out:
            out = Path(out) / "p"
            plan = make_plan(out, reps=1)
            args = argparse.Namespace(out=str(out), approve_spend=True)
            with self.assertRaises(SystemExit) as stopped:
                quiet(r.run, args, execute=lambda step: thol_records(
                    step, "timeout" if step[step.index("-t") + 1].endswith("-reuse") else "ok"))
            self.assertIn("no ok run for reuse", str(stopped.exception))
            self.assertEqual(r.progress(out)["done"], {})
            self.assertEqual(r.progress(out)["attempts"], {plan["units"][0]["id"]: 1})


class ScoringHappensOnTheHost(unittest.TestCase):
    def test_host_scoring_refuses_what_it_cannot_score(self):
        r = runner()
        with Workspace("recall-tz") as ws, tempfile.TemporaryDirectory() as scratch:
            answer = Path(scratch) / "answer.txt"
            with self.assertRaisesRegex(r.ScoringError, "no answer"):
                r.verify_on_host("recall-tz-reuse", ws, answer)
            answer.write_text("TZ=UTC")
            with self.assertRaisesRegex(r.ScoringError, "no workspace"):
                r.verify_on_host("recall-tz-reuse", Path(scratch) / "missing", answer)
            with self.assertRaisesRegex(r.ScoringError, "no truth"):
                r.verify_on_host("recall-absent-reuse", ws, answer)
            self.assertEqual(r.verify_on_host("recall-tz-reuse", ws, answer), 1.0)

    def test_a_deferred_crashed_or_silent_verifier_is_an_error_not_a_zero(self):
        # The check after the truth pre-check: a verifier that still defers on
        # the host means the setup is wrong, and must not be recorded as a 0.
        r = runner()
        real = r.HERE
        with tempfile.TemporaryDirectory() as fake, Workspace("recall-tz") as ws:
            fake = Path(fake)
            (fake / "tasks" / "recall-tz-reuse").mkdir(parents=True)
            (fake / "fixtures" / "truth").mkdir(parents=True)
            (fake / "fixtures" / "truth" / "recall-tz.json").write_text("{}")
            answer = fake / "answer.txt"
            answer.write_text("TZ=UTC")
            stubs = {
                "deferred": 'print("score=0.0000")\nprint("detail=deferred: no truth here")\n',
                "exited 3": 'import sys\nsys.exit(3)\n',
                "no score": 'print("detail=nothing to say")\n',
            }
            r.HERE = fake
            try:
                for expected, source in stubs.items():
                    (fake / "tasks" / "recall-tz-reuse" / "verify.py").write_text(source)
                    with self.assertRaisesRegex(r.ScoringError, expected):
                        r.verify_on_host("recall-tz-reuse", ws, answer)
            finally:
                r.HERE = real
    def test_inside_the_container_the_verifier_defers(self):
        with Workspace("recall-tz") as ws, tempfile.TemporaryDirectory() as empty_truth:
            with tempfile.TemporaryDirectory() as scratch:
                answer = Path(scratch) / "answer.txt"
                answer.write_text(record("recall-tz")["reference"]["reuse"])
                run = subprocess.run(
                    [sys.executable, str(TASKS / "recall-tz-reuse" / "verify.py")],
                    env={**os.environ, "WORKSPACE": str(ws), "ANSWER_FILE": str(answer), "TRUTH_DIR": empty_truth},
                    capture_output=True, text=True, timeout=60,
                )
        self.assertIn("score=0.0000", run.stdout)
        self.assertIn("deferred", run.stdout)

    def test_score_reads_the_kept_workspace_and_answer_and_report_counts_both_right(self):
        import argparse
        import sqlite3
        from contextlib import closing

        r = runner()
        with tempfile.TemporaryDirectory() as out:
            out = Path(out) / "p"
            plan = make_plan(out, reps=2)
            replies = {  # (arm, rep) -> (reuse reply, reuse tool calls)
                ("control", 1): ("TZ=UTC", 12),
                ("control", 2): ("TZ=UTC", 10),
                ("knowledge", 1): ("TZ=UTC", 2),
                ("knowledge", 2): ("LANG=C", 1),  # cheap and wrong: not a saving
            }
            state = {"done": {}, "attempts": {}}
            for unit in plan["units"]:
                if unit["pair"] != "recall-tz":
                    continue
                unit_dir = out / "units" / unit["id"] / "try1"
                results = unit_dir / "results"
                results.mkdir(parents=True)
                with closing(sqlite3.connect(results / "results.sqlite")) as db, db:
                    db.execute("CREATE TABLE runs (run_id TEXT, task TEXT, tool_calls INTEGER, "
                               "num_turns INTEGER, total_cost_usd REAL, status TEXT)")
                    for role in ("derive", "reuse"):
                        run_id = f"{unit['id']}-{role}"
                        reply, calls = (record("recall-tz")["reference"]["derive"], 5) if role == "derive" \
                            else replies[(unit["arm"], unit["rep"])]
                        shutil.copytree(FIXTURES / "tzbook", results / "runs" / run_id / "workspace",
                                        ignore=shutil.ignore_patterns("__pycache__"))
                        (results / "artifacts" / run_id).mkdir(parents=True)
                        (results / "artifacts" / run_id / "answer.txt").write_text(reply)
                        db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?)",
                                   (run_id, f"recall-tz-{role}", calls, calls, 0.1, "ok"))
                state["done"][unit["id"]] = unit_dir.relative_to(out).as_posix()
            r.save_progress(out, state)
            quiet(r.score, argparse.Namespace(out=str(out)))
            scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
            self.assertEqual(len(scores), 8)
            self.assertTrue(all(s["score"] == 1.0 for s in scores if s["role"] == "derive"))
            import contextlib
            import io

            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                r.report(argparse.Namespace(out=str(out)))

            # A rescore that fails (here: an answer went missing) must not
            # leave the earlier scores for report to present as current.
            first = next(Path(out, d) for d in state["done"].values())
            next((first / "results" / "artifacts").glob("*/answer.txt")).unlink()
            with self.assertRaisesRegex(SystemExit, "cannot score"):
                quiet(r.score, argparse.Namespace(out=str(out)))
            self.assertFalse((out / "scores.json").exists())
            with self.assertRaisesRegex(SystemExit, "run score first"):
                r.report(argparse.Namespace(out=str(out)))
        line = next(l for l in buffer.getvalue().splitlines() if "knowledge" in l)
        self.assertIn("10.0 over 1", line)
        self.assertIn("1/2", line)


if __name__ == "__main__":
    unittest.main()