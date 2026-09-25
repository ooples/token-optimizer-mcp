"""Generate HeadRoom's own fixtures and run THEIR compressor over them.

WHY THIS FILE EXISTS AT ALL. The head-to-head numbers this project quotes were
produced by throwaway scripts that no longer exist, which means the headline was
unreproducible -- nobody, including me, could re-derive it. A claim that cannot
be re-run is a claim that cannot be checked, so the harness is committed and the
numbers are regenerated rather than remembered.

FAIRNESS IS THE WHOLE DESIGN. Twice in this work a flattering result turned out
to be the COMPETITOR misconfigured, and once an unflattering one turned out to
be OUR side misconfigured. So their side gets every entry point their own
benchmarks use, and the best result per workload wins:

  router    ContentRouter.compress over the serialised payload, with
            enable_code_aware on. Their content-type dispatcher.
  crusher   smart_crush_tool_output, their tool-output specialist, with
            compaction on -- the lossy-first mode that reduces most.
  pipeline  CacheAligner -> SmartCrusher -> ContentRouter over the MESSAGE LIST,
            which is what `benchmarks/bench_transforms.py` calls and what their
            docstring names as the production order. Conversation fixtures are
            natively message lists, so this is their native path for them.

AND THE BUDGET IS SWEPT. `pipeline.apply` compresses TO A LIMIT: give it a
model_limit above the payload and it correctly does nothing, which would show up
as "0% reduction" and read like a defeat that is really an instruction. Their own
`test_pipeline_rag` asserts only `tokens_after <= tokens_before * 1.01` -- they
do not claim reduction at that ratio. So the limit is swept from generous to
punishing and their best is taken, because a budget we chose must never be the
thing that beats them.

Stage configuration is copied verbatim from `benchmarks/conftest.py`:
SmartCrusher with min_tokens_to_crush=0 ("always crush") and
max_items_after_crush=15, CacheAligner with whitespace normalisation on.

Token counting is theirs too -- 4 chars = 1 token, from their MockTokenCounter --
so both arms are scored on the same denominator rather than on two estimators
that happen to disagree.

Usage:
    python bench/compression/headroom/run-theirs.py <headroom-clone> <out-dir>
    python bench/compression/headroom/run-theirs.py - <out-dir> --extra <payloads.json>

`--extra` carries payloads this script did not generate -- our own twelve
fixtures, exported by `node bench/compression/export-payloads.mjs`. Carried and
generated payloads are driven identically: the same three entry points, the
same budget sweep, the same best-of. A clone of `-` skips their generators.

Writes <out-dir>/payloads.json (the exact bytes our side must compress) and
<out-dir>/theirs.json (their best result per workload, with the arm named).
"""

import json
import os
import sys
import time

# APPENDED, NOT PREPENDED. The clone ships a `headroom` package without the
# compiled _core extension; the installed wheel has it. Prepending the clone
# shadows the wheel and the router fails to import, so the clone goes LAST and
# supplies only `benchmarks`, which the wheel does not ship.
# A CLONE OF `-` MEANS "NOT GENERATING THEIR FIXTURES HERE". Every compressor
# this script drives comes from the installed wheel; the clone supplies only
# `benchmarks`, their fixture generators. A run that carries its own payloads
# therefore needs no clone, and refusing to start without one would mean their
# binary could never be measured on anybody else's workload.
CLONE = sys.argv[1]
OUT = sys.argv[2]
EXTRA = sys.argv[sys.argv.index("--extra") + 1] if "--extra" in sys.argv else None
if CLONE != "-":
    sys.path.append(CLONE)

import hashlib  # noqa: E402
import random  # noqa: E402

try:
    from benchmarks.scenarios import conversations as C  # noqa: E402
    from benchmarks.scenarios import tool_outputs as T  # noqa: E402

    HAVE_THEIR_FIXTURES = True
except ImportError:
    C = T = None
    HAVE_THEIR_FIXTURES = False


