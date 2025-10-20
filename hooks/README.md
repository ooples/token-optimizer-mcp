# Claude Code Hooks Integration

This directory contains PowerShell hooks for integrating token-optimizer-mcp with Claude Code's lifecycle events.

## Directory Structure

```
hooks/
├── dispatcher.ps1                           # Main hook orchestrator
├── helpers/                                 # Helper scripts
│   ├── invoke-token-optimizer.ps1          # Direct CLI invocation via stdin
│   ├── test-token-optimizer.ps1            # Test script
│   └── debug-json.ps1                      # JSON debugging utility
└── handlers/                               # Hook handlers
    └── token-optimizer-orchestrator.ps1    # Token optimization logic
```

## Installation

1. Copy the `hooks/` directory to your Claude Code global hooks directory:
   ```powershell
   Copy-Item -Recurse hooks/* C:\Users\<YourUsername>\.claude-global\hooks\
   ```

2. Build the token-optimizer-mcp server:
   ```bash
   npm run build
   ```

3. The hooks will automatically find the CLI wrapper using relative paths.

## How It Works

### Hook Flow

1. **dispatcher.ps1**: Receives all hook events from Claude Code
   - Enforces best practices (e.g., use Gemini CLI instead of Read/Grep on code files)
   - Routes optimization logic to token-optimizer-orchestrator.ps1

2. **token-optimizer-orchestrator.ps1**: Manages token optimization
   - PreToolUse: Records operations
   - PostToolUse: Optimizes large file operations
   - UserPromptSubmit: Analyzes session and provides recommendations

3. **invoke-token-optimizer.ps1**: Calls MCP tools via CLI wrapper
   - Uses stdin to avoid JSON escaping issues
   - Returns parsed JSON results

### Architecture

```
Claude Code
    ↓ (hook event)
dispatcher.ps1
    ↓ (route to handler)
token-optimizer-orchestrator.ps1
    ↓ (call MCP tool)
invoke-token-optimizer.ps1
    ↓ (pipe JSON via stdin)
cli-wrapper.mjs
    ↓ (spawn & send JSON-RPC)
token-optimizer-mcp server
    ↓ (execute tool)
Result returned via JSON
```

## Features

- **Automatic Optimization**: Compresses large file operations to reduce token usage
- **Session Tracking**: Monitors token usage across sessions
- **Zero Manual Intervention**: Fully automated via hooks
- **Production-Ready**: Full error handling and logging
- **Cross-Platform**: Works on Windows/Unix with PowerShell Core

## Testing

Run the test script from the hooks/helpers directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "hooks/helpers/test-token-optimizer.ps1"
```

Expected output:
```
SUCCESS! Result:
{
  "tokens": 3,
  "characters": 23
}
```

## Troubleshooting

### Logs

Check logs for debugging:
```
C:\Users\<YourUsername>\.claude-global\hooks\logs\token-optimizer-calls.log
```

### Common Issues

1. **CLI wrapper not found**: Ensure you've run `npm run build` in the token-optimizer-mcp directory
2. **JSON parsing errors**: This should not happen as we're using stdin mode
3. **Permission errors**: Run PowerShell with appropriate execution policy: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

## Integration with Claude Code

These hooks integrate seamlessly with Claude Code's hook system:

1. **dispatcher.ps1** - Main orchestrator for all hooks
2. **token-optimizer-orchestrator.ps1** - Manages optimization logic
3. **invoke-token-optimizer.ps1** - Calls CLI wrapper
4. **cli-wrapper.mjs** - Executes MCP tools

This architecture ensures:
- ✅ Full automation (no manual intervention)
- ✅ Zero token overhead (uses compression)
- ✅ Cross-platform compatibility
- ✅ Production-grade error handling

## CLI Wrapper stdin Solution

The CLI wrapper uses Gemini's recommended stdin approach to avoid all JSON escaping issues between PowerShell and Node.js:

```powershell
# PowerShell side:
$argsJson = $Arguments | ConvertTo-Json -Compress
$result = $argsJson | node cli-wrapper.mjs count_tokens --stdin
```

```javascript
// Node.js side:
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  const toolArgs = JSON.parse(data);
  // Execute tool...
});
```

This completely avoids:
- Shell escaping issues
- BOM character problems
- PowerShell/Node.js quote handling differences

## License

MIT - Same as token-optimizer-mcp
