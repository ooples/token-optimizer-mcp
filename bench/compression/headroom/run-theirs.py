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

# A SLICE OF THE ROSTER, BECAUSE THEIR STORE FORGETS WHILE THE SWEEP IS STILL
# RUNNING. A full sweep takes longer than the 1800s their resolver quotes, so the
# workloads it measures first are already unredeemable by the time it finishes --
# the defect `sweptPerWorkload` below exists to make visible. Running the roster
# in chunks, each resolved before the next starts, is how a capture stays inside
# that window; `merge-chunks.mjs` reassembles them and records the seam.
ONLY = (
    [n for n in sys.argv[sys.argv.index("--only") + 1].split(",") if n]
    if "--only" in sys.argv
    else None
)
CHUNK = sys.argv[sys.argv.index("--chunk") + 1] if "--chunk" in sys.argv else None
if ONLY is not None and CHUNK is not None:
    raise SystemExit("--only and --chunk both select workloads; pass one")
if CLONE != "-":
    sys.path.append(CLONE)

import hashlib  # noqa: E402
import pathlib  # noqa: E402
import sqlite3  # noqa: E402
import random  # noqa: E402

# A DEGRADED COMPETITOR MEASURES AS A WEAKER COMPETITOR, SILENTLY, and until
# now this capture had no way to say so. Their optional paths fail soft and
# say so only on their own logger: on this machine the Kompress model was not
# downloadable ("Kompress model not ready; requests will not be compressed" --
# their own comment at the emission site calls it degraded) and the native
# content detector is off by default on Windows. Both times their engine ran
# with a capability missing, the number recorded for them was smaller for that
# reason, and nothing in the file said which reason it was.
#
# `bench/competitive/probe-headroom.py` has refused to write a claims file
# under exactly this condition since it was written. The head-to-head capture,
# which is where the published table comes from, did not.
#
# UNKNOWN WARNINGS COUNT AS DEGRADATION. The allow-list is for messages that
# are advice about OUR payload rather than a capability of theirs going
# missing; everything else is recorded as degradation, so a path they add next
# cannot arrive as a silent zero that reads like our win.
import logging  # noqa: E402

# THEIR BEST CONFIGURATION WINS, AND THAT INCLUDES THEIR OWN OVERRIDES. Their
# content detector falls back to a pure-Python backend on Windows and says so:
# "native Magika/ONNX detector is unsafe by default on Windows; override with
# HEADROOM_DETECT_BACKEND=rust". A fallback detector routes worse, which makes
# their output bigger and our reduction look better, so the capture asks for
# the native one rather than accepting the weaker default.
#
# `setdefault`, so an operator who has a reason to pin a backend keeps it, and
# the value that actually ran is recorded either way. If the native detector
# fails on this machine, the capture fails loudly instead of quietly measuring
# a degraded competitor -- which is the whole point of the block below.
# Whether the value below is OURS or the operator's, recorded so the published
# note can say "we set their detector to rust" rather than leaving a reader to
# assume it was their default. It is not their default on Windows; it is their
# fastest and strongest backend, which is why we ask for it.
_DETECT_BACKEND_PRESET = os.environ.get("HEADROOM_DETECT_BACKEND")
os.environ.setdefault("HEADROOM_DETECT_BACKEND", "rust")

ADVISORY_SIGNATURES = (
    # Their cache aligner reporting that OUR fixture puts a timestamp in the
    # system prompt, so the cache prefix cannot be stable. Their engine ran;
    # the advice is about the payload we handed it. It is still recorded.
    "cache prefix unstable",
)

COMPETITOR_WARNINGS = {}


class _WarningCapture(logging.Handler):
    """Every WARNING their package emits, deduplicated, with a count."""

    def emit(self, record):  # noqa: D102
        message = record.getMessage()
        seen = COMPETITOR_WARNINGS.setdefault(
            message, {"logger": record.name, "message": message, "count": 0}
        )
        seen["count"] += 1


# INSTALLED BEFORE ANY ARM RUNS, and on the hierarchy root rather than on the
# module that emits today, so a warning from a module they add later is caught
# by the same handler.
_competitor_log = logging.getLogger("headroom")
_competitor_log.addHandler(_WarningCapture(level=logging.WARNING))
_competitor_log.setLevel(min(_competitor_log.level or logging.WARNING, logging.WARNING))


