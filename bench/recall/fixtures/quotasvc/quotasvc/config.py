"""Read the limiter's settings from the environment."""

DEFAULT_LIMIT = 100
DEFAULT_WINDOW = 60_000


def limit(env):
    raw = env.get("QUOTA_LIMIT")
    return int(raw) if raw else DEFAULT_LIMIT


def window(env):
    raw = env.get("QUOTA_WINDOW")
    return int(raw) if raw else DEFAULT_WINDOW