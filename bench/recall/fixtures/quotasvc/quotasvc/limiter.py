"""Allow at most `limit` requests in each fixed window of `window_ms`."""


class Limiter:
    def __init__(self, limit, window_ms):
        self.limit = limit
        self.window_ms = window_ms
        self._window_start = None
        self._used = 0

    def allow(self, now_ms):
        if self._window_start is None or now_ms - self._window_start >= self.window_ms:
            self._window_start = now_ms
            self._used = 0
        if self._used < self.limit:
            self._used += 1
            return True
        return False


def from_env(env):
    from . import config

    return Limiter(config.limit(env), config.window(env))