def tokens(text):
    """Their estimator, from benchmarks/conftest.py MockTokenCounter."""
    return max(1, len(text) // 4)


def text_of(payload):
    """The compressors take text; their generators return dicts and lists."""
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, indent=2)


# Their own seed, so the fixtures are the ones their published numbers use.
random.seed(42)

# `native` is the generator's own return value -- a message list for the two
# conversation workloads, which is what their pipeline consumes. `text` is the
# serialisation both sides are scored on.
# Named once, so the provenance block can say which rows were theirs.
THEIR_FIXTURE_NAMES = (
    "log-entries", "search-results", "api-responses",
    "database-rows", "agentic-conversation", "rag-conversation",
)

WORKLOADS = {}
if HAVE_THEIR_FIXTURES:
    WORKLOADS.update(
        {
            "log-entries": T.generate_log_entries(400),
            "search-results": T.generate_search_results(300),
            "api-responses": T.generate_api_responses(200),
            "database-rows": T.generate_database_rows(300),
            "agentic-conversation": C.generate_anthropic_agentic_conversation(12),
            "rag-conversation": C.generate_rag_conversation(40000),
        }
    )

# CARRIED PAYLOADS GET THE IDENTICAL TREATMENT, which is the only reason they
# may be compared. They enter as `native` -- the generator's own shape -- so a
# message list stays a message list and their pipeline sees its native path,
# exactly as their own fixtures do. Serialising ours to a flat string first
# would hand them a worse entry point on our workloads than on theirs, and the
# difference would read as their capability rather than as our harness.
def is_messages(native):
    """A message list, as opposed to the item list a tool generator returns."""
    return (
        isinstance(native, list)
        and native
        and all(isinstance(m, dict) and "role" in m for m in native)
    )


if EXTRA:
    with open(EXTRA, encoding="utf-8") as handle:
        carried = json.load(handle)
    for name in sorted(carried):
        if name in WORKLOADS:
            raise SystemExit("carried payload %r collides with one of theirs" % name)
        value = carried[name]
        # A CARRIER THAT FLATTENS A CONVERSATION CHANGES WHAT IS BEING MEASURED.
        #
        # `payloads.json` holds `text_of(value)` -- the bytes OUR side compresses
        # -- so a conversation comes back as one long JSON string. Feed that
        # string back in here and `is_messages` says no, `as_messages` wraps the
        # whole conversation inside a single synthetic tool_result, and their
        # pipeline CCR-offloads the lot: 131,444 chars to 665 on code-search.
        # That is a shape no proxy ever produces. Handed the SAME workload in its
        # native message-list form, their pipeline declines on 10 of our 12, and
        # `crusher`/`router` carry them instead.
        #
        # Both regimes were captured and published as if they measured the same
        # thing. They do not, and the difference is up to 200x on a workload, so
        # the lossy one is refused rather than detected afterwards. Use the
        # `natives.json` this script writes; `payloads.json` is for our side.
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except ValueError:
                parsed = None
            if is_messages(parsed):
                raise SystemExit(
                    "carried payload %r is a conversation that was flattened to text. "
                    "Pass <out-dir>/natives.json, not payloads.json: wrapping it again "
                    "hands their pipeline a whole conversation inside one tool_result "
                    "and measures a shape no proxy produces." % name
                )
        WORKLOADS[name] = value

if not WORKLOADS:
    raise SystemExit(
        "no workloads. Pass a headroom clone for their fixtures, "
        "--extra <payloads.json> for carried ones, or both."
    )

PAYLOADS = {name: text_of(value) for name, value in WORKLOADS.items()}


def question_of(native):
    """The last user turn, which is what a RAG query actually is.

    THEIR ROUTER TAKES A QUESTION and prunes prose by relevance against it.
    Passing None disables that -- and RAG is precisely the workload where a
    question exists, so withholding it would hand them a 0% on the one fixture
    their relevance engine is built for and call it their capability. Their own
    generator emits the queries; this reads one back out.
    """
    if not isinstance(native, list):
        return None
    for message in reversed(native):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content
    return None


