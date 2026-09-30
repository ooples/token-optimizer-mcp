/**
 * Runtime rollout channels.
 *
 * A channel controls what an already-installed copy DOES. It selects no package
 * and no version: a user on `beta` is running the same bytes as a user on
 * `stable` and taking a different set of behaviours out of them. That separation
 * is the whole point -- an experiment can be turned on for the people who want it
 * without shipping them a different build to roll back from.
 *
 * The channels are ORDERED, and a wider channel takes everything the narrower one
 * has. Without that, "available in beta" and "available in canary" would be two
 * unrelated sets and a canary user would silently lose a beta feature.
 */

export enum RolloutChannel {
  Stable = 'stable',
  Beta = 'beta',
  Canary = 'canary',
  Dev = 'dev',
}

/** How wide each channel is. Compared, never printed. */
const ORDER: Readonly<Record<RolloutChannel, number>> = {
  [RolloutChannel.Stable]: 0,
  [RolloutChannel.Beta]: 1,
  [RolloutChannel.Canary]: 2,
  [RolloutChannel.Dev]: 3,
};

/**
 * Names people actually type, mapped to the channel they mean.
 *
 * Kept small and explicit rather than fuzzy-matched: `prod` and `production`
 * reaching `stable` is a kindness, but guessing at a typo is how a user who
 * wrote `canry` ends up on stable wondering why nothing turned on.
 */
const ALIASES: Readonly<Record<string, RolloutChannel>> = {
  prod: RolloutChannel.Stable,
  production: RolloutChannel.Stable,
  release: RolloutChannel.Stable,
  preview: RolloutChannel.Beta,
  nightly: RolloutChannel.Canary,
  development: RolloutChannel.Dev,
};

export class RolloutConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RolloutConfigurationError';
  }
}

/** Normalises a name the way both channels and feature names are normalised. */
export function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '_');
}

export function channelOrder(channel: RolloutChannel): number {
  return ORDER[channel];
}

/** True when a copy on `have` is wide enough to include something needing `need`. */
export function channelAllows(
  have: RolloutChannel,
  need: RolloutChannel
): boolean {
  return ORDER[have] >= ORDER[need];
}

export function allChannels(): readonly RolloutChannel[] {
  return [
    RolloutChannel.Stable,
    RolloutChannel.Beta,
    RolloutChannel.Canary,
    RolloutChannel.Dev,
  ];
}

/**
 * Reads a channel name.
 *
 * An unreadable name falls back to `stable` rather than throwing, because the
 * thing asking is usually a hook with one job and no way to report a
 * configuration error -- and falling back to the NARROWEST channel is the only
 * safe direction to guess in. `strict` is for the inspector and the tests, which
 * both exist to tell a user their configuration is wrong.
 *
 * The refusal is returned rather than logged. A warning on stderr from inside a
 * hook is either invisible or corrupts a protocol stream, so the caller decides
 * where it goes.
 */
export function parseChannel(
  value: string | undefined,
  options: { readonly strict?: boolean } = {}
): { readonly channel: RolloutChannel; readonly refused: string | null } {
  if (value === undefined || value.trim().length === 0) {
    return { channel: RolloutChannel.Stable, refused: null };
  }
  const wanted = normalise(value);
  const alias = ALIASES[wanted];
  if (alias !== undefined) return { channel: alias, refused: null };
  for (const channel of allChannels()) {
    if (channel === wanted) return { channel, refused: null };
  }
  const known = allChannels().join(', ');
  const refused = `unknown rollout channel "${value.trim()}"; known channels: ${known}`;
  if (options.strict) throw new RolloutConfigurationError(refused);
  return { channel: RolloutChannel.Stable, refused };
}