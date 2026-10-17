"""Write each recall pair's fixture hashes into its truth file.

    python3 bench/recall/hash_fixtures.py          # rewrite them
    python3 bench/recall/hash_fixtures.py --check  # fail if any is stale

A verifier gives a session no credit if it changed a fixture file, and it
knows what "unchanged" means only from these hashes. test_recall.py runs the
--check, so a fixture edited without re-hashing fails there rather than
turning every real session into a silent zero.
"""

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
TRUTH = FIXTURES / "truth"


def hashes(fixture: str) -> dict:
    root = FIXTURES / fixture
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts
    }


def main(check: bool) -> int:
    stale = []
    for file in sorted(TRUTH.glob("*.json")):
        record = json.loads(file.read_text())
        want = hashes(record["fixture"])
        if record.get("fixture_hashes") != want:
            stale.append(file.name)
            if not check:
                record["fixture_hashes"] = want
                file.write_text(json.dumps(record, indent=2) + "\n", newline="\n")
    if check and stale:
        print("stale fixture hashes: " + ", ".join(stale))
        return 1
    print(("checked " if check else "wrote ") + f"{len(list(TRUTH.glob('*.json')))} truth file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv[1:]))