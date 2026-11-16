"""cold_start_cost_usd: the TTL a warm first request is repriced at."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("analyse-campaign.py")
MODEL = "claude-sonnet-4-6"


def usage(read=0, h1=0, m5=0):
    return {"cache_read_input_tokens": read,
            "cache_creation": {"ephemeral_1h_input_tokens": h1,
                               "ephemeral_5m_input_tokens": m5}}


def campaign(directory, runs):
    """runs: {(arm, task): (total_cost_usd, [usage per request])}."""
    db = Path(directory) / "results.sqlite"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE runs (run_id TEXT, competitor TEXT, task TEXT, "
                "status TEXT, total_cost_usd REAL, num_turns INT, score REAL)")
    for (arm, task), (cost, requests) in runs.items():
        run_id = f"{arm}__{task}__1"
        con.execute("INSERT INTO runs VALUES (?,?,?,'ok',?,1,1.0)",
                    (run_id, arm, task, cost))
        transcript = Path(directory) / "artifacts" / run_id / "transcript.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text("".join(
            json.dumps({"type": "assistant",
                        "message": {"model": MODEL, "usage": u}}) + "\n"
            for u in requests), encoding="utf-8")
    con.commit()
    con.close()
    return db


def cold_rows(db):
    out = subprocess.run([sys.executable, str(SCRIPT), str(db)], check=True,
                         capture_output=True, text=True).stdout
    section = out.split("=== cold_start_cost_usd")[1].split("===")[1]
    return {line.split()[0]: line.split()[1:] for line in section.splitlines()[2:]
            if line.strip()}


class ColdStartTtlTests(unittest.TestCase):
    def test_warm_first_request_takes_the_runs_written_tier(self):
        # The first request read 1M tokens and wrote nothing; a later request
        # of the same run wrote at 1h. Repriced at the 1h write rate (2.0x):
        # 1 + 1M * (2.0 - 0.1) * $3/MTok = $6.70, ratio 0.670 against $10.
        # Defaulting to the 5m tier gave $4.45, ratio 0.445.
        with tempfile.TemporaryDirectory() as d:
            db = campaign(d, {
                ("control", "t"): (10.0, [usage(h1=5000)]),
                ("warm", "t"): (1.0, [usage(read=1_000_000), usage(h1=200)]),
            })
            self.assertEqual(cold_rows(db)["warm"][1], "0.670")

    def test_first_requests_own_tier_wins(self):
        with tempfile.TemporaryDirectory() as d:
            db = campaign(d, {
                ("control", "t"): (10.0, [usage(h1=5000)]),
                ("warm", "t"): (1.0, [usage(read=1_000_000, m5=10), usage(h1=200)]),
            })
            # 1 + 1M * (1.25 - 0.1) * 3 / 1M = 4.45
            self.assertEqual(cold_rows(db)["warm"][1], "0.445")

    def test_unknown_ttl_is_unavailable_not_guessed(self):
        for later in ([], [usage(h1=1, m5=1)]):
            with tempfile.TemporaryDirectory() as d:
                db = campaign(d, {
                    ("control", "t"): (10.0, [usage(h1=5000)]),
                    ("warm", "t"): (1.0, [usage(read=1_000_000)] + later),
                })
                self.assertEqual(cold_rows(db)["warm"], ["-", "no", "paired", "tasks"])


if __name__ == "__main__":
    unittest.main()
