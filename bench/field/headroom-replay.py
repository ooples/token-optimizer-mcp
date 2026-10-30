"""Score Alternative A (HeadRoom) on the same recorded tool outputs as our compactor.

compaction-replay.mjs --dump writes one JSON line per real Bash/PowerShell/Grep
result from the local transcripts: its pattern, the raw text the model received,
and what our compactor in that tree left in context. This hands THE SAME BYTES to
their text-native entry points and reports, per pattern, the tokens each side
leaves in context.

FAIRNESS, AS IN run-theirs.py. Their arms are configured exactly as
bench/compression/alt-a/run-theirs.py configures them -- ContentRouter with
enable_code_aware, smart_crush_tool_output with compaction (their lossless
default), and the lossy CCR crusher (their analogue of our spill) -- and the
SMALLEST output of the three is taken per result. A budget we chose never beats
them; their best arm does or does not.

SIZE IS NOT THE ONLY COLUMN. A compressor that rewrites a file the agent is
about to edit, or drops the one failing test from a build log, wins on size and
loses the turn. So both sides are also scored on:
  * read exact     -- for file reads (read:shell), the share left byte-exact;
  * signal visible -- for every result, the share of error/failure lines still
                      visible in context without a retrieval round trip (a
                      search hit regrouped by file counts by its line:text).
Both are measured on what each side leaves in context, never assumed.

Tokens are characters / 4 on both sides: their own MockTokenCounter's rule and
the estimator compaction-replay.mjs reports, so one denominator scores both.

Usage:
    python bench/field/headroom-replay.py <dump.jsonl> [--json out.json] [--workers N]
"""

import json
import math
import re
import sys
from collections import OrderedDict
from multiprocessing import Pool

# Errors and failures, not warnings: a build log is mostly warnings, and a
# compactor that keeps every error while dropping repeated warnings is doing its
# job -- counting warnings would score that as a loss.
SIGNAL = re.compile(
    r"\b(error|errors|fail|failed|failure|failures|exception|panic|traceback|fatal)\b|✕|✗",
    re.IGNORECASE,
)
# `path:line:text`. Grouping by file (ours) prints the path once and then
# `line:text`, so a hit line counts as visible when its `line:text` part is.
# `grep -A/-B` context lines use `path-line-text`; they regroup the same way.
HIT = re.compile(r"^(.+?)[:-](\d+)[:-](.*)$")


def tokens(text):
    return math.ceil(len(text) / 4)


def arm_router(text):
    from headroom.transforms.content_router import ContentRouter, ContentRouterConfig

    cfg = ContentRouterConfig()
    cfg.enable_code_aware = True
    result = ContentRouter(cfg).compress(text, context="", question=None)
    for attr in ("compressed", "content", "text", "output"):
        value = getattr(result, attr, None)
        if isinstance(value, str):
            return value
    # NOT the input. Returning the text unchanged scored an API we no longer
    # recognise as "HeadRoom removed nothing", which is a claim about them.
    raise TypeError("ContentRouter result has none of compressed/content/text/output")


def arm_crusher(text):
    from headroom.transforms.smart_crusher import smart_crush_tool_output

    crushed, _modified, _info = smart_crush_tool_output(text, with_compaction=True)
    return crushed


def arm_crusher_lossy(text):
    from headroom.config import CCRConfig
    from headroom.transforms.smart_crusher import smart_crush_tool_output

    ccr = CCRConfig(enabled=True, inject_retrieval_marker=True, min_items_to_cache=1)
    crushed, _modified, _info = smart_crush_tool_output(
        text, ccr_config=ccr, with_compaction=False, lossless_only=False
    )
    return crushed


ARMS = (("router", arm_router), ("crusher", arm_crusher), ("crusher-lossy-ccr", arm_crusher_lossy))


def signal_lines(text):
    return [line.strip() for line in text.splitlines() if line.strip() and SIGNAL.search(line)]


def visible(line, out):
    if line in out:
        return True
    hit = HIT.match(line)
    return bool(hit) and any("%s%s%s" % (hit.group(2), sep, hit.group(3)) in out for sep in ":-")


def visible_share(raw_signal, out):
    if not raw_signal:
        return None
    return sum(1 for line in raw_signal if visible(line, out)) / len(raw_signal)


def theirs(text):
    """Their best (smallest) arm, and the arms that raised on this input.

    An arm that raises is a no-op for THIS input, never a drop -- but it is
    counted and reported, so a mid-run failure cannot quietly score as
    "HeadRoom removed nothing".
    """
    best_name, best, errors = "none", text, []
    for name, fn in ARMS:
        try:
            out = fn(text)
        except Exception:  # noqa: BLE001 -- scored as unchanged, but counted
            errors.append(name)
            continue
        if isinstance(out, str) and len(out) < len(best):
            best_name, best = name, out
    return best_name, best, errors


def probe_arms():
    """Fail fast: every arm must run once before the pool starts.

    Without this a missing or incompatible headroom package made all three arms
    raise on every input, and the report showed HeadRoom removing 0% with no
    warning at all.
    """
    import importlib.metadata

    version = importlib.metadata.version("headroom-ai")
    sample = "\n".join("src/a%d.py:%d: error: name 'x' is not defined" % (i, i) for i in range(40))
    for name, fn in ARMS:
        try:
            out = fn(sample)
        except Exception as exc:  # noqa: BLE001
            raise SystemExit("HeadRoom arm %s failed on the probe (headroom-ai %s): %r" % (name, version, exc))
        if not isinstance(out, str):
            raise SystemExit("HeadRoom arm %s returned %s, not text" % (name, type(out).__name__))
    probe_text_model(version)
    return version


