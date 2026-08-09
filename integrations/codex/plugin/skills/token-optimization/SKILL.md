---
name: token-optimization
description: Use the token-optimizer MCP tools to reduce context/token usage when reading, searching, or editing files, or when the context window is filling up. Trigger when reading large files, re-reading files already seen, searching a big/unknown tree, making edits to large files, or when you need to store bulky output out-of-context.
---

# Token optimization

This plugin ships a `token-optimizer` MCP server whose tools cut context usage
60–90% via caching, diffing, and compression. Prefer them over the built-in
tools in the situations below. The native hook refuses expensive built-in calls
and injects applicable graph findings; the active model still makes every MCP
tool call itself.

## When to use which tool

- **`smart_read`** instead of a plain file read when a file is **large**
  (roughly >400 lines / >25 KB) or you have **read it before this session**. It
  caches file content and, on re-reads, returns only a **diff** of what changed
  — often a handful of tokens instead of the whole file. Pass `path`; optionally
  `enableCache`, `diffMode`, `maxSize`, `includeMetadata`.

- **`smart_glob`** instead of a content grep for finding files in a **big or
  unfamiliar tree**. It returns **paths only** (no content) with filtering,
  sorting, and pagination — a fraction of the tokens of listing with content.
  Pass `pattern` (e.g. `src/**/*.ts`) and optionally `cwd`, `extensions`,
  `limit`.

- **`smart_edit`** instead of a raw edit for **large files**: it applies the
  edit and returns a compact unified **diff** rather than echoing the whole
  file. (For very small files a plain edit is fine — smart_edit's diff overhead
  is only worth it once the file is sizeable.)

- **`optimize_session`** / **`get_session_stats`** when the **context window is
  filling up** or after a burst of file operations. `optimize_session`
  batch-compresses prior file operations and stores them out-of-context;
  `get_session_stats` reports tokens saved so far.

- **`get_optimization_report`** when the user asks **how much they've saved**
  (or to show it proactively). Returns total tokens saved, overall savings %,
  approximate cost saved, and a full breakdown **by action, by hook phase, and
  by MCP server**, plus a pre-rendered `formatted` text summary you can display
  as-is.

- **`count_tokens`** to measure how expensive a chunk of text is before you
  decide how to handle it.

## Live graph

- Call **`wiki_write`** when you establish a durable, non-obvious conclusion:
  a failed approach and why, a decision and its rejected alternative, or a
  command that finally worked. Anchor it to a real file or `path#symbol`.
- Perform this semantic harvest yourself while you still hold the reasoning.
  Do not delegate it to another model, and do not invent a finding merely to
  populate the graph.
- Applicable findings are injected automatically when their file or command is
  touched. Use **`wiki_read`** for an explicit lookup.

## Storing bulky content out of context

- **`optimize_text`** — compress a large text blob under a `key` and keep it in
  the external cache instead of your context; retrieve it later by key. Reports
  `tokensSaved`. Good for logs, large outputs, or reference material you don't
  need inline right now.

- **`compress_text`** — Brotli+base64 compression. **Byte** reduction only:
  the base64 output usually has **more** LLM tokens than the input, so use it
  for **at-rest storage/caching, not for putting back into context.** The tool
  returns `increasesTokens` + a warning when that's the case.

## Rules of thumb

1. Reading a big file or one you've seen before → `smart_read`.
2. Searching a large/unknown tree → `smart_glob` (paths first, read only what
   you need).
3. Editing a large file → `smart_edit`.
4. Context getting tight → `optimize_session`, then continue.
5. Need to stash bulky output → `optimize_text` (by key), not `compress_text`
   into context.
6. Small files/one-off reads → the built-in tools are fine; don't add overhead.
