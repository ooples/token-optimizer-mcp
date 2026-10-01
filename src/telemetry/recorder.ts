/**
 * WHERE AN OPTED-IN EVENT ACTUALLY GOES.
 *
 * `policy.ts` decided whether we may measure and `event.ts` decided what an
 * event may contain, and between them they did nothing: no importer outside
 * their own tests existed, so a user who set TOKEN_OPTIMIZER_TELEMETRY=1 got
 * exactly the same behaviour as a user who set nothing. An opt-in that collects
 * nothing is worse than no opt-in, because the switch reads as a working
 * feature.
 *
 * LOCAL ONLY, AND THAT IS THE WHOLE DESIGN. This module writes to the user's own
 * disk and opens no socket. Aggregation and upload are two switches in
 * `policy.ts` for a reason, and keeping them two modules is what makes the
 * separation checkable rather than asserted: there is no network call in this
 * file to gate.
 *
 * IT MAY NEVER THROW INTO ITS CALLER. Telemetry is instrumentation, so a full
 * disk, a read-only home directory or a permissions failure has to degrade to
 * "no telemetry" and not to a failed tool call. Every entry point swallows, and
 * the swallow is the feature -- which is also why `lastError` exists, so
 * `doctor` can say the recording is silently not happening.
 *
 * APPEND-ONLY JSONL, BOUNDED. One line per event so a partial write costs one
 * event rather than the file, and a size ceiling so an unattended machine that
 * opts in cannot grow this without limit. When the ceiling is reached the file
 * is rotated once and the old one replaced: a fixed two-file cost, and the most
 * recent data is the data kept.
 */

/* eslint-disable n/no-sync -- DELIBERATE, and asynchronous I/O here would be a
 * defect rather than an improvement. `record` is called from synchronous hot
 * paths (the compressor and the output shaper), so a promise-returning write
 * would either be left unawaited -- losing events at exit and reordering the
 * log -- or force those call sites to become async, which is a far larger change
 * than instrumentation is entitled to impose. These are appends of a few hundred
 * bytes to a local file, already inside a try/catch that swallows every failure.
 * `beacon.ts`, which is async and off the hot path, uses the promise API. */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildEvent, type TelemetryEvent } from './event.js';
import { localTelemetryEnabled } from './policy.js';

/**
 * The directory the rest of the package already uses for per-user state.
 *
 * RESOLVED ON EVERY CALL, NOT ONCE AT IMPORT. A module-level constant is the
 * obvious way to write this and it is the reason the first version could not be
 * tested: the path was fixed by whichever home directory existed at import, so
 * no test could put the file somewhere disposable, and a module whose failure
 * paths cannot be exercised is a module that ships unwired -- which is exactly
 * what this one did.
 *
 * It is also simply more honest. Every other decision here reads the
 * environment when it is asked, so that a user who changes their mind is obeyed
 * from the next event. The location is no different.
 */
export function telemetryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeOf(env), '.token-optimizer-mcp', 'telemetry');
}

/** The live file. */
export function eventsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(telemetryDir(env), 'events.jsonl');
}

/** The one file kept behind it. */
export function rotatedFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(telemetryDir(env), 'events.1.jsonl');
}

/**
 * The home directory, from the same env everything else here is given.
 *
 * `os.homedir()` consults the process environment directly rather than the
 * object it is handed, so asking it would defeat threading `env` through at all.
 * It stays as the fallback for the case where neither variable is set, which is
 * the normal case in production.
 */
function homeOf(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE ?? env.HOME ?? homedir();
}

/**
 * The ceiling, in bytes, before the live file is rotated.
 *
 * An event is a few hundred bytes, so this is on the order of ten thousand
 * events -- far more than any analysis needs, and small enough that nobody
 * notices it on disk.
 */
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The version an event is stamped with, resolved once from our own manifest.
 *
 * RESOLVED HERE RATHER THAN PASSED IN, because three different binaries can be
 * the process that records: `server/index.js`, `proxy/cli.js` and
 * `server/daemon.js`. Handing the version in from the entry point means each of
 * the three has to remember to, and the two that forget stamp every event
 * 'unknown' while looking perfectly correct -- the same failure mode the consent
 * gate inside `record` exists to avoid. A module-relative read works from all
 * three, and from the tests, because the path is relative to this file.
 *
 * 'unknown' IS AN ACCEPTABLE ANSWER, not an error to raise: an event stamped
 * 'unknown' is still a usable event, and a telemetry module that threw because
 * it could not find a manifest would take a tool call down with it -- the one
 * thing this file may not do.
 */
let cachedVersion: string | null = null;

export function libraryVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const manifest = new URL('../../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    cachedVersion = typeof version === 'string' ? version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/** The last failure, for `doctor` to report. Null once something succeeds. */
let lastError: string | null = null;

/** Why recording is not happening, or null if nothing has failed. */
export function recorderLastError(): string | null {
  return lastError;
}

/** Bytes currently held, or null when the file is absent or unreadable. */
export function recordedBytes(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  try {
    return statSync(eventsFile(env)).size;
  } catch {
    return null;
  }
}

/**
 * Rotate when the live file has reached the ceiling.
 *
 * `renameSync` over the existing rotated file is a single atomic replace on
 * both platforms we ship to, so there is no window in which neither file
 * exists.
 */
function rotateIfFull(env: NodeJS.ProcessEnv): void {
  let size = 0;
  try {
    size = statSync(eventsFile(env)).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;
  renameSync(eventsFile(env), rotatedFile(env));
}

/**
 * Record one event, if the user has opted in.
 *
 * Returns the event that was written, or null when nothing was written -- which
 * covers both "not opted in" and "could not write". The caller is not expected
 * to care about the difference; `doctor` is.
 *
 * THE POLICY IS CHECKED HERE RATHER THAN AT THE CALL SITES, deliberately. A call
 * site that has to remember to ask is a call site that will eventually forget,
 * and forgetting means transmitting without consent. Reading the environment on
 * every call also means a user who changes their mind is obeyed from the next
 * event, with no restart and no cached decision.
 */
export function record(
  eventType: string,
  version: string = libraryVersion(),
  properties: Readonly<Record<string, unknown>> = {},
  env: NodeJS.ProcessEnv = process.env
): TelemetryEvent | null {
  if (!localTelemetryEnabled(env)) return null;
  const event = buildEvent(eventType, version, properties);
  try {
    mkdirSync(telemetryDir(env), { recursive: true });
    rotateIfFull(env);
    appendFileSync(eventsFile(env), `${JSON.stringify(event)}\n`, 'utf8');
    lastError = null;
    return event;
  } catch (err) {
    // SWALLOWED ON PURPOSE. See the header: instrumentation does not get to
    // fail a tool call. The message is kept so `doctor` can say so out loud
    // instead of the user believing their opt-in is working.
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}
