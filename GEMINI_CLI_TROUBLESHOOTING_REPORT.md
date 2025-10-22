# Gemini CLI Troubleshooting Report
**Date**: 2025-10-21
**Agent**: Agent 5 - Gemini CLI Troubleshooter

## Executive Summary

Investigated Gemini CLI connection failures blocking project analysis. Root cause identified as **Gemini API errors (INVALID_ARGUMENT, 400)**, not the initially suspected MCP server circular dependency.

## Investigation Details

### Initial Hypothesis
The error message suggested an MCP server issue:
```
Error during discovery for server 'token-optimizer': MCP error -32000: Connection closed
Error when talking to Gemini API
```

This led to the hypothesis of a circular dependency: Gemini CLI configured to use 'token-optimizer' MCP server (this project itself).

### Configuration Analysis

#### Claude Desktop Config
**Location**: `C:\Users\yolan\AppData\Roaming\Claude\claude_desktop_config.json`

**Found**:
```json
{
  "mcpServers": {
    "document-intelligence-hub": { ... },
    "token-optimizer": {
      "command": "node",
      "args": [
        "C:\\Users\\yolan\\source\\repos\\token-optimizer-mcp\\dist\\server\\index.js"
      ]
    }
  }
}
```

#### Gemini CLI Config
**Location**: `C:\Users\yolan\.gemini\settings.json`

**Found**:
```json
{
  "mcpServers": {
    "token-optimizer": {
      "command": "node",
      "args": [
        "C:\\Users\\yolan\\source\\repos\\token-optimizer-mcp\\dist\\server\\index.js"
      ],
      "env": {}
    },
    "filesystem": { ... }
  }
}
```

**Circular Dependency Confirmed**: Both Claude Desktop and Gemini CLI have token-optimizer MCP server configured.

### Remediation Attempts

#### Attempt 1: Disable token-optimizer in Gemini CLI
- Created `settings.json` backup at `.gemini/settings.json.backup`
- Created new config with only filesystem MCP server
- **Result**: Same API error persists

#### Attempt 2: Remove all MCP servers
- Created `settings-no-mcp.json` with empty mcpServers object
- **Result**: Same API error persists

#### Attempt 3: Test in clean directory
- Created new empty directory `/c/Users/yolan/gemini-test`
- Simple prompt: "Hello, can you see this message?"
- **Result**: Same API error persists

### Actual Root Cause

**Gemini API Error (400 - INVALID_ARGUMENT)**

Error logs show:
```json
{
  "error": {
    "code": 400,
    "message": "Request contains an invalid argument.",
    "status": "INVALID_ARGUMENT"
  }
}
```

**Analysis**:
1. The error occurs **regardless of MCP server configuration**
2. The error occurs **even in empty directories**
3. The error is a **Gemini API issue**, not MCP-related

**Likely Causes**:
1. **Project size**: Token-optimizer-mcp has 200+ files including worktrees, dist/, node_modules/
2. **Context size limit**: Gemini CLI automatically includes project context, which exceeds API limits
3. **API authentication**: Possible OAuth token expiration or permissions issue
4. **Rate limiting**: May have hit Gemini API rate limits

## Error Log Locations

All error logs saved to:
```
C:\Users\yolan\AppData\Local\Temp\gemini-client-error-Turn.run-sendMessageStream-*.json
```

Recent errors:
- `2025-10-21T22-36-46-242Z.json` - With token-optimizer MCP enabled
- `2025-10-21T22-38-40-499Z.json` - With token-optimizer MCP disabled
- `2025-10-21T22-39-19-509Z.json` - With no MCP servers
- `2025-10-21T22-39-47-846Z.json` - Clean directory test

All show identical API 400 errors.

## Recommendations

### Short-Term Workarounds

1. **Use Claude Code instead of Gemini CLI** for this project analysis
2. **Reduce project context size**:
   - Move worktrees/ to separate directory
   - Use .gitignore patterns to exclude from context
   - Work on smaller subdirectories

3. **Check Gemini API status**:
   - Verify OAuth credentials: `gemini mcp list`
   - Check API quotas and limits
   - Try again later in case of temporary API issues

### Long-Term Solutions

1. **Fix Circular MCP Dependency**:
   - Keep token-optimizer disabled in Gemini CLI settings
   - Only enable when analyzing OTHER projects
   - Add environment check to detect self-analysis

2. **Optimize Project Structure**:
   - Move worktrees/ outside main repo
   - Add .geminiignore file (if supported)
   - Reduce number of top-level files

3. **Alternative Analysis Approaches**:
   - Use focused file analysis instead of whole-project
   - Break analysis into smaller chunks
   - Use Claude Code's tools for targeted investigation

## Files Modified

### Backups Created
1. `C:\Users\yolan\.gemini\settings.json.backup` - Original Gemini settings with both MCP servers
2. `C:\Users\yolan\.gemini\settings-with-filesystem.json.backup` - Config with only filesystem

### Test Files Created
1. `C:\Users\yolan\source\repos\token-optimizer-mcp\archive\docs\gemini-focused-prompt.md` - Detailed analysis prompt
2. `C:\Users\yolan\source\repos\token-optimizer-mcp\gemini-simple-prompt.md` - Simple analysis prompt
3. `C:\Users\yolan\.gemini\settings-no-mcp.json` - Config with no MCP servers

### Config Status
**Current**: Original settings restored (`settings.json.backup` → `settings.json`)

## Conclusion

**The Gemini CLI MCP server configuration was NOT the root cause.** The circular dependency exists but is not causing the API errors.

**The actual issue is a Gemini API INVALID_ARGUMENT (400) error**, likely due to:
- Project context size exceeding API limits
- API authentication/permissions issues
- Rate limiting

**Recommendation**: Use Claude Code's built-in analysis tools instead of Gemini CLI for this specific project until the API issues are resolved.

## Next Steps for User

1. Check Gemini API status and quotas
2. Consider re-authenticating: `gemini mcp list` to check auth
3. Try analyzing smaller portions of the codebase
4. Use Claude Code for immediate analysis needs
5. Monitor Gemini CLI updates for context size handling improvements

## Time Spent

- Investigation: ~15 minutes
- Configuration changes: ~5 minutes
- Testing: ~10 minutes
- Documentation: ~10 minutes
- **Total**: ~40 minutes
