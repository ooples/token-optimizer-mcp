"""Scores the modernising rewrite of inventory_legacy.py.

Gate: the frozen tests are unedited and pass, the module is still one file and
still defines every public name. Past the gate, the score is the mean of five
modernisation fractions measured on the AST, so partial work earns partial
credit and an untouched workspace earns none (all five are 0 on the legacy
file).
"""
import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _vlib import WS, emit, hashes_intact, run, truth  # noqa: E402

t = truth("code-rewrite-modernize-py.json")
if not hashes_intact(WS, t["frozen_hashes"]):
    emit(0.0, "the test file was modified -- not allowed")
module = WS / t["module"]
if not module.is_file():
    emit(0.0, f"{t['module']} is missing; the task keeps it one file")
try:
    tree = ast.parse(module.read_text(encoding="utf-8"))
except (SyntaxError, UnicodeDecodeError) as error:
    emit(0.0, f"{t['module']} does not parse: {error}")

defined = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
missing = [name for name in t["public_names"] if name not in defined]
if missing:
    emit(0.0, f"public names removed: {missing[:8]}")
r = run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."])
if r.returncode != 0:
    emit(0.0, "tests FAIL: " + (r.stderr or r.stdout)[-300:])

functions = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]


def annotated(fn):
    args = [a for a in fn.args.args + fn.args.kwonlyargs if a.arg not in ("self", "cls")]
    return fn.returns is not None and all(a.annotation is not None for a in args)


def is_str(node):
    return isinstance(node, ast.Constant) and isinstance(node.value, str)


percent = [n for n in ast.walk(tree) if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mod) and is_str(n.left)]
dot_format = [
    n for n in ast.walk(tree)
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "format" and is_str(n.func.value)
]
object_bases = [
    n for n in ast.walk(tree)
    if isinstance(n, ast.ClassDef) and any(isinstance(b, ast.Name) and b.id == "object" for b in n.bases)
]
eq_none = [
    n for n in ast.walk(tree)
    if isinstance(n, ast.Compare)
    and any(isinstance(op, (ast.Eq, ast.NotEq)) for op in n.ops)
    and any(isinstance(c, ast.Constant) and c.value is None for c in [n.left, *n.comparators])
]

LEGACY = t["legacy_counts"]


def cleared(remaining, legacy):
    return max(0.0, 1.0 - remaining / legacy)


parts = {
    "annotated": sum(1 for f in functions if annotated(f)) / max(1, len(functions)),
    "no_percent": cleared(len(percent), LEGACY["percent"]),
    "no_format": cleared(len(dot_format), LEGACY["format"]),
    "no_object_base": cleared(len(object_bases), LEGACY["object"]),
    "no_eq_none": cleared(len(eq_none), LEGACY["eq_none"]),
}
emit(sum(parts.values()) / len(parts), "; ".join(f"{k}={v:.2f}" for k, v in parts.items()))
