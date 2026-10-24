"""The compared package, imported under a neutral name.

The comparison scripts import the package they compare against as
`alternative_a` (`from alternative_a.config import ...`). This module maps that
name, and every submodule under it, onto the package's real top-level module,
which the operator names:

    ALT_A_MODULE  the package's importable top-level module
    ALT_A_DIST    its distribution name, for its installed version

Nothing here imports the package until a script does, so a script that only
reads recorded results needs neither variable.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.abc
import importlib.metadata
import importlib.util
import os
import sys

NEUTRAL = "alternative_a"


def real_module() -> str:
    name = os.environ.get("ALT_A_MODULE", "").strip()
    if not name:
        raise ModuleNotFoundError(
            f"{NEUTRAL}: set ALT_A_MODULE to the compared package's top-level module"
        )
    return name


def version() -> str:
    """The installed version, as records carry it: `sha256:` + 16 hex of the
    digest of the version string (bench/compression/reproducibility.mjs,
    versionDigest). Equal versions give equal digests; the text is not kept."""
    dist = os.environ.get("ALT_A_DIST", "").strip()
    if not dist:
        raise importlib.metadata.PackageNotFoundError(
            "set ALT_A_DIST to the compared package's distribution name"
        )
    raw = importlib.metadata.version(dist)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


class _Alias(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != NEUTRAL and not fullname.startswith(NEUTRAL + "."):
            return None
        return importlib.util.spec_from_loader(fullname, self, is_package=True)

    def create_module(self, spec):
        return importlib.import_module(real_module() + spec.name[len(NEUTRAL):])

    def exec_module(self, module):
        # Already executed under its real name; this only re-exports it.
        pass


def install() -> None:
    if not any(isinstance(f, _Alias) for f in sys.meta_path):
        sys.meta_path.insert(0, _Alias())
