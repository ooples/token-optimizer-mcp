import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from ordered_campaign import build_plan, patched_source, validate


class OrderTests(unittest.TestCase):
    def test_order_and_resume_identity(self):
        plan = {"arms": ["control", "proxy"], "orders": [["proxy", "control"], ["control", "proxy"]]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "order.json"
            path.write_text(json.dumps(plan))
            with patch.dict(os.environ, {"THOL_ARM_ORDER_FILE": str(path)}):
                result = build_plan(plan["arms"], ["a", "b"], 2)
        self.assertEqual(result[:2], [("proxy", "a", 1), ("control", "a", 1)])
        self.assertEqual(result[4:6], [("control", "a", 2), ("proxy", "a", 2)])
        self.assertEqual(len(set(result)), 8)

    def test_invalid_orders(self):
        for orders in [[['a', 'a']], [['a']], [['a', 'c']], []]:
            with self.assertRaises(ValueError):
                validate({"arms": ['a', 'b'], "orders": orders}, ['a', 'b'], 1)
        with self.assertRaises(ValueError):
            validate({"arms": ['b', 'a'], "orders": [['b', 'a']]}, ['a', 'b'], 1)

    def test_upstream_drift_fails_closed(self):
        with self.assertRaises(ValueError):
            patched_source('plan = []')
        source = 'plan = [(c, t, rep) for rep in range(1, args.reps + 1)\n            for t in task_names for c in comp_names]'
        self.assertIn('build_ordered_plan', patched_source(source))


if __name__ == '__main__':
    unittest.main()
