import unittest

from tzbook.buckets import bucket, daily_totals, day_of

# 2023-11-15 00:30 and 23:30, and 2023-11-16 00:10, in Coordinated Universal Time.
EARLY = 1700008200
LATE = 1700091000
NEXT = 1700093400


class DayOfTest(unittest.TestCase):
    def test_early_entry_is_on_the_fifteenth(self):
        self.assertEqual(day_of(EARLY), "2023-11-15")

    def test_late_entry_is_on_the_fifteenth(self):
        self.assertEqual(day_of(LATE), "2023-11-15")


class BucketTest(unittest.TestCase):
    def test_two_days(self):
        self.assertEqual(
            list(bucket([(NEXT, 5), (EARLY, 1), (LATE, 2)]).keys()),
            ["2023-11-15", "2023-11-16"],
        )

    def test_totals(self):
        self.assertEqual(
            daily_totals([(EARLY, 1), (LATE, 2), (NEXT, 5)]),
            [("2023-11-15", 3), ("2023-11-16", 5)],
        )


if __name__ == "__main__":
    unittest.main()