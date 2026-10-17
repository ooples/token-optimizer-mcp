# quotasvc

A fixed-window request limiter.

## Configuration

| variable       | meaning                                   | default |
| -------------- | ----------------------------------------- | ------- |
| `QUOTA_LIMIT`  | requests allowed per window               | `100`   |
| `QUOTA_WINDOW` | length of the window, in seconds          | `60`    |

    python3 -m unittest discover -s tests -t .