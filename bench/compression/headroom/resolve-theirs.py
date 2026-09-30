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
import time
import sys

CLONE = sys.argv[1]
OUT = sys.argv[2]
FORCE = "--force" in sys.argv[3:]
# A RESOLUTION TAKEN INSIDE THE WINDOW IS EVIDENCE THAT CANNOT BE RE-TAKEN, and
# this script used to overwrite it without looking. Running it a second time a day
# later -- as a smoke test, which is exactly how it happened -- replaces a usable
# resolution with an all-expired one, and their store cannot serve those entries
# again at any later date. The capture beside it is still good, so the loss is
# silent: the directory looks complete and re-scores their retention as UNMEASURED.
#
# So a usable resolution is not overwritten without --force. "Usable" is judged the
# conservative way round: anything this script cannot prove expired counts as worth
# keeping.
existing = os.path.join(OUT, "theirs-resolved.json")
if os.path.exists(existing) and not FORCE:
    try:
        with open(existing, encoding="utf8") as handle:
            had = json.load(handle).get("__provenance__", {})
    except Exception:  # noqa: BLE001 - an unreadable file is not evidence
        had = None
    if had is not None and had.get("pastTheirTtl") is not True:
        print(
            "REFUSING TO OVERWRITE %s. It was resolved at %s and nothing in it says it"
            % (existing, had.get("resolvedAtIso")),
            file=sys.stderr,
        )
        print(
            "was taken past their window, so it is a resolution their store cannot "
            "serve again. Pass --force if you mean to discard it.",
            file=sys.stderr,
        )
        sys.exit(2)

# Checked BEFORE their resolver is imported, so a refusal costs nothing.

if CLONE != "-":
    sys.path.append(CLONE)

from headroom.ccr.marker_resolution import resolve_markers_in_text  # noqa: E402

# Their own marker grammar, copied from headroom/ccr/marker_resolution.py so the
# count of what WAS there does not depend on the function that consumes it.
MARKER = re.compile(r"<<ccr:([a-f0-9]{12,24})[^>]*>>")
# THE WHOLE TOKEN, not just its hash, because the latency probe below has to hand
# their resolver something their resolver will act on. A bare hash is not a
# marker to them and would time a no-op.
WHOLE = re.compile(r"<<ccr:[a-f0-9]{12,24}[^>]*>>")
# Their resolver does not raise on a miss; it leaves the marker in place with a
# reason appended. Counting that string is the only way to tell a redeemed
# marker from one that was merely passed through.
UNRESOLVED = re.compile(r"<<ccr:[^>]*>> \[unresolved:")
# The same miss, with its stated cause. Their resolver names the reason it
# could not serve an entry, and the reason is the whole difference between
# "their store dropped this" and "we asked too late": an expired window reads
# `Entry not found (CCR TTL: 1800 seconds)`. Recording the strings lets the
# scorer refuse the second case instead of scoring it as their loss.
REASON = re.compile(r"<<ccr:[^>]*>> \[unresolved: ([^\]]*)\]")
# Their own message carries the bound they enforce; parsing it beats hardcoding
# a number of ours that could drift away from theirs without anyone noticing.
TTL_SAID = re.compile(r"CCR TTL: (\d+) seconds")

with open(os.path.join(OUT, "theirs.json"), encoding="utf8") as handle:
    theirs = json.load(handle)

