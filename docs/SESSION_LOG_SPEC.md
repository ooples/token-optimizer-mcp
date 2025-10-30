# Session Log JSONL Format Specification

## Overview

This document defines the JSONL (JSON Lines) format for comprehensive session logging in the token-optimizer-mcp system. Each line is a complete JSON object representing a single event in the session.

## File Location

- **Path**: `C:\Users\yolan\.claude-global\hooks\data\session-log-{sessionId}.jsonl`
- **Format**: JSONL (one JSON object per line)
- **Encoding**: UTF-8

## Event Types

### 1. Session Start Event
```json
{"type":"session_start","sessionId":"20251013-083016-9694","timestamp":"2025-10-13 08:30:16","contextWindowLimit":200000}
```

### 2. Tool Call Event (PreToolUse)
```json
{"type":"tool_call","turn":1,"toolName":"Read","phase":"PreToolUse","timestamp":"2025-10-13 08:30:20","estimatedTokens":5000,"filePath":"C:\\path\\to\\file.ts"}
```

### 3. Tool Result Event (PostToolUse)
```json
{"type":"tool_result","turn":1,"toolName":"Read","phase":"PostToolUse","timestamp":"2025-10-13 08:30:22","duration_ms":2150,"actualTokens":4950,"filePath":"C:\\path\\to\\file.ts"}
```

### 4. Hook Execution Event (NEW in Priority 2)
```json
{"type":"hook_execution","turn":1,"hookName":"user-prompt-submit","timestamp":"2025-10-13 08:30:25","output":"Analyzing changes...","duration_ms":150,"estimated_tokens":50}
```

### 5. System Reminder Event
```json
{"type":"system_reminder","turn":2,"timestamp":"2025-10-13 08:31:00","content":"<system-reminder>...</system-reminder>","tokens":1500}
```

### 6. Session End Event
```json
{"type":"session_end","sessionId":"20251013-083016-9694","timestamp":"2025-10-13 09:15:30","totalTokens":125000,"totalTurns":45,"duration":"45m 14s"}
```

## Field Definitions

### Common Fields (all events)
- `type`: Event type (session_start, tool_call, tool_result, hook_execution, system_reminder, session_end)
- `timestamp`: ISO-like timestamp "YYYY-MM-DD HH:mm:ss"
- `turn`: Turn number (sequential, starts at 1)

### Tool-Specific Fields
- `toolName`: Name of the tool (Read, Write, Edit, Bash, mcp__*, etc.)
- `phase`: PreToolUse or PostToolUse
- `estimatedTokens`: Estimated token cost (PreToolUse)
- `actualTokens`: Actual token cost (PostToolUse, if different)
- `filePath`: File path for file-based operations (optional)
- `duration_ms`: Tool execution duration in milliseconds (PostToolUse only)

### Hook-Specific Fields (Priority 2)
- `hookName`: Name of the hook (user-prompt-submit, etc.)
- `output`: Hook output/summary
- `duration_ms`: Hook execution duration in milliseconds
- `estimated_tokens`: Estimated token cost of hook output

### Session Fields
- `sessionId`: Unique session identifier
- `contextWindowLimit`: Context window size for the AI model
- `totalTokens`: Total tokens used in session
- `totalTurns`: Total conversation turns
- `duration`: Human-readable duration

## Implementation Notes

### Turn Numbering
- Turns are sequential and start at 1
- Each user message + assistant response = 1 turn
- Tool calls within a turn share the same turn number
- Hook executions share the turn number of their triggering event

### Token Tracking
- `estimatedTokens`: Used during PreToolUse (best effort estimation)
- `actualTokens`: Used during PostToolUse (accurate tiktoken count when available)
- If `actualTokens` == `estimatedTokens`, the field may be omitted from PostToolUse

### Duration Measurements (Priority 2)
- Measured in milliseconds
- Captured by storing start timestamp during PreToolUse
- Calculated as: `end_timestamp - start_timestamp`
- Accuracy target: ±50ms

### Hook Detection (Priority 2)
- Hooks are detected by parsing user message XML tags: `<user-prompt-submit-hook>...</user-prompt-submit-hook>`
- Hook output is extracted and summarized (first 200 chars)
- Hook execution time is measured from hook invocation to completion
- Token estimation uses character-based heuristic (length / 4)

## Usage Examples

### Reading Session Statistics
```typescript
const fs = require('fs');
const readline = require('readline');

async function getSessionStats(sessionId) {
  const stream = fs.createReadStream(`session-log-${sessionId}.jsonl`);
  const rl = readline.createInterface({ input: stream });

  let totalTokens = 0;
  let toolCount = 0;
  let hookCount = 0;

  for await (const line of rl) {
    const event = JSON.parse(line);

    if (event.type === 'tool_call') {
      toolCount++;
      totalTokens += event.estimatedTokens || 0;
    }

    if (event.type === 'hook_execution') {
      hookCount++;
      totalTokens += event.estimated_tokens || 0;
    }
  }

  return { totalTokens, toolCount, hookCount };
}
```

### Finding Slow Tool Calls
```typescript
async function findSlowTools(sessionId) {
  const stream = fs.createReadStream(`session-log-${sessionId}.jsonl`);
  const rl = readline.createInterface({ input: stream });

  const slowTools = [];

  for await (const line of rl) {
    const event = JSON.parse(line);

    if (event.type === 'tool_result' && event.duration_ms > 5000) {
      slowTools.push({
        tool: event.toolName,
        duration: event.duration_ms,
        file: event.filePath
      });
    }
  }

  return slowTools;
}
```

## Migration from CSV

The existing CSV format will remain for backward compatibility:
```csv
timestamp,toolName,tokens,filePath
```

The JSONL format provides:
- ✅ Structured data (no CSV escaping issues)
- ✅ Additional metadata (hooks, durations, turn tracking)
- ✅ Easy parsing with standard JSON libraries
- ✅ Append-only design (no file locking issues)
- ✅ Better support for nested data

## Performance Considerations

- **Append-only writes**: Each event is a single `Add-Content` call
- **No file locking**: JSONL format doesn't require read-parse-write cycles
- **Efficient parsing**: Line-by-line streaming (doesn't load entire file into memory)
- **Small overhead**: Average line size ~200 bytes = 2KB for 10 events
- **Expected file size**: ~50KB per 250-event session

## Priority 2 Additions

### Hook Execution Tracking
- **Detection**: Parse `<user-prompt-submit-hook>` tags in user messages
- **Timing**: Measure from hook invocation to completion
- **Token Cost**: Estimate using character count / 4
- **Coverage Target**: 90%+ of hook executions captured

### Tool Duration Measurements
- **Storage**: `duration_ms` field in PostToolUse events
- **Accuracy**: ±50ms target
- **Implementation**: Store PreToolUse timestamp in global cache, calculate on PostToolUse
- **Fallback**: If start timestamp missing, omit duration field

### Session Summary API
New MCP tool: `get_session_summary(sessionId: string)`
Returns:
- Total tokens by category (tools, hooks, system reminders)
- Total turns and operations
- Session duration
- Token breakdown by server (for MCP tools)
- Hit rate and performance metrics
