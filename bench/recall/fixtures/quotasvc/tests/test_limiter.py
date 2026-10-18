import unittest

from quotasvc.limiter import Limiter, from_env


class LimiterTest(unittest.TestCase):
    def test_limit_holds_inside_a_window(self):
        limiter = Limiter(limit=3, window_ms=1000)
        self.assertEqual([limiter.allow(t) for t in (0, 10, 20, 30)], [True, True, True, False])

    def test_window_resets(self):
        limiter = Limiter(limit=1, window_ms=1000)
        self.assertEqual([limiter.allow(t) for t in (0, 500, 1000)], [True, False, True])

    def test_defaults(self):
        limiter = from_env({})
        self.assertEqual((limiter.limit, limiter.window_ms), (100, 60_000))


if __name__ == "__main__":
    unittest.main()