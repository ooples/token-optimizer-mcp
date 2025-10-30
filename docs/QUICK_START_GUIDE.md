# 🚀 Quick Start Guide: Comprehensive Session Logging

## Overview

The comprehensive session logging system provides detailed tracking of token usage across your Claude Code sessions, including:

- **Per-turn token breakdown** - See exactly how many tokens each conversation turn uses
- **Hook execution tracking** - Monitor token costs from Claude hooks
- **MCP server attribution** - Identify which servers consume the most tokens
- **Thinking mode detection** - Automatic identification of high-token analysis turns
- **Beautiful reports** - HTML reports with interactive charts and visualizations
- **Tech support ready** - Export detailed logs for troubleshooting

## Prerequisites

- Claude Code installed and configured
- token-optimizer-mcp MCP server enabled in claude_desktop_config.json
- Node.js 18+ (for running the MCP server)

## Step 1: Verify MCP Server is Running

After restarting Claude Code, verify the token-optimizer MCP server is loaded:

```bash
# In Claude Code, check available MCP tools
mcp__token-optimizer__get_session_stats
```

If you see output with session statistics, the server is working!

## Step 2: Start a New Session with JSONL Logging

The logging system automatically activates for new sessions. Just start using Claude Code normally!

**What happens behind the scenes:**
- PowerShell wrapper captures all tool calls
- System warnings are parsed for token tracking
- Events are written to `session-log.jsonl` in real-time
- MCP server attribution happens automatically

## Step 3: Generate Your First Report

After working for a while, generate a comprehensive session report:

### HTML Report (Recommended)

```typescript
mcp__token-optimizer__generate_session_report({
  format: "html",
  outputPath: "C:/Users/yolan/my-session-report.html"
})
```

**What you'll see:**
- 📊 Interactive pie chart showing token distribution
- 📡 Bar chart comparing MCP server usage
- 📈 Line chart showing hourly trends
- 🎯 Table of top token consumers
- ⚠️ Anomaly detection for high-token turns
- 💡 Automated optimization recommendations

### Markdown Report (For Documentation)

```typescript
mcp__token-optimizer__generate_session_report({
  format: "markdown",
  outputPath: "C:/Users/yolan/session-report.md"
})
```

Perfect for:
- Sharing with tech support
- Adding to project documentation
- Version control (Git-friendly format)

### JSON Export (For Programmatic Access)

```typescript
mcp__token-optimizer__generate_session_report({
  format: "json",
  outputPath: "C:/Users/yolan/session-data.json"
})
```

Use this for:
- Custom analysis scripts
- Integration with monitoring tools
- Data warehousing

## Step 4: Analyze Token Usage

Get detailed breakdowns without generating a full report:

### Quick Analysis

```typescript
mcp__token-optimizer__analyze_token_usage({
  topN: 10  // Show top 10 token consumers
})
```

### Group by MCP Server

```typescript
mcp__token-optimizer__analyze_token_usage({
  groupBy: "server",
  topN: 15
})
```

### Detect Anomalies

```typescript
mcp__token-optimizer__analyze_token_usage({
  anomalyThreshold: 2.5,  // Flag turns >2.5x average
  topN: 20
})
```

## Step 5: Get Session Summary

Quick overview of current session:

```typescript
mcp__token-optimizer__get_session_summary()
```

**Returns:**
- Total tokens used
- Total turns and tool calls
- Token breakdown by category (tools, hooks, responses)
- Token breakdown by MCP server
- Performance metrics (avg tool duration)
- Duration of session

## Common Use Cases

### 1. Daily Token Usage Review

At the end of each day, generate an HTML report:

```typescript
mcp__token-optimizer__generate_session_report({
  format: "html",
  outputPath: "C:/Users/yolan/reports/daily-2025-10-13.html"
})
```

Open in browser to see beautiful visualizations!

### 2. Identify Token-Heavy Operations

Find which tools are using the most tokens:

```typescript
mcp__token-optimizer__analyze_token_usage({
  groupBy: "tool",
  topN: 20
})
```

Use results to:
- Optimize frequently-used tools
- Enable caching for heavy operations
- Adjust workflow to reduce token usage

### 3. MCP Server Performance Comparison

