/**
 * Web Server for Token Optimizer Dashboard
 *
 * Serves the web-based dashboard UI for session visualization and real-time token usage
 * Port: 3100
 */

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { registerWikiRoutes } from './wiki-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
// Configurable because 3100 is a popular port and a collision is silent: the
// second server fails to bind while the FIRST one keeps answering, so anything
// probing the port gets stale results from a process it did not start. The UI
// verification hit exactly that and spent a run testing an old build.
const PORT =
  Number(process.env.PORT) ||
  Number(process.env.TOKEN_OPTIMIZER_DASHBOARD_PORT) ||
  3100;

// BOM (Byte Order Mark) removal regex - used to strip UTF-8 BOM character (\uFEFF) from file content
const BOM_REGEX = /^\uFEFF/;

// SECURITY (CWE-770): every dashboard route ends in a filesystem read, so an
// unthrottled client can turn the server into a disk-thrashing DoS. 300
// requests/min is far above what the dashboard UI generates while still
// bounding abuse.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(limiter);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dashboard', 'public')));

// Helper function to get hooks data path
function getHooksDataPath(): string {
  return path.join(os.homedir(), '.claude-global', 'hooks', 'data');
}

/**
 * Allowed session-id format, kept in sync with the MCP-side validator in
 * src/server/index.ts. Session IDs are generated as alphanumeric/dash tokens,
 * so this strict allowlist (no dots, no path separators) rejects any value
 * containing `.` traversal sequences before it is ever used to build a
 * filesystem path.
 *
 * SECURITY (CWE-22): both /api/session-summary and /api/session-events
 * concatenate the caller-supplied `sessionId` into a path. Without this guard,
 * a value like `abc/../../../../secret` resolves outside the hooks data dir,
 * allowing unauthenticated arbitrary `.jsonl` file reads.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns true when `sessionId` is safe to use in a path. Sends a 400 and
 * returns false otherwise so callers can `if (!validateSessionId(...)) return;`.
 */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId);
}

/**
 * Builds the absolute path of a session's log and proves containment:
 * returns null unless the resolved path stays inside the hooks data dir.
 * Defense-in-depth behind isValidSessionId (CWE-22 / js/path-injection).
 *
 * Both log formats are considered. `session-log-<id>.jsonl` is what this
 * server writes for a live session; `operations-<id>.csv` is what the
 * PowerShell hooks append to, and looking only for the former meant every
 * completed session read as missing. An existing file wins; when neither
 * exists the JSONL path is returned so callers' own existsSync checks and
 * error messages behave as before.
 */
function resolveSessionLogPath(sessionId: string): string | null {
  const base = path.resolve(getHooksDataPath());
  const candidates = [
    path.resolve(base, `session-log-${sessionId}.jsonl`),
    path.resolve(base, `operations-${sessionId}.csv`),
  ];

  for (const candidate of candidates) {
    const rel = path.relative(base, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null;
    }
  }

  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/**
 * Reads a session log as a list of JSONL event lines.
 *
 * The endpoints below understand a rich event stream -- session_start,
 * tool_call, tool_result, hook_execution, system_reminder. The PowerShell hooks
 * record only tool calls, in `operations-<id>.csv`, so those rows are lifted
 * into the same `tool_call` shape here. One event vocabulary downstream, two
 * formats on disk, and no branch in the middle of the statistics code.
 */
function readSessionEventLines(logFilePath: string): string[] {
  const content = fs.readFileSync(logFilePath, 'utf-8').replace(/^﻿/, '');

  if (!logFilePath.toLowerCase().endsWith('.csv')) {
    return content.trim().split('\n');
  }

  const rows = content.split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) return [];

  const header = splitCsvRow(rows[0]).map((h) => h.trim().toLowerCase());
  const iTime = header.indexOf('timestamp');
  const iTool = header.indexOf('toolname');
  const iTokens = header.indexOf('tokens');
  if (iTime === -1 || iTool === -1) return [];

  const events: string[] = [];
  for (const row of rows.slice(1)) {
    const cells = splitCsvRow(row);
    const toolName = cells[iTool]?.trim();
    const timestamp = cells[iTime]?.trim();
    if (!toolName || !timestamp) continue;

    const parsed = Number(cells[iTokens]?.trim());
    events.push(
      JSON.stringify({
        type: 'tool_call',
        timestamp,
        toolName,
        estimatedTokens: Number.isFinite(parsed) ? parsed : 0,
      })
    );
  }
  return events;
}

/**
 * Splits one CSV record, honouring double quotes. The metadata column holds
 * Windows paths and key=value pairs, both of which contain commas.
 */
function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
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

    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sessionId',
      });
    }

    const jsonlFilePath = resolveSessionLogPath(sessionId);
    if (!jsonlFilePath) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sessionId',
      });
    }

    if (!fs.existsSync(jsonlFilePath)) {
      return res.status(404).json({
        success: false,
        error: `No session log found for session ${sessionId}`,
        sessionId,
      });
    }

    // Read the log as JSONL events. A CSV log carries only tool calls, so it
    // is converted to the equivalent tool_call events rather than duplicating
    // the event handling below for a second format.
    const lines = readSessionEventLines(jsonlFilePath);

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

    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sessionId',
      });
    }

    const jsonlFilePath = resolveSessionLogPath(sessionId);
    if (!jsonlFilePath) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sessionId',
      });
    }

    if (!fs.existsSync(jsonlFilePath)) {
      return res.status(404).json({
        success: false,
        error: `No session log found for session ${sessionId}`,
      });
    }

    // Read as JSONL events, converting a CSV log on the way in.
    const lines = readSessionEventLines(jsonlFilePath);
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

// The wiki graph API. Registered before the catch-all root handler so its
// routes are matched first, and isolated in its own module because it loads the
// graph from plain ESM under hooks-core/ rather than from this build.
registerWikiRoutes(app);

// Serve the wiki graph browser.
app.get('/wiki', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'public', 'wiki.html'));
});

// Serve index.html for root route
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'public', 'index.html'));
});

// Start server
export function startWebServer() {
  const server = app.listen(PORT, () => {
    console.log(
      `Token Optimizer Dashboard running on http://localhost:${PORT}`
    );
  });

  // Graceful shutdown: the dashboard previously had NO lifecycle handlers, so a
  // SIGINT/SIGTERM left the HTTP listener dangling instead of closing cleanly.
  // Route both signals through one guarded close, and force-exit if connections
  // don't drain promptly.
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dashboard] shutting down (${reason})`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// Start server if this file is run directly
if (__filename === process.argv[1]) {
  startWebServer();
}