def arm_router(text, question=None):
    from headroom.transforms.content_router import ContentRouter, ContentRouterConfig

    cfg = ContentRouterConfig()
    cfg.enable_code_aware = True
    result = ContentRouter(cfg).compress(text, context="", question=question)
    for attr in ("compressed", "content", "text", "output"):
        value = getattr(result, attr, None)
        if isinstance(value, str):
            return value
    # No string attribute means the arm produced nothing usable, which is a
    # no-op for scoring -- never a crash that silently drops their best result.
    return text


def arm_crusher(text):
    """Their default: lossless-first. Flattens JSON to CSV, keeps every row."""
    from headroom.transforms.smart_crusher import smart_crush_tool_output

    crushed, _modified, _info = smart_crush_tool_output(text, with_compaction=True)
    return crushed


def arm_crusher_lossy(text):
    """Their AGGRESSIVE mode, and the one that matches what we do.

    THIS ARM EXISTS BECAUSE THE COMPARISON WAS OTHERWISE MISMATCHED. Their
    default path is lossless -- it reshapes 300 JSON rows into CSV and keeps all
    300, earning 63% and a `<headroom:tool_digest>` marker. Ours drops rows to a
    spill and earns 98%. Those are different guarantees, and scoring our lossy
    path against their lossless one would be a win by category error.

    `with_compaction=False` selects their legacy lossy path, and CCR is their
    recovery mechanism for it: the dropped items go to a compression store and a
    retrieval marker tells the model how to ask for them back. That is the exact
    analogue of our spill -- a marker in context, the bytes elsewhere -- so this
    is the arm the headline has to beat.
    """
    from headroom.config import CCRConfig
    from headroom.transforms.smart_crusher import smart_crush_tool_output

    ccr = CCRConfig(
        enabled=True,
        inject_retrieval_marker=True,
        min_items_to_cache=1,
    )
    crushed, _modified, _info = smart_crush_tool_output(
        text,
        ccr_config=ccr,
        with_compaction=False,
        lossless_only=False,
    )
    return crushed


def _pipeline():
    from unittest.mock import Mock

    from headroom.config import CacheAlignerConfig, SmartCrusherConfig
    from headroom.transforms.cache_aligner import CacheAligner
    from headroom.transforms.content_router import ContentRouter, ContentRouterConfig
    from headroom.transforms.pipeline import TransformPipeline
    from headroom.transforms.smart_crusher import SmartCrusher

    crusher_cfg = SmartCrusherConfig(
        enabled=True,
        min_items_to_analyze=5,
        min_tokens_to_crush=0,
        max_items_after_crush=15,
        variance_threshold=2.0,
    )
    aligner_cfg = CacheAlignerConfig(
        enabled=True,
        normalize_whitespace=True,
        collapse_blank_lines=True,
    )
    router_cfg = ContentRouterConfig()
    router_cfg.enable_code_aware = True

    class Counter:
        def count_text(self, text):
            return tokens(text)

        def count_message(self, message):
            content = message.get("content", "")
            if isinstance(content, str):
                return self.count_text(content) + 4
            total = 0
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        total += self.count_text(json.dumps(block))
            return total + 4

        # REQUIRED, not optional. Their `Tokenizer` DELEGATES count_messages to
        # the wrapped counter rather than deriving it, so omitting this made
        # every pipeline arm raise AttributeError and score as a no-op -- their
        # native conversation path silently excluded from the comparison.
        def count_messages(self, messages):
            return sum(self.count_message(m) for m in messages)

    provider = Mock()
    provider.get_token_counter.return_value = Counter()

    # Production order, from their own docstring: CacheAligner -> SmartCrusher,
    # "followed by ContentRouter in production".
    return TransformPipeline(
        transforms=[
            CacheAligner(aligner_cfg),
            SmartCrusher(crusher_cfg),
            ContentRouter(router_cfg),
        ],
        provider=provider,
    )


