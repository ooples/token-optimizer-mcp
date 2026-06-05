# Testing Instructions for smart_read Caching (v5.0.2)

## Prerequisites

**CRITICAL**: `smart_read` is reached through the long-running daemon, not the
MCP server process directly. Make sure:

1. ✅ Package built/installed at v5.0.2 (`smart_read` tool present).
2. ✅ The daemon is running and its Unix socket exists:
   `node -e 'console.log(require("path").join(require("os").tmpdir(),"token-optimizer-daemon.sock"))'`
   — the `dispatcher.sh` hook (`ensure_daemon`) spawns it automatically on the
   first tool call of a session.
3. ✅ Hooks installed in `~/.claude-global/hooks/` (WSL-native port —
   `dispatcher.sh`, not the Windows `dispatcher.ps1`).

> **Argument name:** `smart_read` takes `path` (a non-empty string), **not**
> `file_path`. Passing `file_path` now returns a clear validation error
> (`path: Invalid input: expected string, received undefined`) instead of the
> old `Cannot read properties of undefined (reading 'map')` crash.

> **Platform note (WSL port):** This repo runs under WSL2/Linux. Paths,
> logs, and the interception model differ from the upstream Windows/PowerShell
> docs. There is **no** `token-optimizer-orchestrator.log` and **no**
> `invoke-mcp.ps1`. State and logs live under `~/.claude-global/hooks/`.

### Key paths (WSL port)

| What | Path |
|------|------|
| Hook dispatcher | `~/.claude-global/hooks/dispatcher.sh` |
| Daemon client | `~/.claude-global/hooks/helpers/invoke-mcp.js` |
| Hook/debug log | `~/.claude-global/hooks/logs/dispatcher.log` |
| Daemon log | `~/.claude-global/hooks/logs/daemon.log` |
| Read-dedup state | `~/.claude-global/hooks/data/reads-<sid>.txt` |
| smart_read cache (SQLite) | `~/.token-optimizer-cache/cache.db` |

## How interception actually works (WSL port)

The Windows docs assumed a PowerShell orchestrator that rewrote every `Read`
into a `smart_read` call. The WSL port does **not** do that. Instead:

- **PreToolUse**: re-`Read` of an unchanged file (same path + mtime, already
  read this session) is **denied** with a "reuse content already in context"
  reason — this is dedup, not a cache-substituted re-read.
- **`smart_read` itself** is a normal MCP tool (full caching + diff + truncation)
  you invoke explicitly (or via the daemon), backed by `~/.token-optimizer-cache/cache.db`.

So validate `smart_read` by calling the tool, and validate live-Read dedup
separately (read the same file twice in a conversation → second is denied).

### Invoking smart_read directly (for tests)

```bash
INVOKE=~/.claude-global/hooks/helpers/invoke-mcp.js
node "$INVOKE" tools/call '{"name":"smart_read","arguments":{"path":"/abs/path/to/file"}}'
```

The result is JSON; inspect `.content[0].text` (itself JSON) for
`metadata.fromCache`, `metadata.isDiff`, `metadata.truncated`.

## Test Scenarios

### Test 1: Cache Hit (Same File Twice)

**Goal**: Reading the same unchanged file twice uses the cache.

**Steps**:
1. `smart_read {path: <file>}` — first call.
2. `smart_read {path: <file>}` — second call (unchanged file).

**Expected Results**:
- First call: `metadata.fromCache = false`, full content returned.
- Second call: `metadata.fromCache = true`, content `// No changes`,
  `metadata.isDiff = true`. ~85-95%+ token reduction.

### Test 2: Cross-Session / Persistence

**Goal**: Cache survives daemon/session restarts via SQLite.

**Steps**:
1. `smart_read {path: <file>}` to populate the cache.
2. Restart the daemon (`pkill -f token-optimizer-daemon`; it respawns on next
   hook, or start with `setsid token-optimizer-daemon &`).
3. `smart_read {path: <file>}` again.

**Expected Results**:
- After restart, second read still shows `fromCache = true`.
- Backing store present: `~/.token-optimizer-cache/cache.db` (+ `-wal`, `-shm`).

