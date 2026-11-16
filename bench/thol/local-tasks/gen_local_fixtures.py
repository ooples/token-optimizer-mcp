"""Fixtures for the rig's LOCAL tasks (tasks/ beside this file).

Not part of THOL: upstream's task set is frozen per campaign and changes only
by PR there. These tasks exist because the upstream board has no task in some
category this product treats differently -- today, REWRITE (a whole file is
restated, behaviour unchanged), whose setting turns outline substitution off.

Deterministic: no randomness, no hashing of dicts or sets, so the bytes are
identical on every run. Writes only what is absent, so a persisted fixture set
(entrypoint.sh) gains the local fixtures without the upstream ones being
regenerated.

Usage: python3 gen_local_fixtures.py <THOL fixtures dir>
"""
import hashlib
import json
import sys
from pathlib import Path

FIXTURES = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("fixtures")
OUT = FIXTURES / "out"
TRUTH = FIXTURES / "truth"

# Twenty-four record kinds x five operations = 120 legacy functions, ~22 KB:
# past the size at which a Read of a .py file is answered with an outline even
# halfway through a session (substitute.mjs floorBytes).
KINDS = [
    ("widget", "sku", 3), ("gadget", "code", 5), ("bolt", "size", 7), ("panel", "area", 2),
    ("cable", "length", 11), ("valve", "pressure", 13), ("gear", "teeth", 4), ("lamp", "watts", 6),
    ("pump", "flow", 9), ("fan", "rpm", 8), ("hinge", "angle", 12), ("spring", "tension", 10),
    ("filter", "mesh", 3), ("motor", "torque", 5), ("relay", "current", 7), ("sensor", "span", 2),
    ("nozzle", "bore", 11), ("tank", "volume", 13), ("clamp", "grip", 4), ("drill", "depth", 6),
    ("bearing", "load", 9), ("pulley", "radius", 8), ("switch", "poles", 12), ("gasket", "seal", 10),
]


def legacy_module():
    parts = ['''\
# -*- coding: utf-8 -*-
"""Inventory helpers, written for Python 2 and never modernised.

Every function here is exercised by tests/test_inventory.py; the exact strings
they return are part of the contract.
"""
import math


class Record(object):
    """One stocked item."""

    def __init__(self, kind, key, quantity, unit_price):
        self.kind = kind
        self.key = key
        self.quantity = quantity
        self.unit_price = unit_price

    def total(self):
        return self.quantity * self.unit_price

    def label(self):
        return "%s-%s" % (self.kind, self.key)


class Ledger(object):
    """A list of records with a running audit trail."""

    def __init__(self):
        self.records = []
        self.trail = []

    def add(self, record):
        if record == None:
            raise ValueError("record is required")
        self.records.append(record)
        self.trail.append("added %s x%d" % (record.label(), record.quantity))
        return len(self.records)

    def value(self):
        if len(self.records) == 0:
            return 0
        return sum([r.total() for r in self.records])

    def summary(self):
        return "{0} records worth {1:.2f}".format(len(self.records), self.value())

''']
    for kind, attr, factor in KINDS:
        k = kind
        parts.append(f'''\

def describe_{k}(key, {attr}):
    if key == None:
        return "unknown {k}"
    return "{k} %s ({attr}=%s)" % (key, {attr})


def price_{k}(quantity, unit_price, discount=None):
    if discount == None:
        discount = 0
    gross = quantity * unit_price
    return round(gross - gross * discount / 100.0, 2)


def reorder_{k}(stock, minimum):
    if len(stock) == 0:
        return "reorder all {k}s"
    short = [s for s in stock if s < minimum]
    return "{{0}} of {{1}} {k}s below {{2}}".format(len(short), len(stock), minimum)


def scale_{k}({attr}, steps):
    out = []
    for i in range(steps):
        out.append("%d:%.1f" % (i, {attr} * {factor} * (i + 1) / 10.0))
    return ",".join(out)


def check_{k}({attr}, limit):
    if {attr} == None or limit == None:
        return False
    return math.fabs({attr}) <= limit
''')
    return "".join(parts)


def tests_module():
    lines = ['''\
import unittest

import inventory_legacy as inv


class TestCore(unittest.TestCase):
    def test_record(self):
        r = inv.Record("bolt", "B7", 3, 2.5)
        self.assertEqual(r.total(), 7.5)
        self.assertEqual(r.label(), "bolt-B7")

    def test_ledger(self):
        led = inv.Ledger()
        self.assertEqual(led.value(), 0)
        self.assertEqual(led.add(inv.Record("fan", "F1", 2, 10.0)), 1)
        self.assertEqual(led.trail, ["added fan-F1 x2"])
        self.assertEqual(led.summary(), "1 records worth 20.00")
        with self.assertRaises(ValueError):
            led.add(None)


class TestKinds(unittest.TestCase):
''']
    for kind, attr, factor in KINDS:
        k = kind
        scaled = ",".join(f"{i}:{2.0 * factor * (i + 1) / 10.0:.1f}" for i in range(3))
        lines.append(f'''\
    def test_{k}(self):
        self.assertEqual(inv.describe_{k}("X1", 4), "{k} X1 ({attr}=4)")
        self.assertEqual(inv.describe_{k}(None, 4), "unknown {k}")
        self.assertEqual(inv.price_{k}(4, 2.5), 10.0)
        self.assertEqual(inv.price_{k}(4, 2.5, 10), 9.0)
        self.assertEqual(inv.reorder_{k}([], 3), "reorder all {k}s")
        self.assertEqual(inv.reorder_{k}([1, 5, 2], 3), "2 of 3 {k}s below 3")
        self.assertEqual(inv.scale_{k}(2.0, 3), "{scaled}")
        self.assertTrue(inv.check_{k}(-2, 2))
        self.assertFalse(inv.check_{k}(None, 2))
        self.assertFalse(inv.check_{k}(3, 2))

''')
    lines.append('''
if __name__ == "__main__":
    unittest.main()
''')
    return "".join(lines)


def public_names():
    names = ["Record", "Ledger"]
    for kind, _, _ in KINDS:
        names += [f"{op}_{kind}" for op in ("describe", "price", "reorder", "scale", "check")]
    return names


def write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def gen_rewrite_modernize():
    root = OUT / "rewrite-modernize-py"
    truth = TRUTH / "code-rewrite-modernize-py.json"
    if root.exists() and truth.exists():
        return False
    write(root / "inventory_legacy.py", legacy_module())
    write(root / "tests" / "__init__.py", "")
    write(root / "tests" / "test_inventory.py", tests_module())
    test_bytes = (root / "tests" / "test_inventory.py").read_bytes()
    write(truth, json.dumps({
        "module": "inventory_legacy.py",
        "public_names": public_names(),
        "frozen_hashes": {"tests/test_inventory.py": hashlib.sha256(test_bytes).hexdigest()},
        # What the verifier counts down from: 2 classes on `object`; per kind
        # 2 `%`, 1 `.format` and 4 `== None`; plus the core module's own.
        "legacy_counts": {"percent": 2 + 2 * len(KINDS), "format": 1 + len(KINDS), "object": 2,
                          "eq_none": 1 + 4 * len(KINDS)},
    }, indent=1))
    return True


if __name__ == "__main__":
    made = gen_rewrite_modernize()
    print(f"local fixture rewrite-modernize-py: {'generated' if made else 'present'}")