# AND THEIR ML COMPRESSOR HAS TO BE AWAKE BEFORE THE FIRST ARM RUNS.
#
# `ContentRouter` kicks off a background download, warns once per instance that
# the model is not ready, and carries on without it. Every arm in a capture
# finishes long before the load does, so the whole run measured their engine
# with its ML path switched off -- 16 warnings in one capture, and the model
# was already cached on disk for the last of them. Prefetching is not enough;
# the load is asynchronous, so the capture has to WAIT for it.
#
# It is cheap: measured at 8 seconds from a warm cache, once per capture, and
# outside every timed region. Failure is recorded rather than raised -- a
# machine with no HuggingFace access should still be able to take a capture,
# and the gate will refuse to publish it as a comparison.
KOMPRESS_WARMUP_SECONDS = 240


def warm_their_model():
    """Block until their ML compressor is loaded, and say what happened."""
    started = time.time()
    # NOT ON A KNOWN-ANSWER RUN. Those replace the innermost engine call with
    # arithmetic, so their model is not in the picture, and waiting for it would
    # put a HuggingFace download on the critical path of a unit test -- up to the
    # full timeout on a CI runner with no access to it.
    if KNOWN_ANSWER_ARMS:
        return {"ready": None, "waitedSeconds": 0.0, "why": "known-answer run"}

    try:
        from headroom.transforms.kompress_compressor import KompressCompressor

        compressor = KompressCompressor()
        compressor.ensure_background_load()
        while time.time() - started < KOMPRESS_WARMUP_SECONDS:
            if compressor.is_ready():
                return {
                    "ready": True,
                    "waitedSeconds": round(time.time() - started, 1),
                    "why": None,
                }
            time.sleep(1.0)
        return {
            "ready": False,
            "waitedSeconds": round(time.time() - started, 1),
            "why": "not ready within %ds" % KOMPRESS_WARMUP_SECONDS,
        }
    except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
        return {
            "ready": False,
            "waitedSeconds": round(time.time() - started, 1),
            "why": "%s: %s" % (type(exc).__name__, exc),
        }


def is_advisory(message):
    """Advice about our payload, as opposed to a capability of theirs missing."""
    return any(signature in message for signature in ADVISORY_SIGNATURES)


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

import uuid  # noqa: E402

# THEIR FIXTURES MINT IDS WITH uuid4, WHICH THEIR SEED DOES NOT REACH. The seed
# above makes their `random` draws reproducible; it does nothing for the five
# call sites that mint ids through `uuid.uuid4()` -- tool_outputs.py lines 72,
# 174 and 443, conversations.py lines 80 and 242 -- because uuid4 reads
# os.urandom and takes no seed.
#
# SO FOUR OF THE SIX FIXTURES THEY PUBLISH CAME OUT DIFFERENT ON EVERY SWEEP:
# log-entries (trace_id), search-results (uuid), database-rows (reference) and
# agentic-conversation (call_id, tool_use_id). The other two, api-responses and
# rag-conversation, mint nothing and were stable -- which is how this was found.
# The payloads were the same LENGTH and the same shape down to the byte, so
# nothing about the columns looked wrong; only `payloadsDigest` differed, and
# that made two sweeps incomparable. It cost the store-state pair outright:
# store-effect.mjs refuses two captures swept over different payload sets, and
# correctly refused a pair whose arms differed in nothing but their store. It
# would equally have refused any future re-capture of a published record.
#
# A SEEDED DRAW IS NOT A DIFFERENT FIXTURE. Each of those ids is a random hex
# string of a fixed width in their code too; seeding changes which random one,
# never the width, and the width is the only part a compressor can see. The
# seed is ours because they never set one, and it is fixed rather than derived
# so that a capture taken next year is comparable to one taken today.
#
# PATCHING THE MODULE ATTRIBUTE IS ENOUGH, and only because all five sites call
# `uuid.uuid4()` through the module instead of importing the name -- checked, not
# assumed. A site doing `from uuid import uuid4` would keep its own reference and
# stay unseeded, so the digest agreement asserted by the paired sweeper is what
# actually proves this worked.
_UUID_SEED = 42
_uuid_stream = random.Random(_UUID_SEED)
uuid.uuid4 = lambda: uuid.UUID(int=_uuid_stream.getrandbits(128), version=4)

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


# THE ROSTER, RECORDED BEFORE IT IS CUT. A merge of chunks can only tell a
# complete capture from three quarters of one if every chunk names the whole set
# it was cut from. Without it a missing chunk merges into a file that looks
# finished and quietly drops a workload from every total -- which is the same
# class of error as a green gate that ran no tests.
ROSTER = sorted(WORKLOADS)
CHUNK_PROV = None
if ONLY is not None:
    _missing = [n for n in ONLY if n not in WORKLOADS]
    if _missing:
        raise SystemExit("--only names workloads this run does not have: %s" % ", ".join(_missing))
    CHUNK_PROV = {
        "selector": "--only " + ",".join(ONLY),
        "index": None,
        "of": None,
        "names": sorted(set(ONLY)),
    }
