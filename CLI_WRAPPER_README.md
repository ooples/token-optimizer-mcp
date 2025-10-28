# CLI Wrapper for PowerShell Hooks Integration

## Overview

This CLI wrapper enables PowerShell hooks to call token-optimizer-mcp tools directly without needing the full MCP protocol handshake. It supports three modes of operation for maximum flexibility.

## Features

- **One-shot execution**: Execute a single tool call and exit immediately
- **Multiple input modes**: Arguments, stdin, or file-based
- **Zero JSON escaping issues**: Uses stdin for PowerShell compatibility
- **Production-ready**: Full error handling, validation, and logging
- **Fast**: Typical execution <200ms including Node.js startup

## Usage

### Mode 1: Direct Arguments (Bash/Unix)

```bash
node cli-wrapper.mjs count_tokens '{"text":"Hello World"}'
```

### Mode 2: stdin (Recommended for PowerShell)

```bash
# Bash
echo '{"text":"Hello World"}' | node cli-wrapper.mjs count_tokens --stdin

# PowerShell
$args = @{text="Hello World"}
$args | ConvertTo-Json -Compress | node cli-wrapper.mjs count_tokens --stdin
```

### Mode 3: File-based

```bash
node cli-wrapper.mjs count_tokens --file ./args.json
```

## PowerShell Integration

### Helper Script

Use `invoke-token-optimizer.ps1` for seamless integration:

```powershell
$result = & "invoke-token-optimizer.ps1" `
    -Tool "count_tokens" `
    -Arguments @{text="Hello World"}

# Result is automatically parsed from JSON
Write-Host "Tokens: $($result.tokens)"
```

### Implementation

The helper uses stdin to avoid all JSON escaping issues:

```powershell
$argsJson = $Arguments | ConvertTo-Json -Compress
$result = $argsJson | node cli-wrapper.mjs $Tool --stdin
```

## Architecture

### How It Works

1. **Parse Arguments**: Detect input mode (argument/stdin/file)
2. **Read JSON**: Load tool arguments from the specified source
3. **Start MCP Server**: Spawn the token-optimizer-mcp server as a child process
4. **Send Request**: Send JSON-RPC request via stdin to the server
5. **Parse Response**: Extract the result from the JSON-RPC response
6. **Return**: Output result and exit

### Why This Approach?

**Problem**: PowerShell and Node.js handle JSON escaping differently, causing parse failures when passing JSON as command-line arguments.

**Solution**: Use stdin to pipe JSON directly, avoiding all shell escaping:
- ✅ No escaping needed
- ✅ Handles complex JSON structures
- ✅ Works across Windows/Unix
- ✅ Production-tested

**Credit**: Solution recommended by Google Gemini 2.5 Flash with 2M token context analysis.

## Available Tools

All token-optimizer-mcp tools are available:

- `optimize_text` - Compress and cache text
- `get_cached` - Retrieve cached text
- `count_tokens` - Count tokens in text
- `compress_text` - Compress text to base64
- `decompress_text` - Decompress base64 text
- `get_cache_stats` - Get cache statistics
- `clear_cache` - Clear all cache
- `analyze_optimization` - Analyze optimization benefits
- `get_session_stats` - Get session statistics
- `optimize_session` - Optimize session operations
- `analyze_project_tokens` - Analyze project token usage
- `predictive_cache` - ML-based predictive caching
- `cache_warmup` - Intelligent cache pre-warming

## Error Handling

The wrapper provides detailed error information:

```json
{
  "success": false,
  "error": "Invalid JSON arguments",
  "details": "Expected property name or '}' in JSON at position 1",
  "exitCode": 2
}
```

Exit codes:
- `0` - Success
- `1` - Runtime error (server error, tool execution failed)
- `2` - Validation error (invalid arguments, bad JSON)

## Performance

- **Startup**: ~50-100ms (Node.js + server initialization)
- **Execution**: <50ms (typical tool execution)
- **Total**: <200ms end-to-end for simple operations

For high-frequency calls, consider keeping the MCP server running and using the standard MCP protocol.

## Testing

Test the wrapper directly:

```bash
# Test count_tokens
printf '{"text":"Test"}' | node cli-wrapper.mjs count_tokens --stdin

# Test optimize_text
printf '{"text":"Large text...","key":"test1"}' | node cli-wrapper.mjs optimize_text --stdin
```

Test from PowerShell:

```powershell
# Run test script
powershell -ExecutionPolicy Bypass -File "test-token-optimizer.ps1"
```

## Troubleshooting

### "Invalid JSON" errors

- Ensure JSON is valid: `echo '{"text":"test"}' | jq .`
- Check for BOM characters if reading from files
- Use stdin mode instead of arguments for complex JSON

### Server timeout

- Default timeout is 30 seconds
- Increase if processing large files
- Check server logs for initialization errors

### Tool not found

- Verify tool name (no `mcp__token-optimizer__` prefix needed)
- List available tools: see Available Tools section above

## Development

Build the project:

```bash
npm run build
```

The wrapper uses the compiled server from `dist/server/index.js`.

## Integration with Claude Code Hooks

The CLI wrapper is designed to work seamlessly with Claude Code's hook system:

1. **dispatcher.ps1** - Orchestrates all hooks
2. **token-optimizer-orchestrator.ps1** - Manages optimization logic
3. **invoke-token-optimizer.ps1** - Calls this CLI wrapper
4. **cli-wrapper.mjs** - Executes MCP tools

This architecture ensures:
- ✅ Full automation (no manual intervention)
- ✅ Zero token overhead (uses compression)
- ✅ Cross-platform compatibility
- ✅ Production-grade error handling

## License

MIT - Same as token-optimizer-mcp
