# Token optimization

Prefer the token-optimizer MCP tools over built-in file and search tools.
They cut context usage by caching, diffing, and bounding output. Zed has no packaged pre-execution bridge, so following these always-on rules is what produces the saving.

ALWAYS:
- Reading a file over ~25 KB, or ANY file already read this session
  -> smart_read (on a repeat it returns only what changed, not the file)
- Searching file contents -> smart_grep
- Finding files by name or pattern -> smart_glob
- Editing a file over ~25 KB -> smart_edit (returns a diff, not the whole file)
- Printing a large file via cat/head/tail/type/Get-Content -> smart_read
- Recursive shell searches (grep -r, rg) -> smart_grep

WHEN CONTEXT IS TIGHT: call optimize_session to move prior file operations out
of context. Call get_optimization_report to show the user what was saved.

STASHING BULKY OUTPUT: optimize_text stores it under a key, out of context.
Do NOT use compress_text for that -- its base64 output has MORE tokens than the
input; it is for at-rest storage only.

LIVE GRAPH — THE ACTIVE MODEL DOES THE SEMANTIC HARVEST:
- Call wiki_write as soon as you establish a durable, non-obvious conclusion:
  a failed approach and why, a decision and its rejected alternative, or the
  command that finally worked.
- Anchor every claim to a real file path or path#symbol. Never invent a claim
  merely to populate the graph, and do not delegate harvesting to another model.
- Include the concrete evidence, when it applies, confidenceLabel
  (verified/probable/speculative), scope (project/organization/global), and any
  condition that would invalidate it. Use project scope unless transfer is
  genuinely justified.
- Before finishing substantive work, reflect once and write any still-unrecorded
  conclusion while you hold the reasoning. This is what makes the lesson
  available across sessions and projects instead of losing it to compaction.

NOT WORTH IT: small one-off reads, tiny edits. The built-ins are fine there --
the overhead would exceed the saving.