if CHUNK is not None:
    try:
        _i, _n = (int(x) for x in CHUNK.split("/"))
    except ValueError:
        raise SystemExit("--chunk wants i/n, got %r" % CHUNK)
    if _n < 1 or not 1 <= _i <= _n:
        raise SystemExit("--chunk wants i/n with 1 <= i <= n, got %r" % CHUNK)
    # CONTIGUOUS OVER THE SORTED ROSTER, so `--chunk 2/4` names the same
    # workloads on every machine and in every rerun. Insertion order would not:
    # their fixtures arrive from their generators and ours from `--extra`, so the
    # boundaries would move with whatever order the payload file happened to be
    # built in, and two chunks of one sweep could then overlap or skip a row.
    _per, _rem = divmod(len(ROSTER), _n)
    _start = (_i - 1) * _per + min(_i - 1, _rem)
    _size = _per + (1 if _i - 1 < _rem else 0)
    CHUNK_PROV = {
        "selector": "--chunk " + CHUNK,
        "index": _i,
        "of": _n,
        "names": ROSTER[_start : _start + _size],
    }
if CHUNK_PROV is not None:
    _keep = set(CHUNK_PROV["names"])
    WORKLOADS = {name: value for name, value in WORKLOADS.items() if name in _keep}
    # AN EMPTY CHUNK IS A BUG IN THE SPLIT, NOT A RUN WITH NOTHING TO DO. Asking
    # for 16 chunks of a 12-workload roster hands four of them nothing, and each
    # would otherwise write a capture that reads as valid with no rows in it.
    if not WORKLOADS:
        raise SystemExit(
            "%s selected none of the %d workloads" % (CHUNK_PROV["selector"], len(ROSTER))
        )
    print(
        "chunk %s: %d of %d workloads -- %s"
        % (CHUNK_PROV["selector"], len(WORKLOADS), len(ROSTER), ", ".join(sorted(WORKLOADS)))
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


def their_apply(messages, limit):
    """The one call that reaches their engine on the message-list path."""
    return _pipeline().apply(messages, "benchmark-model", model_limit=limit)


def their_text_arms(question):
    """Their text-native arms, in the order they are attempted."""
    return (
        ("router", lambda t: arm_router(t, question=None)),
        ("router+question", lambda t: arm_router(t, question=question)),
        ("crusher", arm_crusher),
        ("crusher-lossy-ccr", arm_crusher_lossy),
    )


def arm_pipeline(native, text, limit):
    """Their message-list path. Returns the serialised result, or None."""
    messages = as_messages(native, text)
    result = APPLY(messages, limit)
    out = getattr(result, "messages", result)
    if not isinstance(out, list):
        return None
    return json.dumps(out, indent=2)


# THE ENGINE IS SUBSTITUTABLE -- TO TEST THIS HARNESS, NEVER TO PUBLISH.
#
# Everything above measures THEIR compressor, and nothing in this file can tell
# you whether the measurement is sound. The arms are a black box, so a bug in
# the shape routing, the denominator, the arm selection or the inert trip-wire
# reads as "their engine did that" and gets published as a fact about them. It
# has: the carrier bug below moved a single workload's figure by 200x and was
# written up twice, in opposite directions, before a control settled it.
#
# BENCH_KNOWN_ANSWER_ARMS names a module of arms whose output is known by
# construction -- one that returns its input, one that returns exactly half of
# it, one that returns an offload marker. Their ratios are arithmetic, so a
# capture taken with them has a right answer that can be worked out on paper,
# and this harness can be proven wrong instead of trusted. Note what is NOT
# stubbed: `as_messages`, the budget sweep, the scoring, the arm selection and
# the trip-wire all run for real, which is the point -- they are the code under
# test. Only the innermost engine call is replaced.
#
# A capture taken this way measures nobody's engine, so it stamps `stubArms`
# into the provenance and the scorer refuses to read it as a result.
KNOWN_ANSWER_ARMS = os.environ.get("BENCH_KNOWN_ANSWER_ARMS")
TEXT_ARMS = their_text_arms
APPLY = their_apply
if KNOWN_ANSWER_ARMS:
    import importlib.util  # noqa: E402

    _spec = importlib.util.spec_from_file_location("bench_ka_arms", KNOWN_ANSWER_ARMS)
    if _spec is None or _spec.loader is None:
        raise SystemExit("cannot load BENCH_KNOWN_ANSWER_ARMS=%r" % KNOWN_ANSWER_ARMS)
    _stub = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_stub)
    TEXT_ARMS = _stub.text_arms
    APPLY = _stub.apply
    print("KNOWN-ANSWER RUN via %s -- this measures the harness, not an engine" % KNOWN_ANSWER_ARMS)


