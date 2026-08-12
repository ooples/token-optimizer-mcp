import fs from 'fs';
import path from 'path';
import { hookDiagnosticDirectory } from './hook-diagnostics.js';

export interface McpDiagnosticEvent {
  schemaVersion: 2;
  timestamp: string;
  service: 'token-optimizer';
  serviceVersion: string;
  event: string;
  outcome?: 'success' | 'failure';
  processId: number;
  client?: string | null;
  clientVersion?: string | null;
  toolName?: string;
  toolCount?: number;
  durationMs?: number;
  error?: { name: string; message: string } | null;
  [key: string]: unknown;
}

const MAX_FILES = 30;
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
let logPart = 0;

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function logPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(
    hookDiagnosticDirectory(),
    `mcp-events-${day}-${process.pid}-${logPart}.jsonl`
  );
}

function prune(directory: string): void {
  try {
    const files = fs
      .readdirSync(directory)
      .filter((name) => /^mcp-events-.*\.jsonl$/.test(name))
      .map((name) => ({
        path: path.join(directory, name),
        modified: fs.statSync(path.join(directory, name)).mtimeMs,
      }))
      .sort((a, b) => b.modified - a.modified);
    for (const file of files.slice(MAX_FILES))
      fs.rmSync(file.path, { force: true });
  } catch {
    // Diagnostics must never prevent the MCP server from starting.
  }
}

function safeError(error: unknown): { name: string; message: string } | null {
  if (!error) return null;
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  // Error messages are useful for startup diagnosis but can contain a local
  // path. Keep the category and a bounded message; never include a stack.
  return { name: name.slice(0, 80), message: message.slice(0, 500) };
}

export function recordMcpDiagnostic(
  event: Omit<
    McpDiagnosticEvent,
    'schemaVersion' | 'timestamp' | 'service' | 'processId' | 'error'
  > & { error?: unknown }
): void {
  try {
    const directory = hookDiagnosticDirectory();
    privateDirectory(directory);
    let file = logPath();
    if (fs.existsSync(file) && fs.statSync(file).size >= MAX_BYTES_PER_FILE) {
      logPart++;
      file = logPath();
    }
    const row: McpDiagnosticEvent = {
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
      service: 'token-optimizer',
      processId: process.pid,
      ...event,
      error: safeError(event.error),
    } as McpDiagnosticEvent;
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    prune(directory);
  } catch {
    // Logging is fail-open by design. A read-only home directory must not make
    // the optimizer disappear from a client's tool inventory.
  }
}

function readTail(file: string): string {
  const size = fs.statSync(file).size;
  const length = Math.min(size, MAX_BYTES_PER_FILE);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, 'r');
  try {
    fs.readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  const text = buffer.toString('utf8');
  return size > length ? text.slice(text.indexOf('\n') + 1) : text;
}

export function readMcpDiagnosticEvents(
  limit = 200,
  sinceMs = 24 * 60 * 60 * 1000
): McpDiagnosticEvent[] {
  try {
    const directory = hookDiagnosticDirectory();
    if (!fs.existsSync(directory)) return [];
    const cutoff = Date.now() - Math.max(0, sinceMs);
    const files = fs
      .readdirSync(directory)
      .filter((name) => /^mcp-events-.*\.jsonl$/.test(name))
      .map((name) => path.join(directory, name))
      .sort()
      .reverse()
      .slice(0, MAX_FILES);
    const events: McpDiagnosticEvent[] = [];
    for (const file of files) {
      const lines = readTail(file).split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as McpDiagnosticEvent;
          if (Date.parse(event.timestamp) < cutoff) continue;
          events.push(event);
          if (events.length >= limit) return events;
        } catch {
          // A concurrent partial append cannot hide the remaining healthy rows.
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function summarizeMcpDiagnostics(
  sinceMs = 24 * 60 * 60 * 1000
): Record<string, unknown> {
  const events = readMcpDiagnosticEvents(10000, sinceMs);
  const starts = events.filter(
    (event) => event.event === 'mcp.process_started'
  );
  const initialized = events.filter(
    (event) => event.event === 'mcp.client_initialized'
  );
  const lists = events.filter((event) => event.event === 'mcp.tools_listed');
  const calls = events.filter((event) => event.event === 'mcp.tool_completed');
  const failures = events.filter((event) => event.outcome === 'failure');
  const durations = calls
    .map((event) => Number(event.durationMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const latestList = lists
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  const clients: Record<
    string,
    { initialized: number; calls: number; failures: number }
  > = {};
  for (const event of [...initialized, ...calls]) {
    const key = event.client || 'unknown-mcp-client';
    const current = clients[key] || { initialized: 0, calls: 0, failures: 0 };
    if (event.event === 'mcp.client_initialized') current.initialized++;
    if (event.event === 'mcp.tool_completed') current.calls++;
    if (event.outcome === 'failure') current.failures++;
    clients[key] = current;
  }
  const percentile = (fraction: number): number | null =>
    durations.length
      ? durations[
          Math.min(
            durations.length - 1,
            Math.floor(durations.length * fraction)
          )
        ]
      : null;
  return {
    schemaVersion: 2,
    available: events.length > 0,
    windowHours: sinceMs / 3_600_000,
    processes: starts.length,
    initializedClients: initialized.length,
    toolListRequests: lists.length,
    advertisedTools: latestList?.toolCount ?? null,
    toolCalls: calls.length,
    failures: failures.length,
    successRate: calls.length
      ? calls.filter((event) => event.outcome === 'success').length /
        calls.length
      : null,
    healthStatus: failures.length
      ? 'failing'
      : initialized.length && lists.length
        ? 'healthy'
        : events.length
          ? 'starting'
          : 'unavailable',
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    clients,
    recentFailures: failures
      .slice()
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 20),
  };
}