See which MCP servers are most token-intensive:

```typescript
mcp__token-optimizer__analyze_token_usage({
  groupBy: "server"
})
```

Helps you:
- Choose efficient MCP servers
- Identify servers needing optimization
- Balance server usage across projects

### 4. Troubleshooting High Token Usage

If a session uses unexpectedly high tokens:

```typescript
// 1. Get quick summary
mcp__token-optimizer__get_session_summary()

// 2. Analyze with low anomaly threshold
mcp__token-optimizer__analyze_token_usage({
  anomalyThreshold: 2.0,
  topN: 30
})

// 3. Generate detailed HTML report for investigation
mcp__token-optimizer__generate_session_report({
  format: "html",
  outputPath: "C:/Users/yolan/troubleshooting/high-tokens.html"
})
```

### 5. Tech Support Submission

If you need to report an issue to Claude Code support:

```typescript
// Generate comprehensive Markdown report
mcp__token-optimizer__generate_session_report({
  format: "markdown",
  outputPath: "C:/Users/yolan/support/issue-report.md"
})

// Also export raw JSON data
mcp__token-optimizer__generate_session_report({
  format: "json",
  outputPath: "C:/Users/yolan/support/issue-data.json"
})
```

Attach both files to your support ticket!

## Understanding the Reports

### HTML Report Sections

1. **Session Summary** - Key metrics in colorful cards
   - Total tokens used
   - Total operations
   - Session duration
   - Average turn tokens
   - Thinking mode percentage

2. **Token Distribution Pie Chart**
   - Visual breakdown of top token consumers
   - Interactive (hover for details)
   - Shows percentage of total

3. **MCP Server Usage Bar Chart**
   - Compares token usage across servers
   - Helps identify heavy servers
   - Color-coded for clarity

4. **Hourly Trend Line Chart**
   - Shows token usage over time
   - Identifies peak usage periods
   - Useful for workload analysis

5. **Top Token Consumers Table**
   - Sortable by tool name, count, tokens, percentage
   - Shows average tokens per call
   - Helps identify optimization targets

6. **Anomalies Detected**
   - Lists turns with unusually high token usage
   - Includes detected mode (thinking/planning/normal)
   - Provides context for investigation

7. **Recommendations**
   - Automated optimization suggestions
   - Based on your usage patterns
   - Actionable insights

8. **Detailed Statistics**
   - Full breakdown by MCP server
   - Tool-by-tool analysis
   - Hook execution details

### Markdown Report Structure

```markdown
# Session Report: [Session ID]

## Summary
- Key metrics in bullet points

## Top Token Consumers
- Table with tool names, counts, tokens

## Anomalies Detected
- Table with turn numbers, reasons

## Recommendations
- Numbered list of actionable insights

## Detailed Breakdown
- By MCP server
- By tool type
- Performance metrics
```

### JSON Export Schema

```json
{
  "sessionId": "...",
  "summary": {
    "totalTokens": 123456,
    "totalOperations": 100,
    ...
  },
  "topConsumers": [...],
  "byServer": {...},
  "hourlyTrend": [...],
  "anomalies": [...],
  "recommendations": [...]
}
```

## Thinking Mode Detection

The system automatically detects when you're in "thinking mode" using these heuristics:

**Detected as Thinking:**
- `mcp__sequential-thinking__sequentialthinking` tool is used
- Turn uses >2x the average token count for the session

**Detected as Planning:**
- `TodoWrite` tool is used
- `ExitPlanMode` tool is used

**Why this matters:**
- Thinking mode typically uses 2-10x more tokens
- Helps explain high-token turns
- Normal behavior for complex problem solving

## Tips for Optimization

### 1. Review Reports Weekly

Generate HTML reports weekly to identify patterns:
- Which days have highest token usage?
- Which projects consume most tokens?
- Are there recurring high-token operations?

### 2. Use Caching Effectively

If reports show many repeated file reads:
```typescript
mcp__token-optimizer__optimize_session({
  min_token_threshold: 30
})
```

This caches frequently-read files for future sessions.

### 3. Balance Thinking Mode Usage

If >20% of turns are in thinking mode:
- Consider breaking down problems into smaller chunks
- Use thinking mode for complex analysis only
- Standard mode is sufficient for simple tasks

