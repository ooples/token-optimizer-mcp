/**
 * Web Server for Token Optimizer Dashboard
 *
 * Serves the web-based dashboard UI for session visualization and real-time token usage
 * Port: 3100
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3100;

// BOM (Byte Order Mark) removal regex - used to strip UTF-8 BOM character (\uFEFF) from file content
const BOM_REGEX = /^\uFEFF/;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dashboard', 'public')));

// Helper function to get hooks data path
function getHooksDataPath(): string {
  return path.join(os.homedir(), '.claude-global', 'hooks', 'data');
}

// Helper function to get current session ID
function getCurrentSessionId(): string | null {
  try {
    const sessionFilePath = path.join(
      getHooksDataPath(),
      'current-session.txt'
    );
    if (!fs.existsSync(sessionFilePath)) {
      return null;
    }
    const sessionContent = fs
      .readFileSync(sessionFilePath, 'utf-8')
      .replace(BOM_REGEX, '');
    const sessionData = JSON.parse(sessionContent);
    return sessionData.sessionId;
  } catch (error) {
    console.error('Error getting current session ID:', error);
    return null;
  }
}

// API Routes

/**
 * GET /api/session-summary
 * Returns comprehensive session statistics from JSONL logs
 */
app.get('/api/session-summary', (req, res) => {
  try {
    const sessionId = (req.query.sessionId as string) || getCurrentSessionId();

    if (!sessionId) {
      return res.status(404).json({
        success: false,
        error: 'No active session found',
      });
    }

    const hooksDataPath = getHooksDataPath();
    const jsonlFilePath = path.join(
      hooksDataPath,
      `session-log-${sessionId}.jsonl`
    );

    if (!fs.existsSync(jsonlFilePath)) {
      return res.status(404).json({
        success: false,
        error: `JSONL log not found for session ${sessionId}`,
        sessionId,
      });
    }

    // Parse JSONL file
    const jsonlContent = fs.readFileSync(jsonlFilePath, 'utf-8');
    const lines = jsonlContent.trim().split('\n');

    // Initialize statistics
    let sessionStartTime = '';
    let sessionEndTime = '';
    let totalTurns = 0;
    let totalTools = 0;
    let totalHooks = 0;

    const tokensByCategory: Record<string, number> = {
      tools: 0,
      hooks: 0,
      responses: 0,
      system_reminders: 0,
    };

    const tokensByServer: Record<string, number> = {};
    const toolDurations: number[] = [];
    const toolBreakdown: Record<
      string,
      { count: number; tokens: number; totalDuration: number }
    > = {};
    const hookBreakdown: Record<string, { count: number; tokens: number }> = {};

    // Parse each JSONL event
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Extract session start/end times
        if (event.type === 'session_start') {
          sessionStartTime = event.timestamp;
        }

        if (event.type === 'session_end') {
          sessionEndTime = event.timestamp;
        }

        // Count turns
        if (event.turn && event.turn > totalTurns) {
          totalTurns = event.turn;
        }

        // Process tool calls
        if (event.type === 'tool_call') {
          totalTools++;
          const tokens = event.estimatedTokens || 0;
          tokensByCategory.tools += tokens;

          // Track by tool name
          if (!toolBreakdown[event.toolName]) {
            toolBreakdown[event.toolName] = {
              count: 0,
              tokens: 0,
              totalDuration: 0,
            };
          }
          toolBreakdown[event.toolName].count++;
          toolBreakdown[event.toolName].tokens += tokens;

          // Track by MCP server
          if (event.toolName.startsWith('mcp__')) {
            const serverName = event.toolName.split('__')[1] || 'unknown';
            tokensByServer[serverName] =
              (tokensByServer[serverName] || 0) + tokens;
          }
        }

        // Process tool results
        if (event.type === 'tool_result' && event.duration_ms) {
          toolDurations.push(event.duration_ms);

          if (toolBreakdown[event.toolName]) {
            toolBreakdown[event.toolName].totalDuration += event.duration_ms;
          }
        }

        // Process hook executions
        if (event.type === 'hook_execution') {
          totalHooks++;
          const tokens = event.estimated_tokens || 0;
          tokensByCategory.hooks += tokens;

          if (!hookBreakdown[event.hookName]) {
            hookBreakdown[event.hookName] = { count: 0, tokens: 0 };
          }
          hookBreakdown[event.hookName].count++;
          hookBreakdown[event.hookName].tokens += tokens;
        }

        // Process system reminders
        if (event.type === 'system_reminder') {
          const tokens = event.tokens || 0;
          tokensByCategory.system_reminders += tokens;
        }
      } catch (parseError) {
        continue;
      }
    }

    // Calculate totals
    const totalTokens = Object.values(tokensByCategory).reduce(
      (sum, val) => sum + val,
      0
    );

    // Calculate duration
    let duration = 'Unknown';
    if (sessionStartTime) {
      const endTime = sessionEndTime || new Date().toISOString();
      const start = new Date(sessionStartTime);
      const end = new Date(endTime);
      const diffMs = end.getTime() - start.getTime();
      const minutes = Math.floor(diffMs / 60000);
      const seconds = Math.floor((diffMs % 60000) / 1000);
      duration = `${minutes}m ${seconds}s`;
    }

    // Calculate average tool duration
    const avgToolDuration =
      toolDurations.length > 0
        ? Math.round(
            toolDurations.reduce((sum, d) => sum + d, 0) / toolDurations.length
          )
        : 0;

    const summary = {
      success: true,
      sessionId,
      sessionStartTime,
      sessionEndTime: sessionEndTime || null,
      totalTokens,
      totalTurns,
      totalTools,
      totalHooks,
      duration,
      tokensByCategory: {
        tools: {
          tokens: tokensByCategory.tools,
          percent:
            totalTokens > 0
              ? ((tokensByCategory.tools / totalTokens) * 100).toFixed(2)
              : '0.00',
        },
        hooks: {
          tokens: tokensByCategory.hooks,
          percent:
            totalTokens > 0
              ? ((tokensByCategory.hooks / totalTokens) * 100).toFixed(2)
              : '0.00',
        },
        responses: {
          tokens: tokensByCategory.responses,
          percent:
            totalTokens > 0
              ? ((tokensByCategory.responses / totalTokens) * 100).toFixed(2)
              : '0.00',
        },
        system_reminders: {
          tokens: tokensByCategory.system_reminders,
          percent:
            totalTokens > 0
              ? (
                  (tokensByCategory.system_reminders / totalTokens) *
                  100
                ).toFixed(2)
              : '0.00',
        },
      },
      tokensByServer,
      toolBreakdown,
      hookBreakdown,
      performance: {
        avgToolDuration_ms: avgToolDuration,
        totalToolCalls: totalTools,
        toolsWithDuration: toolDurations.length,
      },
    };

    return res.json(summary);
  } catch (error) {
    console.error('Error in /api/session-summary:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/session-events
 * Returns raw session events from JSONL logs for timeline visualization
 */
app.get('/api/session-events', (req, res) => {
  try {
    const sessionId = (req.query.sessionId as string) || getCurrentSessionId();
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!sessionId) {
      return res.status(404).json({
        success: false,
        error: 'No active session found',
      });
    }

    const hooksDataPath = getHooksDataPath();
    const jsonlFilePath = path.join(
      hooksDataPath,
      `session-log-${sessionId}.jsonl`
    );

    if (!fs.existsSync(jsonlFilePath)) {
      return res.status(404).json({
        success: false,
        error: `JSONL log not found for session ${sessionId}`,
      });
    }

    // Parse JSONL file
    const jsonlContent = fs.readFileSync(jsonlFilePath, 'utf-8');
    const lines = jsonlContent.trim().split('\n');
    const events = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (parseError) {
        continue;
      }
    }

    // Apply pagination
    const paginatedEvents = events.slice(offset, offset + limit);

    return res.json({
      success: true,
      sessionId,
      total: events.length,
      offset,
      limit,
      events: paginatedEvents,
    });
  } catch (error) {
    console.error('Error in /api/session-events:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: PORT,
  });
});

// Serve index.html for root route
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'public', 'index.html'));
});

// Start server
export function startWebServer() {
  app.listen(PORT, () => {
    console.log(
      `Token Optimizer Dashboard running on http://localhost:${PORT}`
    );
  });
}

// Start server if this file is run directly
if (__filename === process.argv[1]) {
  startWebServer();
}
