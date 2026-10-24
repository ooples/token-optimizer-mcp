"""Record the retrieval tool Alternative A's proxy adds to a request that carries a
CCR marker, from their own package, so the comparator can charge for it.

WHY IT IS CHARGED. A `<<ccr:hash,type,size>>` marker is only redeemable
because their proxy also sends `alternative_a_retrieve` in the request's `tools`
array: `ccr_inject_tool: bool = True` is the default in
alternative_a/proxy/models.py, and once a session has done CCR the tool stays on
every later request. The comparator priced the marker and never the tool, so
every row where their best arm offloads was cheaper on paper than on the
invoice. Our marker needs no tool: it names a path the agent opens with the
`Read` it already has.

WHAT IS NOT CHARGED. Tools head Anthropic's cache key, so the turn that adds
the tool rewrites the whole cached prefix behind it (their own comment says
so, in alternative_a/proxy/handlers/anthropic.py). That one-off rewrite is not
priced here, which errs in their favour.

Usage:
    python bench/compression/alt-a/ccr-tool.py

Writes bench/compression/alt-a/ccr-tool.json. Run with the same
alternative-a version the capture was swept with; the comparator refuses a
capture from a different one.
"""

import json
import sys
# The compared package, under a neutral name (bench/alt_a_alias.py).
import os as _os  # noqa: E402
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))))
import alt_a_alias  # noqa: E402

alt_a_alias.install()
from importlib.metadata import version
from pathlib import Path

from alternative_a.ccr.tool_injection import create_ccr_tool_definition

OUT = Path(__file__).with_name("ccr-tool.json")


def main() -> int:
    record = {
        "altAVersion": alt_a_alias.version(),
        "source": "alternative_a.ccr.tool_injection.create_ccr_tool_definition(provider='anthropic')",
        "injectedBy": "alternative_a/proxy/models.py: ccr_inject_tool: bool = True",
        "definition": create_ccr_tool_definition(provider="anthropic"),
    }
    OUT.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} for Alternative A {record['altAVersion']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())