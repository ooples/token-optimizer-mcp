"""Re-measure every competitive claim we make, and refuse to state one we cannot.

WHY THIS FILE EXISTS. Three claims about the competitor were made from reading
their source and each was wrong in a different way: a function tested with one
flag was generalised to "they have no lossless mode"; their ContentRouter was
read through `.text` when the field is `.compressed`, which reported their
output as LARGER than their input; and a fidelity probe searched for `"A-0"`
with quotes against a CSV encoding and reported total data loss where there was
none. Every one of those would have shipped as a public claim.

So a claim is not a sentence here, it is a measurement with a re-runnable
producer. This script runs each probe against the INSTALLED competitor package
and writes the numbers; scripts/verify-blockers.mjs validates the stamped file
and fails when a claim stops matching what the code does.

WHAT IS DELIBERATELY NOT HERE. No conclusions, no prose about them, no
positioning. This repository is public. The numbers are facts about running
their published package; the argument built on them lives elsewhere.

Run:  python bench/competitive/probe-headroom.py bench/competitive/results/claims.json
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def _fixture_object_map(n: int = 40) -> str:
    rows = [
        '    "/route-%d": { "p50": %d.0, "p95": 148.50, "count": %d }' % (i, (i % 9) + 1, 1000 + i)
        for i in range(n)
    ]
    return '{\n  "window": "5m",\n  "errorRate": 0.00100,\n  "byRoute": {\n%s\n  }\n}' % ",\n".join(rows)


def _fixture_record_array(n: int = 90) -> str:
    price = ["19.90", "5.00", "100.0", "2.50", "1e3", "0.0600", "149.99", "7.250"]
    rows = [
        '  { "sku": "A-%d", "price": %s, "currency": "USD", "taxRate": 0.0825, '
        '"note": "line %d priced by hand" }' % (i, price[i % 8], i)
        for i in range(n)
    ]
    return "[\n%s\n]" % ",\n".join(rows)


def _fixture_code(n: int = 40) -> str:
    return "\n\n".join(
        "def handler%d(value: int) -> int:\n"
        '    """Scale the value for downstream consumers."""\n'
        "    if value < 0:\n"
        "        raise ValueError('bad input %d')\n"
        "    scaled = value * %d\n"
        "    return scaled + %d" % (i, i, i + 2, i)
        for i in range(n)
    )


def claim_lossless_mode_drops_keys() -> dict:
    """Their lossless_only path returns valid JSON holding fewer keys, unmarked."""
    from headroom.transforms.smart_crusher import smart_crush_tool_output

    text = _fixture_object_map()
    out, _modified, _info = smart_crush_tool_output(
        text, with_compaction=False, lossless_only=True
    )
    ids_in = set(re.findall(r"/route-(\d+)", text))
    ids_out = set(re.findall(r"/route-(\d+)", out))
    parses = True
    try:
        json.loads(out)
    except Exception:
        parses = False
    markers = [
        token
        for token in ("ccr", "headroom", "truncat", "omitted", "dropped", "retriev")
        if token in out.lower()
    ]
    return {
        "mode": "lossless_only=True",
        "keysIn": len(ids_in),
        "keysOut": len(ids_out),
        "outputParsesAsJson": parses,
        "recoveryMarkers": markers,
        "bytesIn": len(text),
        "bytesOut": len(out),
    }


def claim_ccr_marker_dies_with_the_store() -> dict:
    """Their retrieval marker resolves while the store is warm and not after."""
    from headroom.config import CCRConfig
    from headroom.transforms.smart_crusher import smart_crush_tool_output
    from headroom.cache.compression_store import get_compression_store

    text = _fixture_record_array()
    ccr = CCRConfig(enabled=True, inject_retrieval_marker=True, min_items_to_cache=1)
    out, _m, _i = smart_crush_tool_output(
        text, ccr_config=ccr, with_compaction=False, lossless_only=False
    )
    hashes = re.findall(r"[0-9a-f]{12,64}", out)
    store = get_compression_store()

    def resolves(h: str) -> bool:
        try:
            getter = getattr(store, "retrieve", None) or getattr(store, "get")
            return bool(getter(h))
        except Exception:
            return False

    warm = sum(1 for h in hashes if resolves(h))
    cleared = False
    for name in ("clear", "reset", "purge"):
        if hasattr(store, name):
            try:
                getattr(store, name)()
                cleared = True
                break
            except Exception:
                pass
    cold = sum(1 for h in hashes if resolves(h)) if cleared else None
    return {
        "hashesInOutput": len(hashes),
        "resolveWhileWarm": warm,
        "storeCleared": cleared,
        "resolveAfterClear": cold,
        "rowsVisible": out.count('"sku"'),
        "rowsIn": 90,
    }


def claim_code_marker_carries_no_location() -> dict:
    """Their code elision states a count; ours states a path and a line range."""
    from headroom.transforms.code_compressor import CodeAwareCompressor

    text = _fixture_code()
    out = CodeAwareCompressor().compress(text, language="python").compressed
    located = bool(re.search(r"-> [^\s\]]+:\d+(?:-\d+)?", out))
    elided = bool(re.search(r"\[\d+ lines? omitted\]|# \[\d+ lines? omitted\]", out))
    return {
        "bytesIn": len(text),
        "bytesOut": len(out),
        "signaturesIn": len(set(re.findall(r"def handler(\d+)", text))),
        "signaturesOut": len(set(re.findall(r"def handler(\d+)", out))),
        "elidesBodies": elided,
        "markerCarriesLocation": located,
    }


CLAIMS = {
    "losslessModeDropsKeys": claim_lossless_mode_drops_keys,
    "ccrMarkerDiesWithTheStore": claim_ccr_marker_dies_with_the_store,
    "codeMarkerCarriesNoLocation": claim_code_marker_carries_no_location,
}


def main() -> int:
    try:
        import headroom
    except ImportError:
        print("competitor package not installed; nothing measured", file=sys.stderr)
        return 2

    out_path = Path(sys.argv[1] if len(sys.argv) > 1 else "bench/competitive/results/claims.json")
    # NO PROVENANCE, NO ARTIFACT. This used to fall back to "unknown", and the
    # file in results/ carried that sentinel for weeks: a measurement nobody
    # could tie to a revision, which is the one thing the stamp exists to do.
    # verify-blockers rejects the sentinel now, so writing it only produces a
    # file that fails its own gate -- refuse at the source instead.
    try:
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception as exc:
        print(
            f"cannot stamp the result: git rev-parse HEAD failed ({exc}). "
            "Run the probe from a checkout; an unstamped measurement is not usable.",
            file=sys.stderr,
        )
        return 3

    # A CONTENT HASH OF THIS FILE, ALONGSIDE THE COMMIT.
    #
    # harnessSha records the commit the probe ran at, which does not notice
    # an edited-but-uncommitted probe: the stamp stays valid while the file
    # that produced these numbers has changed underneath it. Newlines are
    # normalised so a Windows checkout and a Linux one agree.
    probe_source = Path(__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
    probe_hash = hashlib.sha256(probe_source.encode("utf-8")).hexdigest()

    payload = {
        "measuredAt": datetime.now(timezone.utc).isoformat(),
        "harnessSha": sha,
        "probeSha256": probe_hash,
        "competitorVersion": getattr(headroom, "__version__", "unknown"),
        "claims": {},
    }
    # A DEGRADED COMPETITOR MEASURES AS A WEAKER COMPETITOR, SILENTLY.
    #
    # Both of their optional paths fail soft, and both change the numbers
    # without changing the exit code. A cold HF cache leaves the Kompress
    # tokenizer uninstantiable and the code fixture comes back uncompressed
    # (bytesOut 7680, elidesBodies false); a missing tree-sitter degrades the
    # same claim differently (bytesOut 6019, signaturesOut 36). Either one
    # writes a claims file that understates them, and every downstream gate
    # then compares our output against a competitor that was not running.
    #
    # Both report through logging on the `headroom` hierarchy, so one handler
    # catches them -- including whichever optional path they add next.
    degradations: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            degradations.append(record.getMessage())

    competitor_log = logging.getLogger("headroom")
    capture = _Capture(level=logging.WARNING)
    competitor_log.addHandler(capture)
    previous_level = competitor_log.level
    competitor_log.setLevel(min(previous_level or logging.WARNING, logging.WARNING))
    try:
        for name, fn in CLAIMS.items():
            payload["claims"][name] = fn()
            print(name, json.dumps(payload["claims"][name]))
    finally:
        competitor_log.removeHandler(capture)
        competitor_log.setLevel(previous_level)

    if degradations:
        print(
            "the competitor ran degraded, so these numbers do not describe it:",
            file=sys.stderr,
        )
        for message in dict.fromkeys(degradations):
            print(f"  {message}", file=sys.stderr)
        print("nothing written.", file=sys.stderr)
        return 4

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("wrote", out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
