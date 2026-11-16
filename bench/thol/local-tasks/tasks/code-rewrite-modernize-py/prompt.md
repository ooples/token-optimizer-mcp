Rewrite the whole file `inventory_legacy.py` in the current directory in modern
Python 3.11 style, keeping it a single file and keeping every public name:

- f-strings instead of `%` formatting and `.format()`
- `class X:` instead of `class X(object):`
- `is None` / `is not None` instead of `== None` / `!= None`
- type hints on every function and method signature, return type included

Behaviour must not change: every string a function returns must stay exactly
the same, and the test suite must keep passing without edits
(`python3 -m unittest discover -s tests -t .`).

In your final reply, say how many functions you annotated.
