/**
 * Resolving the environment into one immutable rollout snapshot.
 *
 * READ ONCE, ASKED MANY TIMES. Every decision is made here and then frozen, so a
 * feature cannot answer differently at two points in a run because something
 * mutated process.env in between. That has a cost -- a caller holding a snapshot
 * will not see a later change -- and it is the point: a request that began with a
 * feature on must not finish with it off.
 *
 * PRECEDENCE, AND WHY IT DIFFERS FROM THE OBVIOUS DESIGN. The tidy rule would be
 * that the channel decides availability and nothing narrower may override it. That
 * rule would be wrong here, because every feature in the registry ALREADY SHIPPED
 * with its own environment variable and users have those set today. Making a
 * channel veto them would turn "we added a rollout system" into "your flag stopped
 * working", silently, with the flag still sitting in the settings file. So:
 *
 *   1. an off value in the feature's own variable   -> Disabled
 *   2. a name in TOKEN_OPTIMIZER_DISABLE_FEATURES   -> Disabled
 *   3. an on value in the feature's own variable    -> Explicit    (beats the channel)
 *   4. a name in TOKEN_OPTIMIZER_FEATURES           -> Requested   (channel-gated)
 *   5. the channel enables it by default            -> Default
 *   6. otherwise                                                   -> NotRequested
 *
 * Disabling always wins, at every level: a kill switch that can be outvoted is not
 * a kill switch. The generic request in (4) IS channel-gated, because unlike the
 * per-feature variable it is new -- nobody has it set already, so gating it breaks
 * nothing and it is the only place the channel can mean anything.
 *
 * Unknown names are dropped, not guessed at, and named in the refusals so the
 * inspector can show a user that the feature they thought they enabled does not
 * exist. `strict` throws instead, for the inspector and the tests.
 */

import { createHash } from 'node:crypto';
import {
  RolloutChannel,
  RolloutConfigurationError,
  channelAllows,
  normalise,
  parseChannel,
} from './channel.js';
import {
  FEATURES,
  FeatureName,
  FeatureSpec,
  allFeatures,
  featureFor,
  featureNames,
  registryDigest,
} from './features.js';

export const ROLLOUT_SCHEMA_VERSION = 1;

export const CHANNEL_ENV = 'TOKEN_OPTIMIZER_ROLLOUT_CHANNEL';
export const REQUEST_ENV = 'TOKEN_OPTIMIZER_FEATURES';
export const DISABLE_ENV = 'TOKEN_OPTIMIZER_DISABLE_FEATURES';

/** Why a feature ended up the way it did. Reported, never inferred by a caller. */
export enum DecisionReason {
  /** The channel runs it without being asked. */
  Default = 'default',
  /** Its own environment variable says on. */
  Explicit = 'explicit',
  /** Named in TOKEN_OPTIMIZER_FEATURES, and the channel allows it. */
  Requested = 'requested',
  /** Named in TOKEN_OPTIMIZER_FEATURES, but this channel does not carry it. */
  BlockedByChannel = 'blocked_by_channel',
  /** Switched off, by its own variable or by name. */
  Disabled = 'disabled',
  /** Nobody asked and no channel default applies. */
  NotRequested = 'not_requested',
}

export interface FeatureDecision {
  readonly name: FeatureName;
  readonly enabled: boolean;
  readonly reason: DecisionReason;
  /** The switch that turned it off, when one did, and null when none did. */
  readonly by: string | null;
  readonly availableIn: RolloutChannel;
  readonly defaultEnabledIn: RolloutChannel | null;
  readonly env: string;
}

export interface RolloutSnapshot {
  readonly schemaVersion: number;
  readonly channel: RolloutChannel;
  readonly registryDigest: string;
  readonly decisions: readonly FeatureDecision[];
  /** Every input this run could not use, in the order it was read. */
  readonly refusals: readonly string[];
  isEnabled(feature: FeatureName): boolean;
  decisionFor(feature: FeatureName): FeatureDecision;
  readonly enabled: readonly FeatureName[];
  /** A stable identity for the whole resolved state, for comparing two runs. */
  digest(): string;
}

const ON = /^(1|true|yes|on|enabled)$/i;
const OFF = /^(0|false|no|off|disabled)$/i;

/** Splits a comma or semicolon separated list, normalising each name. */
function splitNames(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .replace(/;/g, ',')
    .split(',')
    .map((part) => normalise(part))
    .filter((part) => part.length > 0);
}

/**
 * Turns a list of names into features, collecting what it could not use.
 *
 * Fail-closed: an unknown name contributes nothing. The alternative -- treating
 * an unrecognised name as a request for something -- is how a typo turns into an
 * experiment running in production.
 */
function resolveNames(
  raw: string | undefined,
  source: string,
  strict: boolean,
  refusals: string[]
): ReadonlySet<FeatureName> {
  const found = new Set<FeatureName>();
  for (const name of splitNames(raw)) {
    const spec = featureFor(name);
    if (spec === null) {
      const refusal =
        `unknown feature "${name}" in ${source}; known features: ` +
        featureNames().join(', ');
      if (strict) throw new RolloutConfigurationError(refusal);
      refusals.push(refusal);
      continue;
    }
    found.add(spec.name);
  }
  return found;
}

