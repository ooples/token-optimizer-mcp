# Token optimization

Prefer the token-optimizer MCP tools over built-in file and search tools.
They cut context usage 60-90% by caching, diffing, and bounding output. Crush
has no pre-execution hook, so nothing enforces this automatically -- following it
is what produces the saving.

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

NOT WORTH IT: small one-off reads, tiny edits. The built-ins are fine there --
the overhead would exceed the saving.
