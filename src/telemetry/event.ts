/**
 * The shape of what may be sent, and the guarantee that nothing else can be.
 *
 * MODELLED ON A TABLE THAT ALREADY EXISTS. aidotnet.dev's `telemetry_events`
 * holds `event_type`, `machine_id_hash`, `library_version`, `timestamp_utc`
 * and a `properties` json blob. Matching it means the receiver needs no new
 * schema, and matching it exactly means the fields are already known to be
 * content-free.
 *
 * TWO FIELDS OF OURS THEY DO NOT HAVE, and they are the reason this is worth
 * building at all: the holdout arm's outcome, and how often the graph answered
 * instead of a tool. Those are the only numbers that can say whether the graph
 * pays for itself, and today we learn that one machine at a time.
 *
 * THE GUARANTEE IS ENFORCED, NOT DOCUMENTED. `sanitiseProperties` drops any
 * value that is not a finite number or a boolean. Prompts, code, file paths,
 * command lines and error text are all strings, so a string cannot reach the
 * payload even by accident — a future field added carelessly fails closed
 * rather than leaking. The allowance for an enumerated string is deliberately
 * absent: every case so far is a count or a flag, and adding a string channel
 * "just for enums" is how the guarantee erodes.
 */

import { createHash } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';

/** Only these two primitive kinds may be transmitted. */
export type SafeValue = number | boolean;

export interface TelemetryEvent {
  readonly event_type: string;
  readonly machine_id_hash: string;
  readonly library_version: string;
  readonly timestamp_utc: string;
  readonly properties: Readonly<Record<string, SafeValue>>;
}

/**
 * A stable, non-reversible machine identifier.
 *
 * Hashed with a fixed salt so the same machine reports consistently while the
 * hostname cannot be recovered from it. Hostnames are frequently a person's
 * name or an employer's, which is why the raw value never leaves.
 */
export function machineIdHash(): string {
  const raw = `${hostname()}\u0000${platform()}\u0000${arch()}`;
  return createHash('sha256').update(`token-optimizer/v1\u0000${raw}`).digest('hex').slice(0, 32);
}

/**
 * Keeps only the values that cannot carry content.
 *
 * Non-finite numbers go too: NaN and Infinity are usually a division by a
 * count that was zero, and transmitting them tells the receiver nothing while
 * breaking json round-trips.
 */
export function sanitiseProperties(
  input: Readonly<Record<string, unknown>>
): Record<string, SafeValue> {
  const out: Record<string, SafeValue> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Builds an event, dropping anything that could carry content. */
export function buildEvent(
  eventType: string,
  version: string,
  properties: Readonly<Record<string, unknown>> = {}
): TelemetryEvent {
  return {
    event_type: eventType.slice(0, 100),
    machine_id_hash: machineIdHash(),
    library_version: (version || '0.0.0').slice(0, 50),
    timestamp_utc: new Date().toISOString(),
    properties: sanitiseProperties(properties),
  };
}