KOMPRESS_WARMUP = warm_their_model()
print(
    "their ML compressor: %s after %.1fs%s"
    % (
        "ready" if KOMPRESS_WARMUP["ready"] else "NOT READY",
        KOMPRESS_WARMUP["waitedSeconds"],
        "" if KOMPRESS_WARMUP["why"] is None else " (%s)" % KOMPRESS_WARMUP["why"],
    )
)

# EVERY ARM OF EVERY WORKLOAD, KEPT CALLABLE SO IT CAN BE TIMED AGAIN LATER.
# Shape: {workload: {arm: (fn, args)}}. Filled by `run`, drained by the pass
# sweep at the bottom of the file. Every arm, not just the winner, because the
# scorer chooses a second column of its own and an untimed arm cannot be scored.
RETIME = {}

# THREE, THE SAME NUMBER THE NODE SIDE TAKES. The two sides are compared pass
# statistic against pass statistic, so an unequal count would put a different
# estimator on each column.
SPEED_PASSES = 3


# IS THE MACHINE THE SAME MACHINE OUR SIDE WILL BE TIMED ON?
#
# Their arms are timed here, in this Python process, at whatever hour the sweep
# runs. Ours are timed later by head-to-head.mjs in a Node process. Two runs of
# that Node recording, minutes apart on the same capture, moved our own medians
# by 33% to 122% with no code change -- larger than most of the margins the speed
# criterion decides. So a cross-session comparison with no load control is
# decided by the machine rather than by either engine, and the scorer refuses it.
#
# The control is bench/compression/load-witness.mjs: a fixed integer-mixing loop
# with a checksum, spawned HERE, from Python, so that both sides record readings
# of the same work by the same runtime and the two are directly comparable. A
# per-language witness would not be -- 45ms of Python and 45ms of Node measure
# different things.
#
# A reading is taken before the sweep and once more after each pass, and the
# median over all of them is this session's witness. The median, not the minimum:
# the minimum is the best estimate of what the machine CAN do and the wrong one
# here, because a briefly idle moment on a loaded machine yields a clean minimum
# while the long sweep beside it runs slow throughout.
#
# A witness that cannot be taken is recorded as its error, never as a number.
# `witnessesAgree` in the same module treats a missing witness as a refusal, so a
# sweep on a machine without Node produces speed rows that read NOT MEASURED
# instead of rows that read as a controlled comparison.
WITNESS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "load-witness.mjs"
)
witness_readings = []
witness_errors = []


