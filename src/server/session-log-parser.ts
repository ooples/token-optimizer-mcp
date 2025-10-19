import fs from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

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
 * Parse a JSONL session log file and extract operations and token statistics
 *
 * This utility extracts tool call operations and system reminder tokens from
 * session log files, normalizing metadata to strings for consistent handling.
 *
 * Uses streaming with readline to avoid blocking the event loop on large files.
 *
 * @param jsonlFilePath - Path to the session-log.jsonl file
 * @returns Parsed operations and token counts
 *
 * @remarks
 * - Skips malformed JSONL lines silently
 * - Normalizes object metadata to JSON strings
 * - Returns empty arrays/zeros if file is empty
 * - Uses streaming for memory efficiency on large logs
 */
export async function parseSessionLog(jsonlFilePath: string): Promise<SessionLogData> {
  const operations: Operation[] = [];
  let systemReminderTokens = 0;
  let toolTokens = 0;

  const fileStream = createReadStream(jsonlFilePath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

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
          metadata: typeof event.metadata === 'string'
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
    } catch (parseError) {
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