out = {}
# EVERY DISTINCT MARKER IN THE WHOLE SWEEP, keyed to the first workload it came
# from. The per-fetch probe below walks these rather than re-asking for one
# marker many times: a store is free to memoise the row it just served, and a
# memo hit is not the retrieval an agent would pay for.
distinct = {}
# Every TTL their resolver quoted at us, so the provenance states THEIR bound.
ttl_said = set()
# `__provenance__` records the store state the capture ran against; it is not
# a workload. Keys are namespaced with dunders precisely so this stays a
# one-line filter rather than a list that drifts.
for name, entry in sorted(theirs.items()):
    if name.startswith("__"):
        continue
    text = entry.get("bestText") or ""
    markers = len(MARKER.findall(text))
    for token in WHOLE.findall(text):
        if token not in distinct:
            distinct[token] = name
    try:
        resolved = resolve_markers_in_text(text)
        error = None
    except Exception as exc:  # their resolver, their failure modes
        # A CRASH IS NOT A PERFECT SCORE. Falling back to `text` left the row
        # holding their markers with no `[unresolved:` suffix on any of them, so
        # `unresolved` came out zero and `redeemed` came out equal to `markers`:
        # full marks for a resolver that raised, printed beside the error that
        # says it never ran. Nothing here was measured, so nothing here gets a
        # number. The scorer already refuses a row carrying `error`
        # (store-resolution.mjs), and this makes the artifact say the same thing
        # itself rather than leaving the rule to whoever reads it next.
        resolved, error = None, f"{type(exc).__name__}: {exc}"
    unresolved = None if resolved is None else len(UNRESOLVED.findall(resolved))
    reasons = [] if resolved is None else sorted(set(REASON.findall(resolved)))
    for reason in reasons:
        said = TTL_SAID.search(reason)
        if said:
            ttl_said.add(int(said.group(1)))
    out[name] = {
        "text": resolved,
        # OURS TO COUNT EITHER WAY: `markers` is this file counting their
        # markers in the text their engine emitted, which does not depend on
        # their resolver having run. Everything below it does.
        "markers": markers,
        "redeemed": None if resolved is None else markers - unresolved,
        "unresolved": unresolved,
        "grewBy": None if resolved is None else len(resolved) - len(text),
        "error": error,
        # Distinct reasons only. A workload with forty identical TTL misses is
        # one fact, not forty, and the scorer reads the fact.
        "reasons": reasons,
    }
    redeemed_col = "   ?" if resolved is None else f"{markers - unresolved:>4}"
    after_col = "       ?" if resolved is None else f"{len(resolved):>8}"
    print(
        f"{name:<24} markers {markers:>4}  redeemed {redeemed_col}"
        f"  chars {len(text):>8} -> {after_col}"
        + (f"  ERROR {error}" if error else "")
    )

# THEIR PER-FETCH LATENCY, MEASURED HERE AND NOWHERE ELSE.
#
# MUST-WIN 2b prices the round trips each arm forces, and a price needs a
# measured retrieval rather than an assumed one. Their retrieval is a store
# lookup behind `resolve_markers_in_text`, and this is the only process in the
# harness that can time it: it is inside their TTL, it has their clone on the
# path, and it is their code doing the work. A reimplementation of their lookup
# would be our guess at their speed, and a guess that flattered us would be
# indistinguishable from a measurement.
#
# ONE MARKER PER CALL, which is what makes it a PER-fetch figure. Resolving a
# whole text is one call that serves many rows, and dividing that by the row
# count would credit them with a batching an agent following a reference does
# not get.
#
# THE WARM PASS IS UNTIMED, and it is not a favour to them. Our side is timed
# against a spill file the OS has already paged in, so timing their first-ever
# lookup -- their import, their connection, their expiry sweep -- would be
# charging them for setup we do not charge ourselves for, and reporting the
# difference as their design.
#
# A MISS IS NOT A FAST FETCH. Past their TTL every lookup returns the marker with
# a reason appended, which is quick and measures nothing; only markers that came
# back with content are timed, and a probe with no hits records itself as
# unmeasured so the scorer refuses the criterion instead of pricing their
# retrieval at the speed of their refusal.
FETCH_PASSES = 3
FETCH_MARKERS = 64
fetch_hits = []
fetch_misses = 0
probe = sorted(distinct)[:FETCH_MARKERS]
for token in probe:
    try:
        if UNRESOLVED.search(resolve_markers_in_text(token)):
            fetch_misses += 1
        else:
            fetch_hits.append(token)
    except Exception:  # noqa: BLE001 - their resolver, their failure modes
        fetch_misses += 1

fetch_passes = []
for _ in range(FETCH_PASSES if fetch_hits else 0):
    samples = []
    for token in fetch_hits:
        start = time.perf_counter()
        got = resolve_markers_in_text(token)
        samples.append((time.perf_counter() - start) * 1000.0)
        # SERVED, AND PROVED TO HAVE BEEN SERVED. A lookup that started missing
        # part-way through the probe would otherwise publish its refusal as their
        # retrieval latency.
        if UNRESOLVED.search(got):
            samples.pop()
            fetch_misses += 1
    if samples:
        fetch_passes.append(samples)

if fetch_passes:
    per_fetch = {
        "passes": fetch_passes,
        "markersProbed": len(probe),
        "markersDistinct": len(distinct),
        "hits": len(fetch_hits),
        "misses": fetch_misses,
        "resolver": "headroom.ccr.marker_resolution.resolve_markers_in_text",
        "granularity": "one marker per call",
        "warmedUntimed": True,
    }
    flat = sorted(v for xs in fetch_passes for v in xs)
    print(
        f"their per-fetch latency: {len(flat)} timed lookup(s) over "
        f"{len(fetch_hits)} marker(s) in {len(fetch_passes)} pass(es), "
        f"median {flat[len(flat) // 2]:.3f}ms"
    )
