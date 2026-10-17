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
  - no fixture file was changed: both prompts say not to, and a session that
    "answers" by rewriting the code has answered a different question;
  - there is a reply at all.

A `reuse` answer that names the right value AND a decoy is a hedge, and scores
0: a list of candidates is not a conclusion.
"""

import re

from _vlib import WS, answer, emit, hashes_intact, truth


def verify(pair: str, role: str) -> None:
    t = truth(f"{pair}.json")
    if not (WS / t["marker"]).is_file():
        emit(0.0, f"the workspace is not the {t['fixture']} fixture (no {t['marker']})")
    if not hashes_intact(WS, t["fixture_hashes"]):
        emit(0.0, "a fixture file was changed or deleted; the prompt says to change none")
    text = answer().strip()
    if not text:
        emit(0.0, "no final reply")
    if role == "derive":
        missing = [
            group for group in t["derive"]["groups"]
            if not any(term.lower() in text.lower() for term in group)
        ]
        if missing:
            emit(0.0, "the explanation names none of: " + "; ".join(" | ".join(g) for g in missing))
        emit(1.0, "the root cause is named")
    if role == "reuse":
        right = any(re.search(p, text, re.IGNORECASE) for p in t["reuse"]["accept"])
        hedge = [p for p in t["reuse"]["decoys"] if re.search(p, text, re.IGNORECASE)]
        if right and not hedge:
            emit(1.0, "the answer depends on the derived conclusion and is correct")
        if right:
            emit(0.0, "the right answer was given alongside a wrong one: " + ", ".join(hedge))
        emit(0.0, "not the answer the derived conclusion implies")
    emit(0.0, f"unknown role {role!r}")