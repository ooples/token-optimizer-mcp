"""The THOL verifier protocol, for running these verifiers outside the rig.

THOL (github.com/pi-infected/token-harness-optimizer-leaderboard, MIT) runs a
task's verifier as `python3 verify.py` with three environment variables:

  WORKSPACE   - the run workspace, after the session
  ANSWER_FILE - a file holding the agent's final reply
  TRUTH_DIR   - fixtures/truth, which the agent never sees

and reads `score=<0..1>` from its output. Inside the rig the verifiers import
THOL's own `_vlib.py`, which sits beside every task there; this file is never
mounted into the rig. It exists so `test_recall.py` can run every verifier
offline against the same contract, and it implements only the part of that
contract these verifiers use.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

WS = Path(os.environ["WORKSPACE"])
TRUTH_DIR = Path(os.environ["TRUTH_DIR"])
ANSWER_FILE = os.environ.get("ANSWER_FILE", "")


def answer() -> str:
    try:
        return Path(ANSWER_FILE).read_text()
    except OSError:
        return ""


def truth(name: str):
    return json.loads((TRUTH_DIR / name).read_text())


def emit(score: float, detail: str = ""):
    print(f"score={max(0.0, min(1.0, score)):.4f}")
    if detail:
        for line in detail.splitlines():
            print(f"detail={line}")
    sys.exit(0)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes_intact(root: Path, expected: dict) -> bool:
    for rel, h in expected.items():
        p = root / rel
        if not p.exists() or sha(p) != h:
            return False
    return True