# Token optimization (Gemini CLI)

This extension adds the `token-optimizer` MCP server. Its tools cut context/token
usage 60–90% via caching, diffing, and compression. Prefer them:

- **`smart_read`** instead of reading a file directly when the file is **large**
  (>~400 lines / >25 KB) or already read this session — re-reads return a **diff**.
- **`smart_glob`** instead of a content grep on a **big/unknown tree** — returns
  **paths only**; read only what you need.
- **`smart_edit`** on **large files** — returns a compact diff, not the whole file.
- **`optimize_session`** when context fills up; **`get_session_stats`** for savings.
- **`get_optimization_report`** to show the user total tokens saved with a full
  breakdown by action/hook/server (returns a ready-to-display `formatted` summary).
- **`optimize_text`** to stash bulky text out-of-context under a key.
  **`compress_text`** is at-rest byte compression only — its base64 output usually
  costs *more* tokens, so never put it back into context.
- **`count_tokens`** to measure a chunk first.

Small files / one-off reads: built-in reading is fine — don't add overhead.
