#!/usr/bin/env python3
"""Apply competitor-pins.json over a THOL checkout.

Usage: apply-competitor-pins.py <thol-dir> [--dry-run]

Upstream THOL pins each competitor at the version it last ran. This rewrites
those pins to the versions in competitor-pins.json, so a campaign measures what
a user installing today would get.

It fails loudly rather than half-applying. Each [old, new, count] pair must
replace exactly `count` occurrences. So an upstream THOL change that moves or
duplicates a pin stops the build instead of leaving a stale version in
place. A fetched file must match its recorded sha256.
"""

import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

PINS = Path(__file__).with_name("competitor-pins.json")


def pattern(old):
    # Bounded so "1.22.1" cannot match inside "11.22.1" or "1.22.10", while a
    # version that ends a sentence ("pinned to v1.9.0.") still matches.
    return re.compile(r"(?<!\w)(?<!\d\.)" + re.escape(old) + r"(?!\w)(?!\.\d)")


def rewrite(path, pairs, checked, problems, dry):
    text = path.read_text(encoding="utf-8")
    for old, new, want in pairs:
        text, got = pattern(old).subn(lambda _m, new=new: new, text)
        status = "ok" if got == want else "MISMATCH"
        print(f"  {path.name if path.name != 'manifest.json' else path.parent.name}: "
              f"{old[:48]} -> {new[:48]}: {got}/{want} {status}")
        if got != want:
            problems.append(f"{path}: {old!r} replaced {got} times, expected {want}")
    if checked and path.name == "manifest.json":
        text, got = re.subn(r'("version_checked":\s*")[^"]*(")',
                            lambda m: m.group(1) + checked + m.group(2), text)
        if got != 1:
            problems.append(f"{path}: version_checked found {got} times, expected 1")
    if not dry:
        path.write_text(text, encoding="utf-8")


def fetch(spec, comp_dir, problems, dry):
    with urllib.request.urlopen(spec["url"], timeout=60) as response:
        body = response.read()
    digest = hashlib.sha256(body).hexdigest()
    if digest != spec["sha256"]:
        problems.append(f"{spec['url']}: sha256 {digest}, expected {spec['sha256']}")
        return
    print(f"  {comp_dir.name}: fetched {spec['to']} ({len(body)} bytes, sha256 ok)")
    if not dry:
        target = comp_dir / spec["to"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    thol = Path(argv[1])
    dry = "--dry-run" in argv[2:]
    pins = json.loads(PINS.read_text(encoding="utf-8"))
    problems = []

    print(f"apply-competitor-pins: {'dry run' if dry else 'applying'} pins checked {pins['checked']}")
    rewrite(thol / pins["script"]["path"], pins["script"]["replace"], None, problems, dry)
    for name, spec in pins["competitors"].items():
        comp_dir = thol / "competitors" / name
        manifest = comp_dir / "manifest.json"
        if not manifest.is_file():
            problems.append(f"{manifest}: missing")
            continue
        rewrite(manifest, spec.get("replace", []), pins["checked"], problems, dry)
        if "fetch" in spec:
            fetch(spec["fetch"], comp_dir, problems, dry)
        if not dry:
            json.loads(manifest.read_text(encoding="utf-8"))  # still valid JSON

    if problems:
        print("\napply-competitor-pins FAILED:")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("apply-competitor-pins: every pin applied")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
