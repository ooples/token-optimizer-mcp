/**
 * The one place anything leaves the machine.
 *
 * READS THE FILE THE RECORDER ALREADY WROTE, rather than sending per event. An
 * upload on the hot path would put a network round trip inside a tool call, and
 * the first slow or unreachable receiver would be indistinguishable from a slow
 * tool. Batching from the log also means a machine that is offline for a week
 * loses nothing: the events are already on disk, and the next flush sends them.
 *
 * EVERY EVENT IS RE-VALIDATED HERE. The file is on disk and could have been
 * edited, truncated or appended to by anything with write access to the home
 * directory, so each line is parsed and rebuilt through `sanitiseProperties`
 * before it is allowed into a request body. The guarantee in event.ts is about
 * what we construct; this is about what we transmit, and they are not the same
 * claim once a file sits between them.
 *
 * IT MAY NEVER THROW INTO ITS CALLER, for the reason recorder.ts gives. Every
 * failure -- no key, no consent, unparseable file, refused request -- returns a
 * result saying what happened, and `doctor` prints it. A caller that wants to
 * know whether anything was sent reads `sent`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { eventsFile } from './recorder.js';
import { beaconEnabled } from './policy.js';
import { beaconKey, beaconTable, beaconUrl } from './credentials.js';
import { sanitiseProperties, type TelemetryEvent } from './event.js';

/** How many events one flush may send. */
export const MAX_BATCH = 500;

export interface FlushResult {
  /** How many events were accepted by the receiver. */
  readonly sent: number;
  /** Why nothing was sent, or null when something was. */
  readonly refused: string | null;
}

/**
 * Rebuilds an event from a stored line, or rejects it.
 *
 * A line that is missing a field is dropped rather than defaulted. A default
 * would invent a measurement -- a missing `library_version` filled in as the
 * running one attributes an old machine's numbers to this release -- and one
 * dropped line is cheaper than a wrong row.
 */
export function eventFromLine(line: string): TelemetryEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof row[key] === 'string' && row[key] !== '' ? (row[key] as string) : null;
  const eventType = str('event_type');
  const machine = str('machine_id_hash');
  const version = str('library_version');
  const at = str('timestamp_utc');
  if (!eventType || !machine || !version || !at) return null;
  const properties =
    row.properties && typeof row.properties === 'object' && !Array.isArray(row.properties)
      ? (row.properties as Record<string, unknown>)
      : {};
  return {
    event_type: eventType.slice(0, 100),
    machine_id_hash: machine.slice(0, 64),
    library_version: version.slice(0, 50),
    timestamp_utc: at.slice(0, 40),
    properties: sanitiseProperties(properties),
  };
}

/**
 * Everything on disk that is fit to send, oldest first.
 *
 * Asynchronous because nothing needs it synchronously -- both callers are async
 * -- and the recorder's sync writes are on the hot path where this is not.
 */
export async function pendingEvents(
  env: NodeJS.ProcessEnv = process.env
): Promise<TelemetryEvent[]> {
  let text = '';
  try {
    text = await readFile(eventsFile(env), 'utf8');
  } catch {
    return [];
  }
  const out: TelemetryEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const event = eventFromLine(line);
    if (event) out.push(event);
    if (out.length >= MAX_BATCH) break;
  }
  return out;
}

/**
 * Sends what is pending, and clears the log only on success.
 *
 * CLEARING IS THE LAST THING IT DOES, and only when the receiver accepted. The
 * obvious order -- read, clear, send -- loses the batch on any failed request,
 * which is how a week of an intermittent connection becomes no data at all. The
 * cost of this order is a duplicate if the response is lost after the insert
 * lands, which the receiver can deduplicate and this cannot.
 */
export async function flushBeacon(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<FlushResult> {
  if (!beaconEnabled(env)) return { sent: 0, refused: 'upload is not enabled' };
  const key = beaconKey(env);
  if (!key)
    return {
      sent: 0,
      refused: 'no beacon key: this build was packed without one',
    };
  const events = await pendingEvents(env);
  if (!events.length) return { sent: 0, refused: 'nothing to send' };
  const endpoint = `${beaconUrl(env)}/rest/v1/${beaconTable(env)}`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: key,
        authorization: `Bearer ${key}`,
        // Nothing is read back, so the receiver need not serialise rows to
        // return them.
        prefer: 'return=minimal',
      },
      body: JSON.stringify(events),
    });
  } catch (err) {
    return {
      sent: 0,
      refused: `upload failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok)
    return { sent: 0, refused: `receiver refused with ${response.status}` };
  try {
    await writeFile(eventsFile(env), '', 'utf8');
  } catch {
    // The rows are in. A log that could not be truncated means the next flush
    // sends them again, which is the receiver's problem to deduplicate and not
    // a reason to report this flush as failed.
  }
  return { sent: events.length, refused: null };
}
