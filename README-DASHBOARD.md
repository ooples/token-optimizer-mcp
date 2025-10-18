# Token Optimizer Dashboard

## Overview

The Token Optimizer Dashboard is a web-based UI for visualizing session activity and real-time token usage in Claude Code sessions. It provides comprehensive insights into token consumption patterns, tool usage, and performance metrics.

## Features

- **Real-time Token Usage Graphs**: Interactive charts showing token distribution across categories (tools, hooks, system reminders)
- **Interactive Tool Call Timeline**: Chronological visualization of all tool calls, hooks, and system events
- **Server Attribution Pie Charts**: Token usage breakdown by MCP server
- **Responsive Design**: Works on desktop, tablet, and mobile devices
- **Auto-refresh**: Dashboard updates automatically every 5 seconds
- **Performance Metrics**: Average tool duration and execution statistics

## Quick Start

### 1. Build the Project

```bash
npm run build
```

### 2. Start the Dashboard Server

```bash
npm run dashboard
```

The dashboard will be available at: **http://localhost:3100**

### 3. Development Mode

For development with auto-compilation:

```bash
npm run dashboard:dev
```

## Architecture

### Backend (Express.js Server)

**File**: `src/server/web-server.ts`

The web server runs on port 3100 and provides:

- **Static file serving**: Serves the dashboard UI from `src/dashboard/public/`
- **API endpoints**:
  - `GET /api/session-summary` - Comprehensive session statistics
  - `GET /api/session-events` - Raw session events for timeline visualization
  - `GET /api/health` - Health check endpoint

### Frontend

**Files**:
- `src/dashboard/public/index.html` - Main dashboard page
- `src/dashboard/public/css/styles.css` - Responsive styling
- `src/dashboard/public/js/dashboard.js` - Client-side logic and Chart.js integration

### Data Source

The dashboard reads session data from:
- `~/.claude-global/hooks/data/session-log-{sessionId}.jsonl` - JSONL event logs
- `~/.claude-global/hooks/data/current-session.txt` - Current active session

## API Documentation

### GET /api/session-summary

Returns comprehensive session statistics.

**Query Parameters**:
- `sessionId` (optional): Specific session ID to query. Defaults to current session.

**Response**:
```json
{
  "success": true,
  "sessionId": "abc123",
  "totalTokens": 15000,
  "totalTurns": 10,
  "totalTools": 25,
  "totalHooks": 5,
  "duration": "5m 30s",
  "tokensByCategory": {
    "tools": { "tokens": 8000, "percent": "53.33" },
    "hooks": { "tokens": 2000, "percent": "13.33" },
    "system_reminders": { "tokens": 5000, "percent": "33.33" }
  },
  "tokensByServer": {
    "github": 5000,
    "filesystem": 3000
  },
  "toolBreakdown": {
    "Read": { "count": 10, "tokens": 5000, "totalDuration": 1500 }
  },
  "performance": {
    "avgToolDuration_ms": 150,
    "totalToolCalls": 25
  }
}
```

### GET /api/session-events

Returns raw session events for timeline visualization.

**Query Parameters**:
- `sessionId` (optional): Specific session ID
- `limit` (optional): Number of events to return (default: 100)
- `offset` (optional): Pagination offset (default: 0)

**Response**:
```json
{
  "success": true,
  "sessionId": "abc123",
  "total": 250,
  "offset": 0,
  "limit": 100,
  "events": [
    {
      "type": "tool_call",
      "timestamp": "2025-10-16T12:00:00Z",
      "toolName": "Read",
      "estimatedTokens": 500,
      "turn": 1
    }
  ]
}
```

## Visualizations

### Token Distribution Chart (Doughnut)

Shows token usage breakdown by category:
- Tools (green)
- Hooks (orange)
- System Reminders (purple)
- Responses (blue)

### Server Attribution Chart (Pie)

Displays token usage by MCP server for multi-server sessions.

### Timeline

Interactive timeline showing:
- Tool calls (green border)
- Hook executions (orange border)
- System reminders (purple border)
- Timestamps and token counts

### Tool Breakdown Table

Sortable table with:
- Tool name
- Call count
- Total tokens
- Average duration

## Configuration

### Port Configuration

Default port: **3100**

To change the port, edit `src/server/web-server.ts`:

```typescript
const PORT = 3100; // Change to your desired port
```

### Refresh Interval

Default: **5 seconds**

To change the auto-refresh interval, edit `src/dashboard/public/js/dashboard.js`:

```javascript
const REFRESH_INTERVAL = 5000; // Change to desired milliseconds
```

## Browser Compatibility

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## Troubleshooting

### Dashboard not loading

1. Verify the server is running: `npm run dashboard`
2. Check that port 3100 is not in use
3. Ensure session log files exist in `~/.claude-global/hooks/data/`

### No data displayed

1. Start a Claude Code session to generate logs
2. Verify JSONL logging is enabled in your session
3. Check browser console for API errors

### CORS errors

The server has CORS enabled for local development. If you encounter CORS issues, verify the API_BASE URL in `dashboard.js` matches your server address.

## Security Considerations

- The dashboard is intended for local use only
- No authentication is implemented
- Do not expose port 3100 to the internet
- Session data may contain sensitive information

## Future Enhancements

- WebSocket support for real-time updates
- Export session data to CSV/JSON
- Historical session comparison
- Token usage trends over time
- Custom alerts and notifications

## License

ISC
