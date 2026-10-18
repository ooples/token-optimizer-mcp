import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _recall import verify  # noqa: E402

verify("recall-migrate", "derive")