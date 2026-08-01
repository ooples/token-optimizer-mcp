import { createReadStream, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { isValidSessionId } from '../utils/session-id.js';

/**
 * Represents a parsed tool call operation from session logs
 */
export interface Operation {
  timestamp: string;
  toolName: string;
  tokens: number;
  metadata: string;
}

/**
 * Result of parsing a session log file
 */
export interface SessionLogData {
  operations: Operation[];
  toolTokens: number;
  systemReminderTokens: number;
}

/**
 * Locates a session's log, in whichever format it exists.
 *
 * TWO NAMES FOR THE SAME THING, AND ONLY ONE WAS EVER LOOKED FOR.
 *
 * Callers built `session-log-<id>.jsonl` by hand and reported "JSONL log not
 * found" when it was absent -- which is always, because nothing in this package
 * writes that file. The installed PowerShell hooks log every tool call to
 * `operations-<id>.csv` (hooks/handlers/token-optimizer-orchestrator.ps1), and
 * that is what actually accumulates on a working machine.
 *
 * Resolving the name in one place means the next caller cannot get it wrong,
 * and cannot drift.
 *
 * @returns the path to read, or null when this session genuinely has no log.
 */
export function resolveSessionLogPath(
  hooksDataPath: string,
  sessionId: string
): string | null {
  if (!isValidSessionId(sessionId)) return null;

  // The path is built from a DIRECTORY ENTRY, not from the caller's string --
  // the same shape the dashboard uses, for the same reason (CWE-22). The only
  // values joined to `hooksDataPath` come from the filesystem, so a session id
  // can select an existing log but can never shape a path. See the note in
  // web-server.ts.
  const wanted = [
    `session-log-${sessionId}.jsonl`,
    `operations-${sessionId}.csv`,
  ];

  let entries: string[];
  try {
    entries = readdirSync(hooksDataPath);
  } catch {
    return null;
  }

  const match = entries
    .filter((name) => wanted.includes(name))
    .sort((a, c) => wanted.indexOf(a) - wanted.indexOf(c))[0];

  return match ? join(hooksDataPath, match) : null;
}

/**
 * Splits one CSV record, honouring double quotes.
 *
 * The metadata column routinely holds commas -- Windows paths, key=value pairs
 * -- so splitting naively on ',' truncates it and shifts every later column.
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

/**
 * Parse a session log and extract operations and token statistics.
 *
 * Accepts both formats: the JSONL the web server writes for live sessions, and
 * the `operations-<id>.csv` the PowerShell hooks append to. The format is
 * chosen by extension, so a caller that resolved its path with
 * resolveSessionLogPath never has to know which it got.
 *
 * Uses streaming with readline to avoid blocking the event loop on large files.
 *
 * @param logFilePath - Path to a session-log-*.jsonl or operations-*.csv file
 * @returns Parsed operations and token counts
 *
 * @remarks
 * - Skips malformed lines silently
 * - Normalizes object metadata to JSON strings
 * - Returns empty arrays/zeros if file is empty
 * - CSV logs carry no system-reminder rows, so that total is 0 for them
 */
export async function parseSessionLog(
  logFilePath: string
): Promise<SessionLogData> {
  const operations: Operation[] = [];
  let systemReminderTokens = 0;
  let toolTokens = 0;

  const isCsv = logFilePath.toLowerCase().endsWith('.csv');

  const fileStream = createReadStream(logFilePath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  // CSV column positions, read from the header row rather than assumed, so a
  // reordered or extended header still parses instead of silently misreading.
  let csvCols: { time: number; tool: number; tokens: number; meta: number } | null = null;

  for await (const rawLine of rl) {
    const line = rawLine.replace(/^﻿/, '');
    if (!line.trim()) continue;

    if (isCsv) {
      const cells = splitCsvRow(line);
      if (!csvCols) {
        const header = cells.map((h) => h.trim().toLowerCase());
        csvCols = {
          time: header.indexOf('timestamp'),
          tool: header.indexOf('toolname'),
          tokens: header.indexOf('tokens'),
          meta: header.indexOf('metadata'),
        };
        // No timestamp or tool name means there is no operation to report.
        if (csvCols.time === -1 || csvCols.tool === -1) break;
        continue;
      }

      const toolName = cells[csvCols.tool]?.trim();
      const timestamp = cells[csvCols.time]?.trim();
      if (!toolName || !timestamp) continue;

      const parsed = Number(cells[csvCols.tokens]?.trim());
      const tokens = Number.isFinite(parsed) ? parsed : 0;
      operations.push({
        timestamp,
        toolName,
        tokens,
        metadata: csvCols.meta === -1 ? '' : (cells[csvCols.meta] ?? '').trim(),
      });
      toolTokens += tokens;
      continue;
    }

    try {
      const event = JSON.parse(line);

      // Process tool calls
      if (event.type === 'tool_call') {
        const tokens = event.estimatedTokens || 0;
        operations.push({
          timestamp: event.timestamp,
          toolName: event.toolName,
          tokens,
          // Normalize metadata to string
          metadata:
            typeof event.metadata === 'string'
              ? event.metadata
              : event.metadata !== undefined
                ? JSON.stringify(event.metadata)
                : '',
        });
        toolTokens += tokens;
      }

      // Process system reminders
      if (event.type === 'system_reminder') {
        const tokens = event.tokens || 0;
        systemReminderTokens += tokens;
      }
    } catch {
      // Skip malformed JSONL lines
      continue;
    }
  }

  return {
    operations,
    toolTokens,
    systemReminderTokens,
  };
}