else:
    per_fetch = {
        "unmeasured": True,
        "detail": (
            f"their store served none of {len(probe)} probed marker(s)"
            if probe
            else "their output carries no markers, so there is no retrieval to time"
        ),
        "markersProbed": len(probe),
        "markersDistinct": len(distinct),
        "hits": 0,
        "misses": fetch_misses,
    }
    print(f"their per-fetch latency UNMEASURED: {per_fetch['detail']}")

# HOW LATE WE WERE, STATED IN THE FILE. `sweptAt` comes from the capture; the gap
# between it and now is the only thing that separates a store that lost content
# from a harness that asked after the window shut. A capture taken before this
# stamp existed leaves `elapsedSeconds` null, and the scorer treats an unusable
# resolution as unmeasured either way -- the stamp sharpens the message, it is not
# what makes the refusal safe.
prov_in = theirs.get("__provenance__", {})
swept = prov_in.get("sweptAt")
# THE OLDEST ENTRY IS THE ONE THAT EXPIRES, AND IT IS NOT THE ONE `sweptAt`
# DESCRIBES. `sweptAt` is stamped after the last pass, so a gap computed from it
# is the age of the newest store entry and understates the oldest by the whole
# sweep duration. On a sweep longer than their window that made `pastTheirTtl`
# read false while the first workloads were already unredeemable.
per_workload = prov_in.get("sweptPerWorkload") or {}
stamps = [v for v in per_workload.values() if isinstance(v, (int, float))]
oldest = min(stamps) if stamps else None
now = time.time()
elapsed = None if not isinstance(swept, (int, float)) else round(now - swept, 1)
elapsed_oldest = None if oldest is None else round(now - oldest, 1)
# The age that decides expiry: the oldest entry when the capture recorded per-
# workload stamps, and the only stamp there is when it did not. A capture written
# before those stamps existed is not silently treated as if its sweep were
# instant -- it falls back to the one number it has, and says which it used.
age = elapsed_oldest if elapsed_oldest is not None else elapsed
age_basis = "oldest-entry" if elapsed_oldest is not None else "end-of-sweep"
ttl = min(ttl_said) if ttl_said else None
out["__provenance__"] = {
    "resolvedAt": now,
    "resolvedAtIso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
    "sweptAt": swept,
    "elapsedSeconds": elapsed,
    "sweepStartedAt": prov_in.get("sweepStartedAt"),
    "oldestEntrySweptAt": oldest,
    "elapsedSecondsOldestEntry": elapsed_oldest,
    # Which of the two the verdict below was taken over, so a reader never has to
    # guess whether this file could see per-workload stamps.
    "ageBasis": age_basis,
    # PER WORKLOAD, because expiry is per entry. A sweep can be inside the window
    # at its end and outside it at its start, and the scorer decides one row at a
    # time -- given only the oldest age it would have to refuse every row to be
    # safe, which throws away the rows that were genuinely measured.
    "entryAgeSeconds": {
        name: round(now - stamp, 1)
        for name, stamp in per_workload.items()
        if isinstance(stamp, (int, float))
    },
    "sweepSeconds": (
        None
        if not isinstance(prov_in.get("sweepStartedAt"), (int, float))
        or not isinstance(swept, (int, float))
        else round(swept - prov_in["sweepStartedAt"], 1)
    ),
    # Their number, quoted back from their own failure message -- not ours.
    "theirStatedTtlSeconds": ttl,
    # THEIR HALF OF MUST-WIN 2b. See the probe above for why it lives in this
    # process and why a miss is recorded as unmeasured rather than as a reading.
    "perFetch": per_fetch,
    "pastTheirTtl": None if (age is None or ttl is None) else age > ttl,
}
if age is not None:
    print(
        f"oldest entry was {age:.0f}s old at resolution ({age_basis})"
        + (f" (their stated TTL {ttl}s)" if ttl else "")
    )
if ttl is not None:
    print(
        f"THEIR STORE REFUSED ENTRIES, quoting a {ttl}s TTL. This resolution cannot "
        "tell a store that lost content from one asked too late, so the scorer will "
        "read their retention as UNMEASURED rather than as loss. Re-run the sweep and "
        "this resolver back to back, inside the window."
    )

path = os.path.join(OUT, "theirs-resolved.json")
with open(path, "w", encoding="utf8") as handle:
    json.dump(out, handle)
print(f"wrote {path}")