def take_witness(when):
    """One witness reading, appended to the session pool. Errors are recorded."""
    import subprocess

    try:
        out = subprocess.run(
            ["node", WITNESS, "1"],
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        parsed = json.loads(out.stdout)
    except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
        witness_errors.append({"at": when, "error": repr(exc)[:400]})
        return None
    reading = parsed.get("ms")
    if not isinstance(reading, (int, float)) or reading <= 0:
        witness_errors.append({"at": when, "error": "witness ms was %r" % (reading,)})
        return None
    witness_readings.append(
        {
            "at": when,
            # WHEN, AS A CLOCK AND NOT ONLY AS A LABEL. "before-pass-1" says where
            # in the sweep a reading was taken and nothing at all about how long
            # the sweep ran, so the file could not answer the one question that
            # decides whether a chunk fits inside their store window.
            "atEpoch": time.time(),
            "ms": reading,
            "checksum": parsed.get("checksum"),
        }
    )
    return reading


def run(name, native, text):
    """Every arm, best (smallest) output wins. Failures are reported, not hidden."""
    attempts = []
    notes = {}
    # WALL TIME PER ARM, so the scorer can compare speed instead of assuming it.
    # `perf_counter` and not `time.time`: several of these arms finish in well
    # under a millisecond, and a coarse clock reports those as zero, which reads
    # as an arm that never ran. This first reading picks the winner; every arm is
    # then re-timed properly below, because the scorer scores two of them.
    timings = {}
    question = question_of(native)

    # KEPT AS CALLABLES, because the winning arm is re-timed below and a
    # median needs the function, not just its first reading.
    callables = {}
    for label, fn in TEXT_ARMS(question):
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
            "msPasses": [],
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
    # REPEATED READINGS OF EVERY ARM, NOT ONLY THE WINNER.
    #
    # It was the winner alone, on the reasoning that the winner is the arm the
    # comparison uses. That reasoning held while the comparison had one column.
    # It now has two -- their best-ratio arm, and their best arm that retains at
    # least what ours retains -- and the second is chosen by the scorer, from
    # `armTexts`, on the node side. An arm the scorer may select but this file
    # never timed would arrive with no speed reading at all, and a criterion
    # with a reading on one side only cannot be decided; it would have to be
    # refused, which is the same as not measuring it.
    #
    # WHAT THIS COSTS. Every arm was already run once each, above, to pick the
    # winner; this adds 30 more readings per arm per pass. The expensive part of
    # the harness is their model load, which happens once, before any of this.
    arm_samples = {}
    for label, _out in attempts:
        fn_args = callables.get(label)
        if fn_args is None:
            continue
        fn, args = fn_args
        # THIRTY MORE, FOR THIRTY-ONE IN ALL. The node side takes the same
        # number for the same reason: the scorer compares tails, not just
        # medians, and eleven readings put a lone spike on the tail it reads.
        readings = [timings.get(label, 0.0)]
        for _ in range(30):
            try:
                started = time.perf_counter()
                fn(*args)
                readings.append((time.perf_counter() - started) * 1000.0)
            except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
                notes["retime:" + label] = "%s: %s" % (type(exc).__name__, exc)
                break
        # RUN ORDER PRESERVED for the same reason the node side preserves it:
        # the first reading carries the import and the first-call cost, and a
        # consumer that cannot see which one was first cannot tell warm-up from
        # variance.
        arm_samples[label] = [round(v, 3) for v in readings]
        # AND TWO MORE PASSES, TAKEN LATER, INTERLEAVED WITH EVERY OTHER
        # WORKLOAD AND EVERY OTHER ARM. This is a pass, not the whole reading:
        # the driver at the bottom of this file sweeps them all again, twice, so
        # the passes are separated in time by seconds of other work.
        #
        # WHY IT IS NOT ENOUGH TO TAKE 93 READINGS HERE. The spread that decides
        # the speed criterion is BETWEEN runs, not inside one -- the node side
        # measured its own p90 moving 34ms between runs against 7ms within one,
        # and interference is common-mode, hitting every workload at once.
        # Ninety-three back-to-back readings inside one interference event are
        # ninety-three contaminated readings that look perfectly consistent.
        # Three separated passes show it as one pass that disagrees with its
        # neighbours.
        #
        # WHY THEIR SIDE NEEDS IT AT ALL. The node side has taken three passes
        # since #435 and this side took one, so the between-run spread was
        # measured for ours and assumed away for theirs -- and the direction of
        # that error flatters us. Their statistic is a FAST percentile;
        # interference only adds time; an inflated p10 widens the gap; and the
        # gate reads a wider gap as our win. A criterion that can be won by the
        # opponent's run being noisy is not a speed criterion.
        RETIME.setdefault(name, {})[label] = (fn, args)
    # RUN ORDER PRESERVED for the same reason the node side preserves it: the
    # first reading carries the import and the first-call cost, and a consumer
    # that cannot see which one was first cannot tell warm-up from variance.
    ordered = arm_samples.get(arm) or [round(timings.get(arm, 0.0), 3)]
    samples = sorted(ordered)
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
        # PASS 0. The sweep below appends the rest and rewrites ms/msMin/msMax
        # from the pool, so `msSamples` stays what every existing consumer
        # reads and `msPasses` is what the gate needs.
        "msPasses": [ordered],
        # EVERY ARM'S READINGS, KEYED BY ARM. `ms`/`msSamples`/`msPasses` stay
        # the winner's, so every existing consumer reads what it always read.
        "armMsPasses": {label: [readings] for label, readings in arm_samples.items()},
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


# THE FIRST READING, BEFORE ANY ARM HAS RUN. Taken here rather than beside the
# later passes so the pool spans the whole sweep: a machine that was quiet at the
# start and loaded by the end is the case a single reading cannot describe.
take_witness("before-pass-0")

# WHEN EACH WORKLOAD WROTE TO THEIR STORE, NOT ONLY WHEN THE SWEEP ENDED.
# `sweptAt` below is stamped after the last pass, so the gap the resolver
# computes from it is the age of the NEWEST store entry. The entries that
# expire first are the oldest ones, written by the first workload of pass 0, and
# their age is the sweep duration LONGER. On a sweep that outlasts their window
# that difference is the whole answer: `pastTheirTtl` reads false while the early
# workloads are already unredeemable.
# WHAT STATE THEIR STORE WAS IN WHEN THIS SWEEP STARTED, not only where it ended.
#
# `ccrStoreAfterRun` below has recorded the end state since the pipeline-arm
# variance was found, and an end state alone cannot say which experiment was run:
# every sweep ends with its own entries in the store, so two captures that began
# from completely different states still end up looking like two ordinary runs.
# The digest that makes them VISIBLY incomparable has to be the one taken BEFORE
# the first block goes in.
#
# It matters more now that the roster is swept in chunks. Each chunk starts from
# a store the earlier chunks already grew, so `chunk-merge.mjs` can only say what
# that growth was -- and that a later chunk was not handed a fresh store -- if
# every chunk stamps both ends.
STORE_PATH = os.path.join(os.path.expanduser("~"), ".headroom", "ccr_store.db")


def _store_rows():
    """How many entries their store holds, and how many are still redeemable.

    THE BYTE COUNT DOES NOT SAY WHAT IS REDEEMABLE, and this is not a hypothetical:
    the 3.87 MB store on this machine held six rows and every one was expired, ages
    4223-4662s against their own ttl of 1800, with 53% of the file free pages. Their
    `headroom/cache/backends/sqlite.py` runs

        DELETE FROM ccr_entries WHERE created_at + ttl < ?

    on every open as startup hygiene, so their engine empties exactly those rows
    before the first workload of a sweep. A sweep started there has nothing to
    redeem, however large the file is.

    So the live count uses their own predicate, and it is also the one quantity in
    this stamp that survives a checkpoint: `ccr_store.db` is a WAL database, so
    committed rows sit in `ccr_store.db-wal` until SQLite moves them and the file's
    size and digest both change with the store unchanged.

    READ-ONLY, BY URI. The instrument must not write to the thing it measures: a
    read-write open would let SQLite recover the WAL, run their hygiene, or create
    the file, and the stamp would then describe a store this function had altered.
    `mode=ro` fails rather than creating, and `immutable` is deliberately NOT used --
    it would let us read a stale snapshot past a concurrent write.
    """
    rows = {"entries": None, "liveEntries": None, "readError": None}
    try:
        conn = sqlite3.connect(
            "file:%s?mode=ro" % pathlib.Path(STORE_PATH).as_posix(),
            uri=True,
            timeout=5.0,
        )
    except Exception as exc:  # pragma: no cover - a locked or absent store
        rows["readError"] = "%s: %s" % (type(exc).__name__, exc)
        return rows
    try:
        cur = conn.execute("SELECT count(*) FROM ccr_entries")
        rows["entries"] = int(cur.fetchone()[0])
        cur = conn.execute(
            "SELECT count(*) FROM ccr_entries WHERE created_at + ttl >= ?", (time.time(),)
        )
        rows["liveEntries"] = int(cur.fetchone()[0])
    except Exception as exc:
        # A SHAPE WE DO NOT RECOGNISE IS NOT AN EMPTY STORE. Leaving the counts None
        # makes the fingerprint read `store=unrecorded`, which is the direction that
        # refuses to claim anything rather than the one that flatters a capture.
        rows["readError"] = "%s: %s" % (type(exc).__name__, exc)
    finally:
        conn.close()
    return rows


def _store_state():
    state = {"path": STORE_PATH, "present": os.path.exists(STORE_PATH)}
    if state["present"]:
        with open(STORE_PATH, "rb") as handle:
            state["bytes"] = os.path.getsize(STORE_PATH)
            state["sha256"] = hashlib.sha256(handle.read()).hexdigest()[:16]
        # The sidecars are kept because they explain a digest that moved on its own,
        # and because a stale `-wal` left by an aborted run overlays a restored store.
        for suffix, key in (("-wal", "walBytes"), ("-shm", "shmBytes")):
            side = STORE_PATH + suffix
            state[key] = os.path.getsize(side) if os.path.exists(side) else 0
        state.update(_store_rows())
    else:
        state["bytes"] = 0
        state["sha256"] = None
        state["walBytes"] = 0
        state["shmBytes"] = 0
        # NO FILE IS NO ROWS, and that needs no query to establish.
        state["entries"] = 0
        state["liveEntries"] = 0
        state["readError"] = None
    return state


store_before = _store_state()
print(
    "ccr store before run: %d bytes, %s of %s entries still live, sha %s%s"
    % (
        store_before["bytes"],
        store_before["liveEntries"],
        store_before["entries"],
        store_before["sha256"],
        "" if store_before["readError"] is None else " (%s)" % store_before["readError"],
    )
)

sweep_started_at = time.time()
swept_per_workload = {}

results = {}
for name, native in WORKLOADS.items():
    results[name] = run(name, native, PAYLOADS[name])
    swept_per_workload[name] = time.time()
    row = results[name]
    pct = (1 - row["after"] / row["before"]) * 100
    print("%-24s %8d -> %8d  %5.1f%%  via %s" % (name, row["before"], row["after"], pct, row["arm"]))
    for label, note in row.get("notes", {}).items():
        print("    %s failed: %s" % (label, note))

# THE REMAINING PASSES, SWEPT ACROSS EVERY WORKLOAD RATHER THAN WORKLOAD BY
# WORKLOAD.
#
# Each pass re-times every winner once before any winner is timed a second
# time, so two passes of the same workload are separated by a full sweep --
# seconds of other work. That is the whole point: an interference event that
# outlasts one reading but not one sweep shows up as a pass that disagrees with
# its neighbours, instead of as a quietly inflated set of consecutive readings
# that look entirely consistent with each other.
#
# `ms`, `msMin` and `msMax` are then recomputed over every pass pooled, so the
# published median is a median of 93 readings taken at three different moments
# rather than 31 taken at one.
for extra_pass in range(1, SPEED_PASSES):
    take_witness("before-pass-%d" % extra_pass)
    for name in WORKLOADS:
        entry = RETIME.get(name)
        if entry is None:
            continue
        for arm, (fn, args) in entry.items():
            readings = []
            for _ in range(31):
                try:
                    started = time.perf_counter()
                    fn(*args)
                    readings.append(round((time.perf_counter() - started) * 1000.0, 3))
                except Exception as exc:  # noqa: BLE001 - recorded, never swallowed
                    results[name].setdefault("notes", {})["retime:" + arm] = "%s: %s" % (
                        type(exc).__name__,
                        exc,
                    )
                    break
            # A PASS THAT DIED PART WAY IS NOT A PASS. Appending a short one
            # would let a 3-reading pass carry the same weight in the
            # across-pass median as a 31-reading one, and the scorer has no way
            # to see the difference.
            if len(readings) != 31:
                continue
            results[name].setdefault("armMsPasses", {}).setdefault(arm, []).append(readings)
            if arm == results[name].get("arm"):
                results[name]["msPasses"].append(readings)

for name, row in results.items():
    passes = row.get("msPasses") or []
    pooled = [v for p in passes for v in p]
    if not pooled:
        continue
    row["msSamples"] = pooled
    ordered_pool = sorted(pooled)
    row["ms"] = round(ordered_pool[(len(ordered_pool) - 1) // 2], 3)
    row["msMin"] = round(ordered_pool[0], 3)
    row["msMax"] = round(ordered_pool[-1], 3)
    if len(passes) < SPEED_PASSES:
        # SAID OUT LOUD, because a row with fewer passes than asked for cannot
        # be compared pass-for-pass and the scorer refuses it rather than
        # quietly falling back to the pooled reading.
        print("    %s: %d speed pass(es) of %d" % (name, len(passes), SPEED_PASSES))

# AND THE SAME POOLING, PER ARM. `armMs` is the median of that arm's pooled
# readings and `armMsPasses` keeps the passes separate, exactly as `ms` and
# `msPasses` do for the winner -- so a scorer that selects a non-winning arm
# reads the same statistic, computed the same way, and not a different estimator
# that happens to be available for the arm it picked.
for name, row in results.items():
    arm_passes = row.get("armMsPasses") or {}
    for label, passes in arm_passes.items():
        pooled = [v for p in passes for v in p]
        if not pooled:
            continue
        ordered_pool = sorted(pooled)
        row.setdefault("armMs", {})[label] = round(ordered_pool[(len(ordered_pool) - 1) // 2], 3)
        if len(passes) < SPEED_PASSES:
            # SAID OUT LOUD for the same reason the winner's shortfall is: an
            # arm with fewer passes than asked for cannot be compared
            # pass-for-pass, and a silently short arm is the one way this file
            # could hand the scorer a reading it will treat as equivalent.
            print("    %s/%s: %d speed pass(es) of %d" % (name, label, len(passes), SPEED_PASSES))

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


store = _store_state()

# AN ARM THAT RETURNS ITS INPUT IS NOT THE SAME AS AN ARM THAT DECLINES, AND
# THE DIFFERENCE IS INVISIBLE IN THE SCORE. Both land at ratio 1.0, so both are
# published as "their engine achieved nothing on this workload" -- which is a
# claim about THEM, made out of a silence that is just as likely to be ours.
#
# It happened, and reading the silence cost a day. Three captures scored every
# `pipeline@*` arm as a no-op on 10 of 12 workloads -- exactly the 10 that are
# tool output rather than conversation -- while later captures offloaded on all
# 12. That was first written up as "the record understated their engine by 200x
# per workload". It is the other way round: handed the NATIVE message list their
# pipeline genuinely declines on those 10, and it was the later captures, fed a
# conversation flattened to a string, that inflated it. The carrier refusal
# above now makes the inflating regime unreachable.
#
# The lesson the count below encodes is the one that survived the reversal: a
# ratio of 1.0 is ambiguous, and which of the two it was cannot be recovered
# from the number afterwards.
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

warnings_seen = sorted(COMPETITOR_WARNINGS.values(), key=lambda w: w["message"])
competitor_warnings = {
    "degraded": [w for w in warnings_seen if not is_advisory(w["message"])],
    "advisory": [w for w in warnings_seen if is_advisory(w["message"])],
}
for entry in competitor_warnings["degraded"]:
    print(
        "WARNING: their engine ran with a capability missing (%dx from %s): %s"
        % (entry["count"], entry["logger"], entry["message"])
    )

take_witness("after-sweep")

provenance = {
    "headroomVersion": _headroom_version(),
    # WHEN THE CAPTURE HAPPENED, BECAUSE THEIR STORE FORGETS. Their CCR
    # markers are redeemable from their store for a bounded time only (their
    # own resolver reports the bound: "CCR TTL: 1800 seconds"). A resolution
    # run after that window reports every marker unresolved -- which is
    # indistinguishable, in the output alone, from a store that genuinely
    # lost the content, and would score their retention at zero for what is
    # really our own sequencing mistake. Stamping the sweep lets
    # resolve-theirs.py compute the gap and lets the scorer refuse a
    # resolution that was taken too late instead of banking the win.
    "sweepStartedAt": sweep_started_at,
    # Per workload, so the resolver can age the OLDEST entry rather than the
    # newest one. A later pass re-runs their compressor and may refresh a store
    # entry it re-writes; recording both stamps is what makes that answerable from
    # the file instead of assumed in either direction.
    "sweptPerWorkload": swept_per_workload,
    "sweptAt": time.time(),
    "sweptAtIso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
    # THE LOAD CONTROL, WITHOUT WHICH NO SPEED ROW IS DECIDABLE. See the
    # take_witness block above and bench/compression/load-witness.mjs. `ms` is
    # the median over every reading of this session; `readings` keeps them
    # individually so a sweep whose load changed part way through can be seen to
    # have done so rather than averaged into one number. `errors` non-empty with
    # `ms` null means the witness could not be taken, which the scorer treats as
    # an uncontrolled machine -- never as a quiet one.
    "loadWitness": {
        "ms": (
            sorted(r["ms"] for r in witness_readings)[len(witness_readings) // 2]
            if witness_readings
            else None
        ),
        "readings": witness_readings,
        "errors": witness_errors,
        "script": os.path.relpath(WITNESS, os.path.dirname(os.path.dirname(WITNESS))),
    },
    "python": sys.version.split()[0],
    # AFTER the run, deliberately: the arms write to it, so the state that
    # matters for reproducing this capture is the one the next run inherits.
    "ccrStoreBeforeRun": store_before,
    "ccrStoreAfterRun": store,
    "theirFixtures": HAVE_THEIR_FIXTURES,
    "carriedPayloads": sorted(set(WORKLOADS) - set(THEIR_FIXTURE_NAMES)),
    # THE WHOLE ROSTER AND THE SLICE OF IT THIS FILE HOLDS. `chunk` null means
    # one process measured everything; anything else means the numbers here are
    # part of a capture and `merge-chunks.mjs` has to put the rest beside them.
    "roster": ROSTER,
    "chunk": CHUNK_PROV,
    "inertArms": inert,
    # WHAT RAN DEGRADED, SPLIT BY WHOSE FAULT IT IS. `degraded` means a
    # capability of theirs was missing while they were being measured, so
    # every number in this file understates them by an unknown amount and the
    # downstream gate refuses to publish a win from it. `advisory` is the
    # allow-listed remainder, recorded because it is still an asymmetry.
    "competitorWarnings": competitor_warnings,
    "detectBackend": os.environ.get("HEADROOM_DETECT_BACKEND"),
    # True means this harness chose their backend; a string means the operator
    # had already pinned one and we left it alone.
    "detectBackendSetByHarness": _DETECT_BACKEND_PRESET is None,
    "detectBackendPreset": _DETECT_BACKEND_PRESET,
    "kompressWarmup": KOMPRESS_WARMUP,
    # NOT NULL MEANS NOT A MEASUREMENT. A known-answer capture drives this same
    # path with arms whose output is arithmetic, so its numbers are correct and
    # meaningless at once -- exactly the kind of file that must never reach a
    # published table. The scorer refuses a capture that carries this.
    "stubArms": KNOWN_ANSWER_ARMS,
}
print(
    "ccr store after run: %d bytes, %s of %s entries still live, sha %s%s"
    % (
        store["bytes"],
        store["liveEntries"],
        store["entries"],
        store["sha256"],
        "" if store["readError"] is None else " (%s)" % store["readError"],
    )
)

with open(os.path.join(OUT, "theirs.json"), "w", encoding="utf-8") as handle:
    json.dump({"__provenance__": provenance, **results}, handle, indent=2)

total_before = sum(r["before"] for r in results.values())
total_after = sum(r["after"] for r in results.values())
print(
    "TOTAL %d -> %d  %.1f%% chars" % (total_before, total_after, (1 - total_after / total_before) * 100)
)
print("wrote", OUT)
