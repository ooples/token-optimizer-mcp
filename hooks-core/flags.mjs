/**
 * One reading of a boolean environment variable, for every switch this product has.
 *
 * Every flag was written with whichever spelling its author had in mind, and three
 * of them accepted exactly one: `TOKEN_OPTIMIZER_HARVEST_FULL=1` was silently
 * ignored because the code compared against `'true'`, and
 * `TOKEN_OPTIMIZER_ALLOW_EPHEMERAL_SHARED=true` was silently ignored because the
 * code compared against `'1'`. Nothing reported either one: the user had turned a
 * feature on in a way the product accepts elsewhere, and got the default.
 *
 * So the spellings live here once. `1`, `true`, `yes` and `on` turn a thing on;
 * `0`, `false`, `no` and `off` turn it off; case and surrounding space do not
 * matter. Anything else is not a decision and leaves the default standing -- a
 * typo must not read as the opposite of what the user meant.
 */

/** `1`, `true`, `yes`, `on` -- the affirmative spellings, and nothing else. */
const AFFIRMATIVE = /^(1|true|yes|on)$/;
/** `0`, `false`, `no`, `off` -- the negative spellings, and nothing else. */
const NEGATIVE = /^(0|false|no|off)$/;

/** The raw value, trimmed and lowercased, or '' when the variable is unset. */
const value = (name, env) => String((env || process.env)[name] || '').trim().toLowerCase();

/**
 * True only when the variable says yes. An unset variable, an empty one and an
 * unrecognised one are all "no decision" and answer false, so a switch that
 * defaults to off stays off unless it was deliberately turned on.
 */
export function flagOn(name, env) {
  return AFFIRMATIVE.test(value(name, env));
}

/**
 * True only when the variable says no. This is NOT `!flagOn` -- a flag whose
 * default is on must not be switched off by a typo, so an unrecognised value
 * answers false here too and the default survives.
 */
export function flagOff(name, env) {
  return NEGATIVE.test(value(name, env));
}