/** What the feature's own variable says, when it says anything usable. */
function ownSwitch(
  spec: FeatureSpec,
  env: NodeJS.ProcessEnv,
  strict: boolean,
  refusals: string[]
): boolean | null {
  const raw = env[spec.env];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (ON.test(trimmed)) return true;
  if (OFF.test(trimmed)) return false;
  for (const extra of spec.extraOnValues ?? []) {
    if (extra.toLowerCase() === trimmed.toLowerCase()) return true;
  }
  // A VALUE THAT IS NONE OF THOSE. Reported rather than read as truthy, because
  // `TOKEN_OPTIMIZER_PROXY_SUBSTITUTE=maybe` enabling substitution is exactly the
  // surprise a user cannot debug from the outside -- and reported rather than
  // silently dropped, because a variable that is set and does nothing is the state
  // a user is most likely to be wrong about.
  const known = ['1', '0', ...(spec.extraOnValues ?? [])].join(', ');
  const refusal =
    `${spec.env}="${trimmed}" is not a value this understands ` +
    `(try ${known}); ignoring it`;
  if (strict) throw new RolloutConfigurationError(refusal);
  refusals.push(refusal);
  return null;
}

export interface ResolveOptions {
  /** Extra names to request, as if they had been listed in the environment. */
  readonly requested?: readonly string[];
  /** Extra names to switch off. */
  readonly disabled?: readonly string[];
  /** Throw on anything unusable instead of collecting it. */
  readonly strict?: boolean;
}

export function resolveRollout(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {}
): RolloutSnapshot {
  const strict = options.strict === true;
  const refusals: string[] = [];

  const parsed = parseChannel(env[CHANNEL_ENV], { strict });
  if (parsed.refused !== null) refusals.push(parsed.refused);
  const channel = parsed.channel;

  const requested = new Set(
    resolveNames(env[REQUEST_ENV], REQUEST_ENV, strict, refusals)
  );
  for (const extra of options.requested ?? []) {
    for (const name of resolveNames(
      extra,
      'requested features',
      strict,
      refusals
    ))
      requested.add(name);
  }
  const switchedOff = new Set(
    resolveNames(env[DISABLE_ENV], DISABLE_ENV, strict, refusals)
  );
  for (const extra of options.disabled ?? []) {
    for (const name of resolveNames(
      extra,
      'disabled features',
      strict,
      refusals
    ))
      switchedOff.add(name);
  }

  const decisions: FeatureDecision[] = [];
  for (const spec of allFeatures()) {
    const own = ownSwitch(spec, env, strict, refusals);
    const available = channelAllows(channel, spec.availableIn);
    const decide = (): { enabled: boolean; reason: DecisionReason } => {
      if (own === false)
        return { enabled: false, reason: DecisionReason.Disabled };
      if (switchedOff.has(spec.name))
        return { enabled: false, reason: DecisionReason.Disabled };
      if (own === true)
        return { enabled: true, reason: DecisionReason.Explicit };
      if (requested.has(spec.name)) {
        return available
          ? { enabled: true, reason: DecisionReason.Requested }
          : { enabled: false, reason: DecisionReason.BlockedByChannel };
      }
      if (
        spec.defaultEnabledIn !== null &&
        channelAllows(channel, spec.defaultEnabledIn)
      ) {
        return { enabled: true, reason: DecisionReason.Default };
      }
      return { enabled: false, reason: DecisionReason.NotRequested };
    };
    const { enabled, reason } = decide();
    // WHICH kill switch, not just that one fired. The two are in different files --
    // one is the feature's own variable, the other a list -- and a user looking at a
    // feature that should be on needs to be told where to look, not that something
    // somewhere said no. The order here mirrors decide() above exactly.
    const by =
      own === false
        ? spec.env
        : switchedOff.has(spec.name)
          ? DISABLE_ENV
          : null;
    decisions.push({
      name: spec.name,
      enabled,
      reason,
      by,
      availableIn: spec.availableIn,
      defaultEnabledIn: spec.defaultEnabledIn,
      env: spec.env,
    });
  }

  const frozen = Object.freeze(decisions.map((d) => Object.freeze(d)));
  const byName = new Map(frozen.map((d) => [d.name, d]));
  let cached: string | null = null;

  const snapshot: RolloutSnapshot = {
    schemaVersion: ROLLOUT_SCHEMA_VERSION,
    channel,
    registryDigest: registryDigest(),
    decisions: frozen,
    refusals: Object.freeze([...refusals]),
    isEnabled(feature: FeatureName): boolean {
      // A name outside the registry cannot reach here through the enum, and a
      // missing entry would mean allFeatures() and FeatureName disagree -- which
      // is a bug in this file, not a state to default to on.
      const decision = byName.get(feature);
      return decision !== undefined && decision.enabled;
    },
    decisionFor(feature: FeatureName): FeatureDecision {
      const decision = byName.get(feature);
      if (decision === undefined) {
        throw new RolloutConfigurationError(
          `the registry has no feature "${feature}"`
        );
      }
      return decision;
    },
    get enabled(): readonly FeatureName[] {
      return frozen.filter((d) => d.enabled).map((d) => d.name);
    },
    digest(): string {
      if (cached !== null) return cached;
      // Lazy: the per-flag helpers resolve on every call and never ask for this.
      const canonical = {
        schema_version: ROLLOUT_SCHEMA_VERSION,
        channel,
        registry_digest: registryDigest(),
        features: frozen.map((d) => ({
          name: d.name,
          enabled: d.enabled,
          decision: d.reason,
        })),
      };
      cached =
        'sha256:' +
        createHash('sha256')
          .update(JSON.stringify(canonical), 'utf8')
          .digest('hex');
      return cached;
    },
  };
  return Object.freeze(snapshot);
}

/**
 * The one-flag question, for a call site that has no snapshot to hold.
 *
 * Resolving the whole environment to answer about one flag looks wasteful and is
 * not: it is a dozen string reads with no I/O, and the alternative -- each site
 * reading its own variable with its own idea of what "on" means -- is the state
 * this module replaced. Sites that ask repeatedly in one request should hold a
 * snapshot instead, so their answers cannot drift apart.
 */
export function featureEnabled(
  feature: FeatureName,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveRollout(env).isEnabled(feature);
}

export { FeatureName, FEATURES };