### 4. Monitor MCP Server Impact

If one server dominates token usage:
- Consider alternative servers for same functionality
- Check if server has caching features
- Report high usage to server developers

### 5. Track Trends Over Time

Save daily reports to compare:
```bash
C:/Users/yolan/reports/
  2025-10-13.html
  2025-10-14.html
  2025-10-15.html
```

Look for:
- Increasing token usage over time
- New high-token operations
- Efficiency improvements from optimizations

## Troubleshooting

### Tools Not Available

**Problem:** `mcp__token-optimizer__generate_session_report` returns "tool not available"

**Solution:**
1. Verify MCP server is in config:
   ```bash
   cat ~/.config/claude-code/claude_desktop_config.json
   # Look for "token-optimizer" section
   ```

2. Restart Claude Code completely (not just reload window)

3. Test basic tool:
   ```typescript
   mcp__token-optimizer__get_session_stats()
   ```

4. Check server logs:
   ```bash
   # Look for errors in Claude Code console
   # Or check token-optimizer-mcp build:
   cd C:/Users/yolan/source/repos/token-optimizer-mcp
   npm run build
   ```

### JSONL Log Not Found

**Problem:** `get_session_summary` returns "JSONL log not found"

**Solution:**
- JSONL logging is only available for NEW sessions after the system was implemented
- Old sessions use CSV format - use `get_session_stats` instead
- Start a new session to enable JSONL logging

### Report Generation Fails

**Problem:** `generate_session_report` returns an error

**Solution:**
1. Check if session has data:
   ```typescript
   mcp__token-optimizer__get_session_summary()
   ```

2. Verify output path is writable:
   ```bash
   # Make sure directory exists
   mkdir C:/Users/yolan/reports
   ```

3. Try different format:
   ```typescript
   // If HTML fails, try Markdown
   mcp__token-optimizer__generate_session_report({
     format: "markdown"
   })
   ```

### Charts Not Displaying

**Problem:** HTML report opens but charts are blank

**Solution:**
- Charts require internet connection (Google Charts CDN)
- Check browser console for errors
- Try different browser (Chrome recommended)
- Export to JSON and use alternative visualization

## Advanced Usage

### Batch Report Generation

Generate reports for multiple sessions:

```bash
# PowerShell script
$sessions = @(
  "20251013-083016-9694",
  "20251012-140000-1234",
  "20251011-090000-5678"
)

foreach ($sessionId in $sessions) {
  mcp__token-optimizer__generate_session_report({
    sessionId: $sessionId,
    format: "html",
    outputPath: "C:/Users/yolan/reports/$sessionId.html"
  })
}
```

### Custom Analysis Scripts

Read JSON export for custom analysis:

```javascript
// Node.js script
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('session-data.json', 'utf-8'));

// Find most expensive single operation
const maxOperation = data.topConsumers.reduce((max, op) =>
  op.tokens > max.tokens ? op : max
);

console.log(`Most expensive: ${maxOperation.tool} - ${maxOperation.tokens} tokens`);
```

### Integration with CI/CD

Monitor token usage in automated workflows:

```yaml
# GitHub Actions example
- name: Generate Token Report
  run: |
    echo "Generating session report..."
    # Call MCP tool via Claude Code CLI
    # Parse output for token budget violations
    # Fail build if usage exceeds threshold
```

## Next Steps

Now that you're familiar with the system:

1. **Start a new session** - Close and reopen Claude Code
2. **Do some work** - Use various tools and MCP servers
3. **Generate your first report** - Try HTML format first
4. **Explore the visualizations** - Open HTML in browser
5. **Share feedback** - Report bugs or suggest improvements

## Support and Resources

- **Documentation**: See `TOKEN_OPTIMIZATION_STRATEGY.md` for system architecture
- **Implementation Details**: See `PRIORITY_X_IMPLEMENTATION_REPORT.md` files
- **Bug Reports**: Submit issues to token-optimizer-mcp repository
- **Questions**: Check existing documentation or ask in community forums

---

**Happy Token Optimizing! 🚀**

Generated: 2025-10-13
Version: 1.0.0
Token Optimizer MCP: Comprehensive Session Logging System
