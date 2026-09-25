"""Arms with no engine behind them, so the harness has a right answer.

WHY A FAKE ENGINE IS THE POINT. `run-theirs.py` measures a compressor nobody
here wrote. When one of its numbers looks wrong there is no way to tell, from
inside, whether the harness mis-measured or the engine really did that -- and a
week of this project's findings were retracted for exactly that reason. Every
one of them was a harness defect read as a fact about the engine.

These arms remove the unknown. Each one's output is a closed-form function of
its input, so the ratio the harness *should* publish can be worked out with
arithmetic and compared to the ratio it *does* publish. A disagreement is a
harness bug with no second explanation available.

  ka-identity   returns its input, byte for byte. Ratio is exactly 1.0, and the
                inert trip-wire must fire on every workload. This is the
                positive control for a detector that otherwise only ever proves
                itself by staying quiet.
  ka-half       returns the first floor(n/2) bytes. Ratio is exactly
                floor(n/2)/n -- a real reduction, lossy, with no marker. The
                trip-wire must NOT fire on it, which is the negative control.
  ka-offload    returns a single CCR retrieval marker and nothing else. Smallest
                output, so the ratio-winner selection must pick it, and the
                offload classifier must refuse to call it compression.

`apply` is the message-list path and is deliberately an identity: it returns
whatever `as_messages` handed it. That is not laziness -- it means the bytes
recorded in `armTexts["pipeline@*"]` ARE the shape the harness fed the engine,
so a check can read the carrier decision directly out of the capture instead of
inferring it from a ratio. The carrier bug that cost this project a week is
visible in that field and nowhere else.

Driven by: BENCH_KNOWN_ANSWER_ARMS=<this file> python .../run-theirs.py ...
Asserted by: bench/compression/known-answer/capture.check.mjs
"""

import hashlib


def text_arms(question):
    """The stub arm table. `question` is unused: no arm here reads content."""
    return (
        ("ka-identity", lambda t: t),
        ("ka-half", lambda t: t[: len(t) // 2]),
        ("ka-offload", _offload),
    )


def _offload(text):
    """One marker in the shape their CCR emits, matching offload.mjs's regex."""
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    return "<<ccr:%s,text,%.1fKB>>" % (digest, len(text) / 1024.0)


def apply(messages, limit):
    """Identity on the message list, so the capture records the shape verbatim."""
    return messages
