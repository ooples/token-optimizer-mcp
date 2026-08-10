#!/usr/bin/env python3
"""Independent Python verifier for the language-neutral UCR event fixture."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


HLC = re.compile(r"^(\d{13}):(\d{8}):(.+)$")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: object) -> str:
    text = value if isinstance(value, str) else canonical(value)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_input() -> list[dict]:
    if len(sys.argv) > 1:
        return json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    return json.load(sys.stdin)


def validate(event: object) -> list[str]:
    if not isinstance(event, dict):
        return ["event must be an object"]
    errors: list[str] = []
    required = [
        "schemaVersion",
        "eventId",
        "type",
        "traceId",
        "idempotencyKey",
        "payloadHash",
    ]
    for field in required:
        if not isinstance(event.get(field), str) or not event[field]:
            errors.append(f"{field} must be a non-empty string")
    if event.get("schemaVersion") != "ucr.event/1":
        errors.append("unsupported schemaVersion")
    hlc = event.get("time", {}).get("hlc")
    if not isinstance(hlc, str) or not HLC.fullmatch(hlc):
        errors.append("invalid time.hlc")
    writer = event.get("writer", {})
    if not isinstance(writer.get("id"), str) or not writer["id"]:
        errors.append("writer.id must be a non-empty string")
    sequence = writer.get("sequence")
    if not isinstance(sequence, int) or sequence < 0:
        errors.append("writer.sequence must be a non-negative integer")
    if "payload" in event and digest(event["payload"]) != event.get("payloadHash"):
        errors.append("payloadHash does not match inline payload")
    return errors


def replay(events: list[dict]) -> tuple[list[dict], list[dict]]:
    by_event: dict[str, dict] = {}
    by_idempotency: dict[str, dict] = {}
    diagnostics: list[dict] = []
    for event in events:
        errors = validate(event)
        if errors:
            diagnostics.append({"eventId": event.get("eventId"), "errors": errors})
            continue
        if event["eventId"] in by_event:
            continue
        prior = by_idempotency.get(event["idempotencyKey"])
        if prior:
            if prior["type"] != event["type"] or prior["payloadHash"] != event["payloadHash"]:
                diagnostics.append(
                    {
                        "eventId": event["eventId"],
                        "errors": ["idempotency key reused for a different event"],
                    }
                )
            continue
        by_event[event["eventId"]] = event
        by_idempotency[event["idempotencyKey"]] = event
    ordered = sorted(
        by_event.values(),
        key=lambda event: (
            event["time"]["hlc"],
            event["writer"]["id"],
            event["writer"]["sequence"],
            event["eventId"],
        ),
    )
    return ordered, diagnostics


def main() -> int:
    ordered, diagnostics = replay(read_input())
    semantics = [
        {
            "type": event["type"],
            "payloadHash": event["payloadHash"],
            "causalParents": event["causalParents"],
            "sensitivity": event["sensitivity"],
            "scope": event["scope"],
        }
        for event in ordered
    ]
    print(
        canonical(
            {
                "implementation": "python-stdlib",
                "events": len(ordered),
                "diagnostics": diagnostics,
                "semanticDigest": digest(semantics),
            }
        )
    )
    return 0 if not diagnostics else 1


if __name__ == "__main__":
    raise SystemExit(main())