def warm_worker():
    """Load the text model in this worker before its first scored result."""
    arm_router("The build finished and every test passed. " * 60)


def probe_text_model(version):
    """The router's PROSE path must actually run, not fall back to passthrough.

    Without the [ml] extra the Kompress model never loads, and ContentRouter
    returns plain text unchanged WITHOUT raising -- so every arm passed the probe
    above, `arm_errors` stayed empty, and prose scored as "HeadRoom removed 0%",
    understating them on every issue body and log line of English. Checked by
    outcome: a long repetitive paragraph must come back shorter. The model is
    also warmed here, once per worker, so the first scored result does not pay
    its load or fall back while it is still loading.
    """
    from headroom.transforms.content_router import ContentRouter, ContentRouterConfig

    cfg = ContentRouterConfig()
    cfg.enable_code_aware = True
    prose = "The build finished and every test in the suite passed on the first attempt. " * 120
    result = ContentRouter(cfg).compress(prose, context="", question=None)
    if not result.savings_percentage > 0:
        raise SystemExit(
            "HeadRoom's text model did not run (headroom-ai %s, strategy %s, 0%% saved on prose). "
            "Install headroom-ai[ml]==%s; a comparison without it understates HeadRoom."
            % (version, result.strategy_used, version)
        )


def score(line):
    item = json.loads(line)
    if item.get("recorded"):
        return None
    raw = item["text"]
    ours = item["out"] if item.get("out") is not None else raw
    arm, their, errors = theirs(raw)
    sig = signal_lines(raw)
    return {
        "pattern": item["pattern"],
        "raw": tokens(raw),
        "ours": tokens(ours),
        "theirs": tokens(their),
        "arm": arm,
        "errors": errors,
        "ours_exact": ours == raw,
        "theirs_exact": their == raw,
        "signal": len(sig),
        "ours_signal": visible_share(sig, ours),
        "theirs_signal": visible_share(sig, their),
    }


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4

    version = probe_arms()
    print("headroom-ai %s" % version)
    with open(path, encoding="utf-8") as handle:
        lines = [line for line in handle if line.strip()]
    # Each worker loads the text model itself; warmed before it scores anything.
    with Pool(workers, initializer=warm_worker) as pool:
        scored = [s for s in pool.imap(score, lines, chunksize=16) if s is not None]

    rows = OrderedDict()
    for s in scored:
        for key in (s["pattern"], "TOTAL"):
            row = rows.setdefault(
                key,
                {"pattern": key, "n": 0, "raw": 0, "ours": 0, "theirs": 0, "arms": {}, "arm_errors": {},
                 "reads": 0, "ours_exact": 0, "theirs_exact": 0,
                 "signal_n": 0, "ours_signal": 0.0, "theirs_signal": 0.0},
            )
            row["n"] += 1
            row["raw"] += s["raw"]
            row["ours"] += s["ours"]
            row["theirs"] += s["theirs"]
            row["arms"][s["arm"]] = row["arms"].get(s["arm"], 0) + 1
            for name in s["errors"]:
                row["arm_errors"][name] = row["arm_errors"].get(name, 0) + 1
            if s["pattern"] == "read:shell":
                row["reads"] += 1
                row["ours_exact"] += s["ours_exact"]
                row["theirs_exact"] += s["theirs_exact"]
            if s["signal"]:
                row["signal_n"] += 1
                row["ours_signal"] += s["ours_signal"]
                row["theirs_signal"] += s["theirs_signal"]

    pct = lambda part, whole: (100.0 * part / whole) if whole else 0.0
    fmt = lambda n: "{:,}".format(n)
    print("| pattern | results | raw tokens | ours (tokens, removed) | HeadRoom best (tokens, removed) "
          "| read exact: ours / HeadRoom | signal visible: ours / HeadRoom |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    ordered = sorted((r for r in rows.values() if r["pattern"] != "TOTAL"), key=lambda r: -r["raw"])
    ordered.append(rows["TOTAL"])
    for r in ordered:
        exact = ("%.1f%% / %.1f%%" % (pct(r["ours_exact"], r["reads"]), pct(r["theirs_exact"], r["reads"]))
                 if r["reads"] else "n/a")
        signal = ("%.1f%% / %.1f%%" % (pct(r["ours_signal"], r["signal_n"]), pct(r["theirs_signal"], r["signal_n"]))
                  if r["signal_n"] else "n/a")
        print("| %s | %s | %s | %s (%.1f%%) | %s (%.1f%%) | %s | %s |" % (
            r["pattern"], fmt(r["n"]), fmt(r["raw"]),
            fmt(r["ours"]), pct(r["raw"] - r["ours"], r["raw"]),
            fmt(r["theirs"]), pct(r["raw"] - r["theirs"], r["raw"]),
            exact, signal))
    total = rows.get("TOTAL", {})
    print("\nbest arm per result: %s" % json.dumps(total.get("arms", {})))
    print("arm errors (results on which an arm raised): %s" % json.dumps(total.get("arm_errors", {})))
    if out_json:
        with open(out_json, "w", encoding="utf-8") as handle:
            json.dump(list(rows.values()), handle, indent=2)


if __name__ == "__main__":
    main()
