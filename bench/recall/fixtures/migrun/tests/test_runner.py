import os
import tempfile
import unittest

from migrun.runner import migrate

MIGRATIONS = os.path.join(os.path.dirname(__file__), "..", "migrations")


class FreshDatabaseTest(unittest.TestCase):
    def test_every_migration_applies_to_a_fresh_database(self):
        with tempfile.TemporaryDirectory() as directory:
            applied = migrate(os.path.join(directory, "app.db"), MIGRATIONS)
        self.assertEqual(len(applied), 10)


if __name__ == "__main__":
    unittest.main()