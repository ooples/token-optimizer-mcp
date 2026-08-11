import fs from 'fs';
import os from 'os';
import path from 'path';

export interface HookDiagnosticEvent {
  timestamp?: string;
  client?: string;
  hookEvent?: string;
  outcome?: string;
  reason?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const MAX_FILES = 10;
const MAX_BYTES_PER_FILE = 1024 * 1024;

export function hookDiagnosticDirectory(): string {
  if (process.env.TOKEN_OPTIMIZER_LOG_DIR)
    return process.env.TOKEN_OPTIMIZER_LOG_DIR;
  const stateRoot =
    process.env.TOKEN_OPTIMIZER_STATE_DIR ||
    path.join(os.homedir(), '.token-optimizer');
  return path.join(stateRoot, 'logs');
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
  // A bounded tail may begin in the middle of a JSONL record. Dropping the
  // first line is safer than presenting a parse error as a product failure.
  const text = buffer.toString('utf8');
  return size > length ? text.slice(text.indexOf('\n') + 1) : text;
}

export function readHookDiagnosticEvents(
  limit = 200,
  sinceMs = 24 * 60 * 60 * 1000
): HookDiagnosticEvent[] {
  try {
    const directory = hookDiagnosticDirectory();
    if (!fs.existsSync(directory)) return [];
    const cutoff = Date.now() - Math.max(0, sinceMs);
    const files = fs
      .readdirSync(directory)
      .filter((name) => /^hook-events-.*\.jsonl$/.test(name))
      .map((name) => path.join(directory, name))
      .sort()
      .reverse()
      .slice(0, MAX_FILES);
    const events: HookDiagnosticEvent[] = [];
    for (const file of files) {
      const lines = readTail(file).split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as HookDiagnosticEvent;
          if (event.timestamp && Date.parse(event.timestamp) < cutoff) continue;
          events.push(event);
          if (events.length >= limit) return events;
        } catch {
          // Concurrent append or a corrupt line cannot hide healthy records.
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function summarizeHookDiagnostics(
  sinceMs = 24 * 60 * 60 * 1000
): Record<string, unknown> {
  const events = readHookDiagnosticEvents(5000, sinceMs);
  const failures = events.filter((event) => event.outcome === 'failure');
  const timeouts = events.filter((event) => event.outcome === 'timeout');
  const skipped = events.filter((event) => event.outcome === 'skipped');
  const successes = events.filter((event) => event.outcome === 'success');
  const durations = events
    .map((event) => Number(event.durationMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const byClient: Record<
    string,
    { total: number; failures: number; timeouts: number; skipped: number }
  > = {};
  for (const event of events) {
    const key = event.client || 'unknown';
    const current = byClient[key] || {
      total: 0,
      failures: 0,
      timeouts: 0,
      skipped: 0,
    };
    current.total++;
    if (event.outcome === 'failure') current.failures++;
    if (event.outcome === 'timeout') current.timeouts++;
    if (event.outcome === 'skipped') current.skipped++;
    byClient[key] = current;
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
    available: events.length > 0,
    windowHours: sinceMs / 3_600_000,
    total: events.length,
    failures: failures.length,
    timeouts: timeouts.length,
    skipped: skipped.length,
    successRate: events.length ? successes.length / events.length : null,
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    byClient,
    recentFailures: events
      .filter(
        (event) => event.outcome === 'failure' || event.outcome === 'timeout'
      )
      .slice(0, 20),
  };
}
