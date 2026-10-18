"""What every recall verifier does, so the six of them cannot disagree.

A recall task is a PAIR. Session 1 (`derive`) is asked to work something out
that the workspace does not state. Session 2 (`reuse`) starts cold, in a fresh
copy of the same workspace, and is asked a question whose answer depends on
that conclusion. The pair measures whether what session 1 established reaches
session 2 -- the calls it avoids are the measurement, and a correct answer is
the precondition for counting them.

THE ANSWER IS SCORED FROM GROUND TRUTH THE AGENT NEVER SEES (TRUTH_DIR), and a
verifier awards nothing unless three things hold first:

  - the workspace is the fixture: an empty or missing workspace scores 0, so a
    session that never ran cannot pass on a lucky reply;
  - no fixture file was changed, removed or ADDED: both prompts say not to,
    and a session that "answers" by rewriting the code has answered a
    different question. An added file counts, because one can change what the
    code does without touching a listed file -- `migrations/0_x.sql` runs
    before every other migration. Bytecode caches and dot-directories (a
    client's own state, such as `.token-optimizer/`) are not the fixture;
  - there is a reply at all.

A `reuse` answer that names the right value AND a decoy is a hedge, and scores
0: a list of candidates is not a conclusion. A `derive` answer must state the
pair's conclusion (every `require` pattern) and must not deny it (no
`contradict` pattern): the right words in a sentence that says the opposite
are not the right answer.

THE TRUTH NEVER ENTERS THE SESSION'S CONTAINER. THOL runs the agent and the
verifier as one user on one filesystem, so a truth file mounted for the
verifier is a file the agent can `cat`. recall.py mounts none; inside the rig
this verifier finds no truth and records a deferred 0, and `recall.py score`
runs it again on the host against the kept workspace and answer, which is the
score the report uses.
"""

import re

from _vlib import TRUTH_DIR, WS, answer, emit, sha, truth

IGNORED_DIRS = {"__pycache__"}


def inventory(root):
    """Every fixture-relevant file under root, as posix relative paths."""
    files = set()
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if not path.is_file() or any(p in IGNORED_DIRS or p.startswith(".") for p in rel.parts[:-1]):
            continue
        if path.suffix == ".pyc":
            continue
        files.add(rel.as_posix())
    return files


def fixture_intact(root, expected):
    """True when the workspace holds exactly the fixture's files, unchanged."""
    if inventory(root) != set(expected):
        return False
    return all(sha(root / rel) == digest for rel, digest in expected.items())


def verify(pair: str, role: str) -> None:
    if not (TRUTH_DIR / f"{pair}.json").is_file():
        emit(0.0, "deferred: scored outside the session container by bench/recall/recall.py score")
    t = truth(f"{pair}.json")
    if not (WS / t["marker"]).is_file():
        emit(0.0, f"the workspace is not the {t['fixture']} fixture (no {t['marker']})")
    if not fixture_intact(WS, t["fixture_hashes"]):
        emit(0.0, "a fixture file was changed, removed or added; the prompt says to change none")
    text = answer().strip()
    if not text:
        emit(0.0, "no final reply")
    if role == "derive":
        missing = [p for p in t["derive"]["require"] if not re.search(p, text, re.IGNORECASE)]
        if missing:
            emit(0.0, "the explanation does not state: " + "; ".join(missing))
        denied = [p for p in t["derive"]["contradict"] if re.search(p, text, re.IGNORECASE)]
        if denied:
            emit(0.0, "the explanation contradicts the conclusion: " + "; ".join(denied))
        emit(1.0, "the root cause is stated")
    if role == "reuse":
        right = any(re.search(p, text, re.IGNORECASE) for p in t["reuse"]["accept"])
        hedge = [p for p in t["reuse"]["decoys"] if re.search(p, text, re.IGNORECASE)]
        if right and not hedge:
            emit(1.0, "the answer depends on the derived conclusion and is correct")
        if right:
            emit(0.0, "the right answer was given alongside a wrong one: " + ", ".join(hedge))
        emit(0.0, "not the answer the derived conclusion implies")
    emit(0.0, f"unknown role {role!r}")