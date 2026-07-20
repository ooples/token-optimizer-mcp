# Token optimization (for Codex, OpenCode, and other AGENTS.md-aware agents)

This project provides a `token-optimizer` MCP server whose tools cut context/token
usage 60–90% via caching, diffing, and compression. When the MCP server is
configured (see the integration READMEs), prefer these tools:

- **`smart_read`** instead of reading a file directly when the file is **large**
  (>~400 lines / >25 KB) or you have **already read it** this session — on
  re-reads it returns only a **diff**, often a few tokens instead of the whole file.
- **`smart_glob`** instead of a content grep when searching a **big/unknown tree**
  — it returns **paths only** with filtering/pagination; read only what you need.
- **`smart_edit`** instead of a raw edit on **large files** — returns a compact
  unified diff rather than echoing the file.
- **`optimize_session`** when context is filling up; **`get_session_stats`** to see
  tokens saved.
- **`get_optimization_report`** to show the user how much they've saved — total
  tokens saved, overall %, and a breakdown by action/hook/server. It returns a
  ready-to-display `formatted` summary; show that when the user asks about savings.
- **`optimize_text`** to stash bulky text out-of-context under a key (retrieve
  later). **`compress_text`** is byte-compression for **at-rest storage only** —
  its base64 output usually costs *more* LLM tokens, so never feed it back into
  context.
- **`count_tokens`** to measure a chunk before deciding how to handle it.

Small files / one-off reads: the built-in tools are fine — don't add overhead.