def as_messages(native, text):
    """The shape their pipeline consumes.

    Tool-output generators return a list of ITEMS, not messages. Handing that
    straight to `pipeline.apply` made every tool-output pipeline arm return its
    input untouched -- not their compressor declining, just their compressor
    handed something that is not a conversation. A proxy sees a tool output as
    a tool_result block inside a user turn, so that is the shape it gets.
    """
    if is_messages(native):
        return native
    return [
        {"role": "user", "content": "Run the tool."},
        {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "t1", "name": "query", "input": {}}],
        },
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "t1", "content": text}],
        },
    ]


def arm_pipeline(native, text, limit):
    """Their message-list path. Returns the serialised result, or None."""
    messages = as_messages(native, text)
    result = _pipeline().apply(messages, "benchmark-model", model_limit=limit)
    out = getattr(result, "messages", result)
    if not isinstance(out, list):
        return None
    return json.dumps(out, indent=2)


def run(name, native, text):
    """Every arm, best (smallest) output wins. Failures are reported, not hidden."""
    attempts = []
    notes = {}
    # WALL TIME PER ARM, so the scorer can compare speed instead of assuming it.
    # `perf_counter` and not `time.time`: several of these arms finish in well
    # under a millisecond, and a coarse clock reports those as zero, which reads
    # as an arm that never ran. Only the winning arm's time is published, since
    # that is the arm whose output the comparison uses.
    timings = {}
    question = question_of(native)

    # KEPT AS CALLABLES, because the winning arm is re-timed below and a
    # median needs the function, not just its first reading.
    callables = {}
    for label, fn in (
        ("router", lambda t: arm_router(t, question=None)),
        ("router+question", lambda t: arm_router(t, question=question)),
        ("crusher", arm_crusher),
        ("crusher-lossy-ccr", arm_crusher_lossy),
    ):
        callables[label] = (fn, (text,))
        if label == "router+question" and not question:
            continue
        try:
            started = time.perf_counter()
            got = fn(text)
            timings[label] = (time.perf_counter() - started) * 1000.0
            attempts.append((label, got))
        except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
            notes[label] = "%s: %s" % (type(exc).__name__, exc)

    # SWEPT, so their budget is never the reason they lose. The payload's own
    # token count anchors the sweep: a limit at 10% of it is punishing, a limit
    # at 200% asks for nothing.
    before_tokens = tokens(text)
    # The pipeline is scored against its OWN before-text, because a wrapped tool
    # output carries envelope bytes the raw text does not. Charging them for an
    # envelope this harness added would be the same denominator error in the
    # other direction. The scorer converts it to a ratio; both texts are handed
    # over so it can do that with a real tokeniser rather than a proxy.
    wrapped_before_text = json.dumps(as_messages(native, text), indent=2)
    wrapped_before = len(wrapped_before_text)
    wrapped = {}
    for fraction in (0.1, 0.25, 0.5, 0.75, 1.0, 2.0):
        limit = max(1, int(before_tokens * fraction))
        label = "pipeline@%.2f" % fraction
        callables[label] = (
            lambda t, lim=limit: arm_pipeline(native, t, lim),
            (text,),
        )
        try:
            started = time.perf_counter()
            got = arm_pipeline(native, text, limit)
            timings[label] = (time.perf_counter() - started) * 1000.0
            if got is None:
                continue
            attempts.append((label, got))
            wrapped[label] = wrapped_before_text
        except Exception as exc:  # noqa: BLE001
            notes[label] = "%s: %s" % (type(exc).__name__, exc)

    if not attempts:
        return {
            "before": len(text),
            "after": len(text),
            "beforeTokens": before_tokens,
            "afterTokens": before_tokens,
            "arm": "none",
            "ms": 0.0,
            "msMin": 0.0,
            "msMax": 0.0,
            "msSamples": [],
            "bestText": text,
            "notes": notes,
        }

    # SCORED ON THE RATIO THE ARM ACHIEVED, so the pipeline's envelope neither
    # flatters nor penalises it. For the text-native arms the two denominators
    # are the same string and the ratio is exactly what it looks like.
    def reduction(pair):
        label, out = pair
        base = len(wrapped.get(label, text))
        return len(out) / base if base else 1.0

    arm, best = min(attempts, key=reduction)
    ratio = reduction((arm, best))
    # REPEATED READINGS OF THE WINNING ARM, MEDIAN PUBLISHED. The sweep above
    # times each arm once, which is enough to pick a winner and not enough to
    # compare against ours: a single reading of a sub-second call is partly a
    # reading of the machine. Only the winner is repeated, because only the
    # winner is the arm the comparison uses, and repeating all ten would spend
    # ten times the wall clock to time nine arms nobody scores.
    samples = [timings.get(arm, 0.0)]
    fn_args = callables.get(arm)
    if fn_args is not None:
        fn, args = fn_args
        # THIRTY MORE, FOR THIRTY-ONE IN ALL. The node side takes the same
        # number for the same reason: the scorer compares tails, not just
        # medians, and eleven readings put a lone spike on the tail it reads.
        for _ in range(30):
            try:
                started = time.perf_counter()
                fn(*args)
                samples.append((time.perf_counter() - started) * 1000.0)
            except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
                notes["retime:" + arm] = "%s: %s" % (type(exc).__name__, exc)
                break
    # RUN ORDER PRESERVED for the same reason the node side preserves it: the
    # first reading carries the import and the first-call cost, and a consumer
    # that cannot see which one was first cannot tell warm-up from variance.
    ordered = [round(v, 3) for v in samples]
    samples = sorted(samples)
    return {
        "before": len(text),
        "after": round(len(text) * ratio),
        "beforeTokens": before_tokens,
        "afterTokens": max(1, round(before_tokens * ratio)),
        "arm": arm,
        "ms": round(samples[(len(samples) - 1) // 2], 3),
        "msMin": round(samples[0], 3),
        "msMax": round(samples[-1], 3),
        "msSamples": ordered,
        "arms": {label: round(reduction((label, out)) * len(text)) for label, out in attempts},
        # EVERY ARM'S BYTES, NOT ONLY THE WINNER'S.
        #
        # The winner above is chosen by compression ratio, which is the right
        # rule for a compression claim and the WRONG one for a retention claim:
        # it systematically selects their most lossy arm, and the scorer then
        # reports how much that arm lost. That comparison had a thumb on it in
        # our favour, and nothing downstream could correct for it, because the
        # sizes recorded in `arms` above cannot be rescored -- only text can.
        #
        # So every attempt's output is kept. The scorer picks their best arm
        # PER METRIC: the ratio winner for compression, the arm that actually
        # retained most for retention. Costs ~20MB in a gitignored directory.
        "armTexts": {label: out for label, out in attempts},
        "armBeforeTexts": {label: wrapped.get(label, text) for label, _ in attempts},
        # The actual bytes, so the scorer can tokenise their output with the
        # same real tokeniser it uses on ours instead of trusting a proxy.
        "bestText": best,
        "bestBeforeText": wrapped.get(arm, text),
        "notes": notes,
    }


results = {}
for name, native in WORKLOADS.items():
    results[name] = run(name, native, PAYLOADS[name])
    row = results[name]
    pct = (1 - row["after"] / row["before"]) * 100
    print("%-24s %8d -> %8d  %5.1f%%  via %s" % (name, row["before"], row["after"], pct, row["arm"]))
    for label, note in row.get("notes", {}).items():
        print("    %s failed: %s" % (label, note))

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "payloads.json"), "w", encoding="utf-8") as handle:
    json.dump(PAYLOADS, handle)
