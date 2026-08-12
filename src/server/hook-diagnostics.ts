import fs from 'fs';
import os from 'os';
import path from 'path';

export interface HookDiagnosticEvent {
  event?: string;
  invocationId?: string;
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
  sinceMs = 24 * 60 * 60 * 1000,
  includeLifecycle = false
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
          if (!includeLifecycle && event.event === 'hook.started') continue;
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
  const events = readHookDiagnosticEvents(10000, sinceMs, true);
  const starts = events.filter((event) => event.event === 'hook.started');
  const completed = events.filter(
    (event) => event.event === 'hook.completed' || !event.event
  );
  const completedIds = new Set(
    completed.map((event) => event.invocationId).filter(Boolean)
  );
  const abandoned = starts
    .filter(
      (event) =>
        event.invocationId &&
        !completedIds.has(event.invocationId) &&
        Date.now() - Date.parse(event.timestamp || '') > 10_000
    )
    .map((event) => ({
      ...event,
      event: 'hook.completed',
      outcome: 'failure',
      reason: 'process_terminated_before_completion',
    }));
  const runs = [...completed, ...abandoned];
  const failures = runs.filter((event) => event.outcome === 'failure');
  const timeouts = runs.filter((event) => event.outcome === 'timeout');
  const skipped = runs.filter((event) => event.outcome === 'skipped');
  const blocked = runs.filter((event) => event.outcome === 'blocked');
  const successes = runs.filter((event) => event.outcome === 'success');
  const durations = runs
    .map((event) => Number(event.durationMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const byClient: Record<
    string,
    {
      total: number;
      failures: number;
      timeouts: number;
      skipped: number;
      blocked: number;
      hookEvents: string[];
    }
  > = {};
  for (const event of runs) {
    const key = event.client || 'unknown';
    const current = byClient[key] || {
      total: 0,
      failures: 0,
      timeouts: 0,
      skipped: 0,
      blocked: 0,
      hookEvents: [],
    };
    current.total++;
    if (event.outcome === 'failure') current.failures++;
    if (event.outcome === 'timeout') current.timeouts++;
    if (event.outcome === 'skipped') current.skipped++;
    if (event.outcome === 'blocked') current.blocked++;
    if (event.hookEvent && !current.hookEvents.includes(event.hookEvent))
      current.hookEvents.push(event.hookEvent);
    byClient[key] = current;
  }
  for (const current of Object.values(byClient)) current.hookEvents.sort();
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
    available: runs.length > 0,
    windowHours: sinceMs / 3_600_000,
    total: runs.length,
    failures: failures.length,
    timeouts: timeouts.length,
    skipped: skipped.length,
    blocked: blocked.length,
    abandoned: abandoned.length,
    successes: successes.length,
    successRate: runs.length
      ? (successes.length + skipped.length + blocked.length) / runs.length
      : null,
    healthStatus:
      failures.length || timeouts.length
        ? 'failing'
        : skipped.length
          ? 'degraded'
          : runs.length
            ? 'healthy'
            : 'unavailable',
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    byClient,
    recentFailures: runs
      .filter(
        (event) => event.outcome === 'failure' || event.outcome === 'timeout'
      )
      .slice(0, 20),
  };
}
