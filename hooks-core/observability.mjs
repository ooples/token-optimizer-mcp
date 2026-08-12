/**
 * Privacy-safe, cross-client lifecycle diagnostics.
 *
 * Hook processes are intentionally fail-open, but fail-open must not mean
 * fail-silent. Every client writes the same bounded JSONL schema so failures
 * can be correlated without storing prompts, commands, tool output, or file
 * contents.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOOK_LOG_SCHEMA_VERSION = 2;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_DEADLINE_MS = 4200;
const MAX_ERROR_CHARS = 4000;
const MAX_DIMENSION_CHARS = 160;
let activeInvocation = null;

function positiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function hookLogDirectory() {
  if (process.env.TOKEN_OPTIMIZER_LOG_DIR)
    return process.env.TOKEN_OPTIMIZER_LOG_DIR;
  const stateRoot =
    process.env.TOKEN_OPTIMIZER_STATE_DIR ||
    join(homedir(), '.token-optimizer');
  return join(stateRoot, 'logs');
}

function hash(value, length = 16) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function sanitize(text) {
  if (text === undefined || text === null) return null;
  let value = String(text);
  const home = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (home) value = value.replace(new RegExp(home, 'gi'), '<home>');
  value = value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{12,})\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  return value.slice(0, MAX_ERROR_CHARS);
}

function errorFields(error) {
  if (!error) return null;
  return {
    type: sanitize(error.name || error.constructor?.name || 'Error'),
    message: sanitize(error.message || error),
    stack: sanitize(error.stack),
  };
}

function dimension(value) {
  const sanitized = sanitize(value);
  return sanitized === null ? null : sanitized.slice(0, MAX_DIMENSION_CHARS);
}

function severity(level) {
  if (level === 'error') return { severityText: 'ERROR', severityNumber: 17 };
  if (level === 'warn') return { severityText: 'WARN', severityNumber: 13 };
  return { severityText: 'INFO', severityNumber: 9 };
}

function activeLogPath(now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return join(hookLogDirectory(), `hook-events-${date}.jsonl`);
}

function rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return;
    const maxBytes = positiveInteger('TOKEN_OPTIMIZER_LOG_MAX_BYTES', DEFAULT_MAX_BYTES);
    if (statSync(path).size < maxBytes) return;

    const lock = join(hookLogDirectory(), '.rotate.lock');
    try {
      mkdirSync(lock);
    } catch {
      return;
    }
    try {
      if (existsSync(path) && statSync(path).size >= maxBytes) {
        // Multiple hook processes (or several writes in one millisecond) must
        // never select the same rotation target and overwrite an earlier file.
        const rotated = path.replace(
          /\.jsonl$/,
          `-${Date.now()}-${process.pid}-${randomUUID()}.jsonl`
        );
        renameSync(path, rotated);
      }
    } finally {
      // Non-recursive removal of the one fixed-name lock directory only.
      try { rmdirSync(lock); } catch { /* best effort */ }
    }
  } catch {
    // Diagnostics must never become the reason a lifecycle hook fails.
  }
}

function pruneIfDue(now = new Date()) {
  try {
    const dir = hookLogDirectory();
    const marker = join(dir, '.last-prune');
    if (existsSync(marker) && now.getTime() - statSync(marker).mtimeMs < 60 * 60 * 1000)
      return;
    writeFileSync(marker, now.toISOString(), { flag: 'w' });

    const retentionMs =
      positiveInteger('TOKEN_OPTIMIZER_LOG_RETENTION_DAYS', DEFAULT_RETENTION_DAYS) *
      24 * 60 * 60 * 1000;
    const maxFiles = positiveInteger('TOKEN_OPTIMIZER_LOG_MAX_FILES', DEFAULT_MAX_FILES);
    const files = readdirSync(dir)
      .filter((name) => /^hook-events-.*\.jsonl$/.test(name))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 0; i < files.length; i++) {
      if (i >= maxFiles || now.getTime() - files[i].mtimeMs > retentionMs)
        unlinkSync(files[i].path);
    }
  } catch {
    // Retention is best effort and cannot affect the host tool call.
  }
}