# THE SHAPE, NOT JUST THE BYTES. `payloads.json` is what our side compresses and
# is deliberately flat. `natives.json` is what a replay must be given, because
# only it can tell their engine a conversation from a tool output.
with open(os.path.join(OUT, "natives.json"), "w", encoding="utf-8") as handle:
    json.dump(WORKLOADS, handle)
# THE STORE STATE IS PART OF THE MEASUREMENT, so it is recorded with it.
#
# WHY THIS BLOCK EXISTS. Their `pipeline@*` arms hand blocks to a DURABLE CCR
# store at ~/.headroom/ccr_store.db, so what those arms return depends on what
# is already in it -- and nothing in this script used to record which state it
# ran against. A capture taken against one store was published and compared,
# workload by workload, against captures taken against another. On the twelve
# carried workloads the `router`, `crusher` and `crusher-lossy-ccr` arms agree
# byte for byte across runs; the `pipeline` arms vary by up to 100x. Every
# published per-workload verdict that turned on a pipeline arm was therefore
# comparing two different experiments.
#
# A digest cannot make the runs comparable, but it makes them VISIBLY
# incomparable, which is the difference between a wrong number and a known one.
def _headroom_version():
    """Read from installed metadata: the script never imports the package itself."""
    try:
        import importlib.metadata as _md
        return _md.version("headroom-ai")
    except Exception:  # noqa: BLE001
        return "unknown"


