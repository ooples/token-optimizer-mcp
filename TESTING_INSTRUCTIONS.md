# Testing Instructions for smart_read Caching (v2.4.0)

## Prerequisites

**CRITICAL**: Testing requires the published npm package to be available via `npx token-optimizer-mcp@latest`

### Before Testing:
1. ✅ Publish v2.4.0 to npm (includes `smart_read` tool)
2. ✅ Restart Claude Code (reconnects to updated MCP server)
3. ✅ Verify hooks are installed in `~/.claude-global/hooks/`

## Test Scenarios

### Test 1: Multi-Read Cache Hit (Same Session)

**Goal**: Verify that reading the same file twice in one session uses cache

**Steps**:
1. Start a new Claude Code conversation
2. Ask Claude to read a file: "Read package.json"
3. Immediately ask again: "Read package.json again"

**Expected Results**:
- First read: `NEW READ - FULL` in logs
- Second read: `CACHE HIT - FULL` in logs
- Token savings: 85-95% reduction

**Log Location**: `C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-orchestrator.log`

**Success Indicators**:
```
[2025-10-20 HH:MM:SS] [INFO] [smart-read] NEW READ - FULL: C:\...\package.json (XXX tokens, saved 0)
[2025-10-20 HH:MM:SS] [INFO] [smart-read] CACHE HIT - FULL: C:\...\package.json (YYY tokens, saved ZZZ)
```

### Test 2: Cross-Session Cache Hit

**Goal**: Verify SQLite persistence across Claude Code sessions

**Steps**:
1. **Session 1**: Ask Claude to read a file: "Read package.json"
2. End the conversation (close Claude Code or start new session)
3. **Session 2**: Ask Claude to read the same file: "Read package.json"

**Expected Results**:
- Session 1: `NEW READ - FULL` (populates cache)
- Session 2: `CACHE HIT - FULL` (uses persisted cache)
- Cache survives across sessions via SQLite

**Success Indicators**:
- Different session IDs in logs
- Second session shows `CACHE HIT` for file read in first session

### Test 3: Diff Mode After Edit

**Goal**: Verify diff mode returns only changes for modified files

**Steps**:
1. Ask Claude to read a file: "Read test-file.txt"
2. Ask Claude to edit the file: "Add a new line to test-file.txt"
3. Ask Claude to read it again: "Read test-file.txt"

**Expected Results**:
- First read: `NEW READ - FULL`
- Second read: `CACHE HIT - DIFF` (returns only the diff)
- Token savings: 95-99% reduction (only changed lines returned)

**Success Indicators**:
```
[INFO] [smart-read] NEW READ - FULL: C:\...\test-file.txt (1000 tokens, saved 0)
[INFO] [smart-read] CACHE HIT - DIFF: C:\...\test-file.txt (50 tokens, saved 950)
```

### Test 4: Large File Truncation

**Goal**: Verify automatic truncation of files exceeding maxSize (100KB)

**Steps**:
1. Ask Claude to read a large file (>100KB): "Read large-bundle.js"

**Expected Results**:
- Log shows truncation: `truncated: true` in metadata
- Content capped at ~100KB
- Prevents token overflow

### Test 5: Graceful Fallback

**Goal**: Verify that plain Read works if smart_read fails

**Steps**:
1. Temporarily break smart_read (e.g., wrong tool name in orchestrator)
2. Ask Claude to read a file: "Read package.json"

**Expected Results**:
- Log shows: "smart_read failed for ... - falling back to plain Read"
- Plain Read operation completes successfully
- No blocking of user operations

## Troubleshooting

### Issue: "Unknown tool: smart_read"
**Cause**: npm package v2.4.0 not yet published or Claude Code not restarted
**Fix**:
1. Publish v2.4.0 to npm
2. Restart Claude Code completely
3. Verify: `npx token-optimizer-mcp@latest` shows v2.4.0

### Issue: No cache hits observed
**Cause**: Cache not persisting or hook not intercepting Read
**Fix**:
1. Check logs: `C:\Users\cheat\.claude-global\hooks\logs\token-optimizer-orchestrator.log`
2. Verify hooks are running: Look for "Calling smart_read for: ..." messages
3. Check cache directory exists: `%USERPROFILE%\.token-optimizer-cache`

### Issue: Cache directory not found
**Cause**: Environment variable not set
**Fix**:
- invoke-mcp.ps1 sets `$env:TOKEN_OPTIMIZER_CACHE_DIR = "$env:USERPROFILE\.token-optimizer-cache"`
- Verify this directory is created on first run

## Performance Expectations

| Scenario | Token Reduction | Notes |
|----------|----------------|-------|
| Cache hit (full) | 85-95% | Gzip compressed content |
| Cache hit (diff) | 95-99% | Only changed lines returned |
| Large file truncation | Varies | Caps at 100KB regardless of file size |
| Cross-session | Same as above | SQLite persistence enables |

## Log Analysis

**Key log patterns to look for**:

```powershell
# Success pattern
[INFO] [smart-read] CACHE HIT - FULL: path/to/file (100 tokens, saved 900)

# New read pattern
[INFO] [smart-read] NEW READ - FULL: path/to/file (1000 tokens, saved 0)

# Diff pattern
[INFO] [smart-read] CACHE HIT - DIFF: path/to/file (50 tokens, saved 950)

# Fallback pattern
[WARN] [smart-read] smart_read failed for path/to/file - falling back to plain Read
```

## Success Criteria

✅ **Test 1 Passed**: Multi-read shows cache hits in same session
✅ **Test 2 Passed**: Cache persists across Claude Code sessions
✅ **Test 3 Passed**: Diff mode returns only changes
✅ **Test 4 Passed**: Large files truncated to 100KB max
✅ **Test 5 Passed**: Fallback to plain Read on smart_read failure

## Notes

- Testing requires **actual Claude Code runtime** with MCP server connected
- Standalone PowerShell testing won't work (invoke-mcp.ps1 uses npx, not local code)
- All syntax/logic errors have been fixed in PR #53
- Architecture is correct - just needs v2.4.0 published to npm