export function writeHookEvent(event) {
  try {
    const now = new Date();
    const dir = hookLogDirectory();
    mkdirSync(dir, { recursive: true });
    const path = activeLogPath(now);
    rotateIfNeeded(path);
    const record = {
      schemaVersion: HOOK_LOG_SCHEMA_VERSION,
      timestamp: now.toISOString(),
      service: 'token-optimizer',
      serviceVersion:
        process.env.TOKEN_OPTIMIZER_VERSION ||
        process.env.npm_package_version ||
        'unknown',
      ...severity(event.level),
      body: event.event || 'hook.event',
      ...event,
    };
    record.resource = {
      'service.name': record.service,
      'service.version': record.serviceVersion,
      'host.arch': process.arch,
      'os.type': process.platform,
      'process.runtime.name': 'node',
      'process.runtime.version': process.version,
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    pruneIfDue(now);
    return path;
  } catch {
    return null;
  }
}

export function beginHookInvocation(client, event, options = {}) {
  const started = Date.now();
  const invocationId = randomUUID();
  let ended = false;
  let outcome = 'success';
  let reason = 'completed';
  let error = null;
  const dimensions = {
    sessionIdHash: null,
    turnIdHash: null,
    toolUseIdHash: null,
    toolName: null,
    rawToolName: null,
    codeModeEnvelope: false,
    clientVersion: null,
    model: null,
    cwdHash: null,
    payloadBytes: null,
    outputBytes: 0,
    outputShape: [],
    inputStatus: 'pending',
  };
  const spanId = hash(invocationId, 16);
  let traceId = hash(invocationId, 32);

  // Write the start before reading stdin or importing project state. If the
  // host kills the process, Node aborts, or a native call terminates without a
  // JavaScript exception, diagnostics can now reconcile this record with the
  // missing completion instead of reporting a false success rate.
  writeHookEvent({
    level: 'info',
    event: 'hook.started',
    invocationId,
    traceId,
    spanId,
    client,
    hookEvent: event,
    processId: process.pid,
  });

  let deadline;
  const finish = (nextOutcome = outcome, nextReason = reason, nextError = error) => {
    if (ended) return;
    ended = true;
    if (deadline) clearTimeout(deadline);
    process.removeListener('exit', onExit);
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
    writeHookEvent({
      level: nextOutcome === 'failure' || nextOutcome === 'timeout' ? 'error' : 'info',
      event: 'hook.completed',
      outcome: nextOutcome,
      reason: nextReason,
      durationMs: Date.now() - started,
      invocationId,
      traceId,
      spanId,
      client,
      hookEvent: event,
      processId: process.pid,
      ...dimensions,
      error: errorFields(nextError),
    });
  };
  const onExit = () => finish();
  const onUncaughtException = (nextError) => {
    finish('failure', 'uncaught_exception', nextError);
    process.exit(0);
  };
  const onUnhandledRejection = (nextError) => {
    finish('failure', 'unhandled_rejection', nextError);
    process.exit(0);
  };
  process.once('exit', onExit);
  process.once('uncaughtException', onUncaughtException);
  process.once('unhandledRejection', onUnhandledRejection);

  deadline = setTimeout(() => {
    outcome = 'timeout';
    reason = 'internal_deadline_exceeded';
    finish(outcome, reason);
    // Beat the host's five-second timeout and fail open deterministically.
    process.exit(0);
  }, options.deadlineMs ?? positiveInteger('TOKEN_OPTIMIZER_HOOK_DEADLINE_MS', DEFAULT_DEADLINE_MS));
  deadline.unref();

  const invocation = {
    invocationId,
    bind(raw = {}, payload = null, payloadBytes = null) {
      const sessionId = raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? null;
      dimensions.sessionIdHash = hash(sessionId);
      dimensions.turnIdHash = hash(raw.turn_id ?? raw.turnId ?? null);
      dimensions.toolUseIdHash = hash(raw.tool_use_id ?? raw.toolUseId ?? null);
      dimensions.toolName = payload?.tool_name ?? raw.tool_name ?? raw.toolName ?? null;
      dimensions.rawToolName = dimension(
        raw.tool_name ?? raw.toolName ?? raw.tool ?? null
      );
      dimensions.codeModeEnvelope =
        payload?.tool_input?.code_mode_envelope === true;
      dimensions.clientVersion = dimension(raw.client_version ?? raw.clientVersion ?? null);
      dimensions.model = dimension(raw.model ?? raw.model_name ?? raw.modelName ?? null);
      dimensions.cwdHash = hash(raw.cwd ?? raw.working_directory ?? process.cwd());
      dimensions.payloadBytes = payloadBytes;
      dimensions.inputStatus = 'ok';
      if (sessionId) traceId = hash(sessionId, 32);
    },
    noteInput(status, payloadBytes = null) {
      dimensions.inputStatus = status;
      dimensions.payloadBytes = payloadBytes;
      if (status === 'timeout') {
        outcome = 'timeout';
        reason = 'stdin_timeout';
      } else if (status !== 'ok') {
        outcome = 'skipped';
        reason = status;
      }
    },
    skip(nextReason) {
      outcome = 'skipped';
      reason = nextReason;
    },
    noteOutput(output, outputBytes = null) {
      dimensions.outputBytes = outputBytes ?? Buffer.byteLength(JSON.stringify(output), 'utf8');
      if (!output || typeof output !== 'object' || Array.isArray(output)) {
        dimensions.outputShape = [];
        return;
      }
      const shape = Object.keys(output).sort();
      const hookSpecific = output.hookSpecificOutput;
      if (hookSpecific && typeof hookSpecific === 'object' && !Array.isArray(hookSpecific)) {
        for (const key of Object.keys(hookSpecific).sort()) shape.push(`hookSpecificOutput.${key}`);
      }
      dimensions.outputShape = shape;
    },
    fail(nextError, nextReason = 'unhandled_exception') {
      outcome = 'failure';
      reason = nextReason;
      error = nextError;
      finish(outcome, reason, error);
    },
    block(nextReason = 'policy_denied') {
      outcome = 'blocked';
      reason = nextReason;
      finish(outcome, reason);
    },
    succeed(nextReason = 'completed') {
      outcome = 'success';
      reason = nextReason;
      finish(outcome, reason);
    },
  };
  activeInvocation = invocation;
  return invocation;
}

/** Records response metadata without retaining response content. */
export function noteHookOutput(output, outputBytes = null) {
  activeInvocation?.noteOutput(output, outputBytes);
}

export function recordHookBootstrapFailure(client, event, error) {
  writeHookEvent({
    level: 'error',
    event: 'hook.completed',
    outcome: 'failure',
    reason: 'bootstrap_import_failure',
    durationMs: 0,
    invocationId: randomUUID(),
    client,
    hookEvent: event,
    processId: process.pid,
    error: errorFields(error),
  });
}

export function readHookEvents({
  limit = 200,
  sinceMs = 24 * 60 * 60 * 1000,
  includeLifecycle = false,
} = {}) {
  try {
    const dir = hookLogDirectory();
    if (!existsSync(dir)) return [];
    const cutoff = Date.now() - Math.max(0, sinceMs);
    const files = readdirSync(dir)
      .filter((name) => /^hook-events-.*\.jsonl$/.test(name))
      .map((name) => join(dir, name))
      .sort()
      .reverse();
    const events = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (Date.parse(event.timestamp) < cutoff) continue;
          if (!includeLifecycle && event.event === 'hook.started') continue;
          events.push(event);
          if (events.length >= limit) return events;
        } catch {
          // A partially written final line must not hide the rest of the log.
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}

export function hookHealthSummary(options = {}) {
  const sinceMs = options.sinceMs ?? 24 * 60 * 60 * 1000;
  const events = readHookEvents({
    limit: options.limit || 10000,
    sinceMs,
    includeLifecycle: true,
  });
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
        Date.now() - Date.parse(event.timestamp) > 10_000
    )
    .map((event) => ({
      ...event,
      event: 'hook.completed',
      outcome: 'failure',
      reason: 'process_terminated_before_completion',
      durationMs: null,
    }));
  const runs = [...completed, ...abandoned];
  const durations = runs
    .map((event) => Number(event.durationMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const failures = runs.filter((event) => event.outcome === 'failure');
  const timeouts = runs.filter((event) => event.outcome === 'timeout');
  const skipped = runs.filter((event) => event.outcome === 'skipped');
  const blocked = runs.filter((event) => event.outcome === 'blocked');
  const successes = runs.filter((event) => event.outcome === 'success');
  const actions = runs.filter(
    (event) => event.hookEvent === 'pre-tool' && event.toolName
  );
  const byTool = {};
  for (const event of actions) {
    const name = String(event.toolName || 'Unknown action');
    byTool[name] = (byTool[name] || 0) + 1;
  }
  const byClient = {};
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
  const percentile = (p) =>
    durations.length
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))]
      : null;
  const summary = {
    schemaVersion: HOOK_LOG_SCHEMA_VERSION,
    available: runs.length > 0,
    windowHours: sinceMs / 3_600_000,
    total: runs.length,
    failures: failures.length,
    timeouts: timeouts.length,
    skipped: skipped.length,
    blocked: blocked.length,
    abandoned: abandoned.length,
    successes: successes.length,
    actions: actions.length,
    byTool,
    // A skipped or policy-blocked hook completed its protocol successfully.
    // Runtime health answers whether the hook process worked, not whether the
    // optimizer chose to allow the host operation.
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
    recentFailures: [...failures, ...timeouts]
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 20),
  };
  // Absolute paths are useful to a local doctor, but they do not belong in a
  // diagnostics export that may be attached to a public issue.
  if (options.includeLogDirectory === true)
    summary.logDirectory = hookLogDirectory();
  return summary;
}
