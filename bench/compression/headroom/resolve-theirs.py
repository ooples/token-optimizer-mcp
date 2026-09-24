"""Redeem HeadRoom's CCR markers from a SEPARATE, LATER PROCESS.

WHY A SECOND SCRIPT AND NOT A FEW LINES INSIDE run-theirs.py. Their compressor
does not delete the rows it elides; it writes `<<ccr:hash,type,size>>` and keeps
the bytes in a store. Whether that counts as retention or as loss is not a
matter of opinion, and it is not answerable from inside the process that did the
compressing -- an in-memory store would answer "retained" there and "lost"
everywhere else. The pre-registration therefore asks for recovery to be shown
AFTER THE PRODUCING PROCESS HAS EXITED, from the marker text alone. That is a
requirement about process boundaries, so it needs a process boundary: this file
is spawned fresh, is handed nothing but <out-dir>/theirs.json, and asks their
own resolver to put the rows back.

It is deliberately their code doing the work. A reimplementation of their store
lookup would be our guess at their durability, and a guess that flattered us
would be indistinguishable from a measurement.

WHAT THE ANSWER TURNED OUT TO BE, so nobody re-derives it wrongly: their store
defaults to SQLite under the workspace directory, not to the InMemoryBackend the
constructor signature suggests, and markers do survive. A harness that scored
their markers as loss would be wrong. Their real cost is the retrieval turn the
agent must spend, which this file does not measure and does not pretend to.

Usage:
    python bench/compression/headroom/resolve-theirs.py <headroom-clone> <out-dir>

Writes <out-dir>/theirs-resolved.json:
    {name: {"text": <resolved>, "markers": n, "redeemed": n, "unresolved": n}}
"""

import json
import os
import re
import sys

CLONE = sys.argv[1]
OUT = sys.argv[2]
if CLONE != "-":
    sys.path.append(CLONE)

from headroom.ccr.marker_resolution import resolve_markers_in_text  # noqa: E402

# Their own marker grammar, copied from headroom/ccr/marker_resolution.py so the
# count of what WAS there does not depend on the function that consumes it.
MARKER = re.compile(r"<<ccr:([a-f0-9]{12,24})[^>]*>>")
# Their resolver does not raise on a miss; it leaves the marker in place with a
# reason appended. Counting that string is the only way to tell a redeemed
# marker from one that was merely passed through.
UNRESOLVED = re.compile(r"<<ccr:[^>]*>> \[unresolved:")

with open(os.path.join(OUT, "theirs.json"), encoding="utf8") as handle:
    theirs = json.load(handle)

out = {}
for name, entry in sorted(theirs.items()):
    text = entry.get("bestText") or ""
    markers = len(MARKER.findall(text))
    try:
        resolved = resolve_markers_in_text(text)
        error = None
    except Exception as exc:  # their resolver, their failure modes
        resolved, error = text, f"{type(exc).__name__}: {exc}"
    unresolved = len(UNRESOLVED.findall(resolved))
    out[name] = {
        "text": resolved,
        "markers": markers,
        "redeemed": markers - unresolved,
        "unresolved": unresolved,
        "grewBy": len(resolved) - len(text),
        "error": error,
    }
    print(
        f"{name:<24} markers {markers:>4}  redeemed {markers - unresolved:>4}"
        f"  chars {len(text):>8} -> {len(resolved):>8}"
        + (f"  ERROR {error}" if error else "")
    )

path = os.path.join(OUT, "theirs-resolved.json")
with open(path, "w", encoding="utf8") as handle:
    json.dump(out, handle)
print(f"wrote {path}")
