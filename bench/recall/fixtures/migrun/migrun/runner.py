"""Apply every migration in a directory to a database, in order."""

import os
import sqlite3


def pending(directory):
    """The migration files to apply, in the order they are applied."""
    return sorted(name for name in os.listdir(directory) if name.endswith(".sql"))


def migrate(database, directory):
    """Apply each pending migration; return the names applied."""
    applied = []
    with sqlite3.connect(database) as connection:
        for name in pending(directory):
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                connection.executescript(handle.read())
            applied.append(name)
    return applied