### Test 3: Diff Mode After Edit

**Goal**: Modified files return only the diff.

**Steps**:
1. `smart_read {path: <file>}`.
2. Append a line to the file.
3. `smart_read {path: <file>}`.

**Expected Results**:
- First read: `fromCache = false`, `isDiff = false`.
- Second read: `fromCache = true`, `isDiff = true`, content is just the diff
  (e.g. `+ line4-added`). 95-99% reduction.

### Test 4: Large File Truncation

**Goal**: Files exceeding `maxSize` (default 100KB) are truncated.

**Steps**:
1. `smart_read {path: <file >100KB>}`.

**Expected Results**:
- `metadata.truncated = true`; returned content capped (~100KB worth),
  `metadata.size` still reports the real file size.

### Test 5: Bad Argument / Graceful Failure

**Goal**: A missing/blank `path` fails cleanly (regression test for the
`reading 'map'` crash).

**Steps**:
1. Call with the wrong key: `smart_read {file_path: <file>}`.

**Expected Results**:
- Returns `isError: true` with message
  `Validation failed for tool "smart_read": - path: Invalid input: expected string, received undefined`.
- **No** `Cannot read properties of undefined (reading 'map')`.
- Live `Read` is never blocked: `dispatcher.sh` always exits 0.

## Troubleshooting

### Issue: "Cannot read properties of undefined (reading 'map')"
**Cause**: Old build — `validator.ts` read `error.errors`, removed in zod v4
(the global package bundles zod 4.x), so it was `undefined.map`.
**Fix**: Fixed in v5.0.2 (`error.issues ?? error.errors ?? []`). Rebuild
(`npm run build`) and, if the **global** install drives the daemon, copy the
patched `dist/validation/validator.js` into
`~/.local/lib/node_modules/@ooples/token-optimizer-mcp/dist/validation/` and
restart the daemon.

### Issue: "File not found: undefined" or no `path`
**Cause**: Called with `file_path` instead of `path`.
**Fix**: Use `path`. v5.0.2 also guards with a clear
`smart_read requires a non-empty "path" argument` message.

### Issue: No cache hits
**Fix**:
1. Confirm the daemon socket exists (see Prerequisites).
2. `tail ~/.claude-global/hooks/logs/daemon.log` for `IPC request: tools/call`.
3. Confirm `~/.token-optimizer-cache/cache.db` exists and grows.

### Issue: Second live Read not deduped
**Fix**: Dedup keys on `path + mtime` per session
(`~/.claude-global/hooks/data/reads-<sid>.txt`). A changed mtime or a
partial read (`offset`/`limit`) intentionally bypasses dedup.

## Performance Expectations

| Scenario | Token Reduction | Notes |
|----------|----------------|-------|
| Cache hit (no change) | 85-95%+ | Returns `// No changes` |
| Cache hit (diff) | 95-99% | Only changed lines returned |
| Large file truncation | Varies | Caps at `maxSize` (default 100KB) |
| Cross-session | Same as above | SQLite (`cache.db`) persistence |

## Success Criteria

✅ **Test 1**: Second read of unchanged file → `fromCache = true`, `// No changes`.
✅ **Test 2**: Cache survives daemon restart (`cache.db` present).
✅ **Test 3**: Edit then read → `isDiff = true`, only the diff returned.
✅ **Test 4**: >100KB file → `truncated = true`.
✅ **Test 5**: `file_path` (bad arg) → clean validation error, no `.map` crash.

## Notes

- This is the **WSL2/Linux native port**. Interception = `dispatcher.sh`
  (PreToolUse dedup + PostToolUse logging + UserPromptSubmit `optimize_session`),
  not the upstream PowerShell orchestrator.
- `smart_read` is invoked via the daemon (`invoke-mcp.js` → Unix socket), not
  `npx`. Daemon and hooks must share `TMPDIR`.
- Testing the tool can be done standalone via `invoke-mcp.js`; testing live-Read
  dedup requires an actual Claude Code conversation.
