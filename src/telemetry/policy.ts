/**
 * Whether anything may be measured, and whether anything may leave the machine.
 *
 * TWO SWITCHES, DELIBERATELY SEPARATE, because they answer different
 * questions. `TOKEN_OPTIMIZER_TELEMETRY` aggregates counters locally so a
 * report has something to show; nothing crosses the network. `..._BEACON`
 * uploads an anonymous summary. Overloading one flag to mean both would make
 * every operator who once turned on local stats begin transmitting the moment
 * they upgraded, having answered a different question. HeadRoom's own
 * implementation splits them for exactly this reason and says so in its
 * docstring; the split is worth copying, the default is not.
 *
 * BOTH DEFAULT OFF, AND THE BEACON IS OPT-IN. This is the one place this
 * package diverges from theirs on purpose: their beacon is on unless told
 * otherwise. We publish a telemetry badge, and a product that ships an
 * opt-out beacon behind an opt-in badge has lied twice — once in the badge and
 * once in the default. Lower data volume is the price, and it is the right
 * price.
 *
 * THE WHOLE POLICY IS THE TWO CONSTANTS BELOW, so the default is one line to
 * audit and one line to reverse. Anything that reads the environment directly
 * instead of going through here is a second policy, and a second policy is how
 * a promise gets broken by accident.
 */

/** Local aggregation. Off unless explicitly enabled. */
export const LOCAL_DEFAULT_ON = false;

/** Upload. Off unless explicitly enabled — see the note above before changing it. */
export const BEACON_DEFAULT_ON = false;

const ON_VALUES = new Set(['1', 'on', 'true', 'yes', 'enable', 'enabled']);
const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled']);

function explicit(raw: string | undefined): boolean | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (ON_VALUES.has(value)) return true;
  if (OFF_VALUES.has(value)) return false;
  return undefined;
}

/**
 * The cross-tool opt-out convention.
 *
 * Honoured for both switches, and honoured for any value that is not an
 * explicit off: someone who has already stated this preference should not have
 * to state it again per tool. `DO_NOT_TRACK=0` is the documented way to say
 * "no preference", so it is the only value that does not suppress.
 */
export function doNotTrack(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (!raw) return false;
  return !OFF_VALUES.has(raw);
}

/** Is local aggregation permitted? Fail-closed: an unrecognised value is off. */
export function localTelemetryEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (doNotTrack(env)) return false;
  return explicit(env.TOKEN_OPTIMIZER_TELEMETRY) ?? LOCAL_DEFAULT_ON;
}

/**
 * May anything be uploaded?
 *
 * Fail-closed, and independent of local aggregation in one direction only:
 * upload requires its own explicit yes, but it also requires that we are
 * allowed to measure at all — there is nothing to send otherwise.
 */
export function beaconEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (doNotTrack(env)) return false;
  const asked = explicit(env.TOKEN_OPTIMIZER_BEACON) ?? BEACON_DEFAULT_ON;
  if (!asked) return false;
  return localTelemetryEnabled(env);
}

/** Why transmission is or is not permitted, for `doctor` and for tests. */
export function describePolicy(env: NodeJS.ProcessEnv = process.env): string {
  if (doNotTrack(env)) return 'off: DO_NOT_TRACK is set';
  if (!localTelemetryEnabled(env)) {
    // AN EXPLICIT ZERO IS A DECISION, NOT AN OMISSION. Reporting it as
    // "unset" invites an operator to set what they already set, and in a
    // doctor output that reads as the tool not having noticed. Only an absent
    // or unrecognised value is genuinely unset.
    const raw = (env.TOKEN_OPTIMIZER_TELEMETRY ?? '').trim();
    return raw
      ? `off: local telemetry is explicitly disabled (${raw})`
      : 'off: local telemetry is opt-in and unset';
  }
  if (!beaconEnabled(env)) return 'local only: upload is opt-in and unset';
  return 'local and upload: both explicitly enabled';
}