store_path = os.path.join(os.path.expanduser("~"), ".headroom", "ccr_store.db")
store = {"path": store_path, "present": os.path.exists(store_path)}
if store["present"]:
    with open(store_path, "rb") as handle:
        store["bytes"] = os.path.getsize(store_path)
        store["sha256"] = hashlib.sha256(handle.read()).hexdigest()[:16]
else:
    store["bytes"] = 0
    store["sha256"] = None

# AN ARM THAT RETURNS ITS INPUT IS NOT THE SAME AS AN ARM THAT DECLINES, AND
# THE DIFFERENCE IS INVISIBLE IN THE SCORE. Both land at ratio 1.0, so both are
# published as "their engine achieved nothing on this workload" -- which is a
# claim about THEM, made out of a silence that is just as likely to be ours.
#
# It happened. Three captures on 2026-09-24/25 scored every `pipeline@*` arm as
# a no-op on 10 of 12 workloads -- exactly the 10 that are tool output rather
# than a conversation -- while `crusher` and `router` returned normal figures.
# Every later capture (five of them, with a warm store, with no store at all,
# with and without their clone) offloads on all 12 and agrees byte for byte.
# The published record was taken from the inert regime, so it understated their
# engine by up to 200x per workload, and nothing in the output said so.
#
# The count below is the trip-wire. It cannot say WHICH of the two a no-op was,
# and it does not try: it records the shape so a reader and a downstream gate
# can see an arm that has gone quiet, instead of reading its silence as a win.
inert = {}
for label in sorted({label for r in results.values() for label in r.get("arms", {})}):
    ran = [r for r in results.values() if label in r.get("arms", {})]
    inert[label] = {
        "ranOn": len(ran),
        "returnedInputUnchanged": sum(1 for r in ran if r["arms"][label] == r["before"]),
    }
for label, counts in inert.items():
    if counts["ranOn"] and counts["returnedInputUnchanged"] * 2 > counts["ranOn"]:
        print(
            "WARNING: arm %s returned its input unchanged on %d of %d workloads. "
            "That is scored as zero reduction for them; check it is their engine "
            "declining and not this harness feeding it a shape it cannot read."
            % (label, counts["returnedInputUnchanged"], counts["ranOn"])
        )

provenance = {
    "headroomVersion": _headroom_version(),
    "python": sys.version.split()[0],
    # AFTER the run, deliberately: the arms write to it, so the state that
    # matters for reproducing this capture is the one the next run inherits.
    "ccrStoreAfterRun": store,
    "theirFixtures": HAVE_THEIR_FIXTURES,
    "carriedPayloads": sorted(set(WORKLOADS) - set(THEIR_FIXTURE_NAMES)),
    "inertArms": inert,
}
print("ccr store after run: %s bytes, sha %s" % (store["bytes"], store["sha256"]))

with open(os.path.join(OUT, "theirs.json"), "w", encoding="utf-8") as handle:
    json.dump({"__provenance__": provenance, **results}, handle, indent=2)

total_before = sum(r["before"] for r in results.values())
total_after = sum(r["after"] for r in results.values())
print(
    "TOTAL %d -> %d  %.1f%% chars" % (total_before, total_after, (1 - total_after / total_before) * 100)
)
print("wrote", OUT)
