/**
 * The rollout inspector.
 *
 * A flag system whose state can only be learned by reading the source is a flag
 * system nobody can debug. These lines answer the three questions a user actually
 * has -- which channel am I on, what is on right now, and WHY is this one on -- and
 * one more that matters most when something is wrong: what did you ignore?
 *
 * A refused input is printed even though it changed nothing, because changing
 * nothing is the whole problem. A user who set TOKEN_OPTIMIZER_FEATURES=substitue
 * has a typo, an experiment that is not running, and no other way to find out.
 */

import { RolloutChannel, allChannels, channelAllows } from './channel.js';
import { FEATURES } from './features.js';
import {
  CHANNEL_ENV,
  DecisionReason,
  FeatureDecision,
  RolloutSnapshot,
  resolveRollout,
} from './resolve.js';

/** Why this one is the way it is, in words, naming the switch that decided. */
export function explainDecision(decision: FeatureDecision): string {
  switch (decision.reason) {
    case DecisionReason.Default:
      return `on by default from ${decision.defaultEnabledIn ?? 'stable'}`;
    case DecisionReason.Explicit:
      return `on because ${decision.env} says so`;
    case DecisionReason.Requested:
      return `on because it was named in the feature list`;
    case DecisionReason.BlockedByChannel:
      return `asked for, but it needs the ${decision.availableIn} channel`;
    case DecisionReason.Disabled:
      return decision.by === null
        ? 'switched off'
        : `switched off by ${decision.by}`;
    case DecisionReason.NotRequested:
      // TWO DIFFERENT ANSWERS, AND OFFERING THE WRONG ONE IS A LIE THE USER CAN ACT
      // ON. A request-only feature is not waiting on a wider channel: switching to
      // one would leave it exactly as off as it is now, so only its own switch is
      // named. The staged ones name the channel that carries them, because there
      // switching really is the thing that turns it on.
      return decision.defaultEnabledIn === null
        ? `off; set ${decision.env}=1 -- no channel turns this one on for you`
        : `off; switch to the ${decision.defaultEnabledIn} channel, or set ${decision.env}=1`;
  }
}

/**
 * The block the doctor prints.
 *
 * Only the enabled features are listed in full. A user on stable has nine things
 * off for the same uninteresting reason, and printing all eleven every time buries
 * the two that are on -- so the rest are counted, and the reader can widen the
 * question if they want them.
 */
export function describeRollout(snapshot: RolloutSnapshot): string[] {
  const lines = [`channel: ${snapshot.channel}`];
  const on = snapshot.decisions.filter((d) => d.enabled);
  const off = snapshot.decisions.filter((d) => !d.enabled);
  if (on.length === 0) {
    lines.push('nothing enabled: this copy is running its shipped behaviour');
  } else {
    for (const decision of on) {
      lines.push(`${decision.name}: ${explainDecision(decision)}`);
    }
  }
  // THE CASE WORTH SAYING LOUDLY. Asked for and not running is the only state a
  // user can be actively wrong about, so it is named even though it is off.
  // A user reaches either of these states only by typing something, so both lists
  // are short and both are worth the line. Off-because-nobody-asked is the state
  // that gets counted instead; off-because-I-asked-and-it-did-not-happen and
  // off-because-I-turned-it-off are the two a user can be wrong about.
  const named = off.filter(
    (d) =>
      d.reason === DecisionReason.BlockedByChannel ||
      d.reason === DecisionReason.Disabled
  );
  for (const decision of named) {
    lines.push(`${decision.name}: ${explainDecision(decision)}`);
  }
  const quiet = off.filter((d) => !named.includes(d));
  if (quiet.length > 0) {
    // NAME ONLY A CHANNEL THAT WOULD ACTUALLY CHANGE SOMETHING. A wider channel
    // that stages nothing is not an answer to "how do I get the rest", and the
    // request-only ones are counted apart because no channel is their answer at all.
    const staging = allChannels().filter(
      (channel) =>
        !channelAllows(snapshot.channel, channel) &&
        quiet.some((d) => d.defaultEnabledIn === channel)
    );
    const others =
      quiet.length === 1 ? '1 other feature off' : `${quiet.length} other features off`;
    const askable = quiet.filter((d) => d.defaultEnabledIn === null).length;
    const parts = [others];
    if (staging.length > 0) {
      parts.push(
        `${staging.join(', ')} ${staging.length === 1 ? 'carries' : 'carry'} more`
      );
    }
    if (askable > 0) {
      parts.push(
        askable === 1
          ? '1 is request-only, on no channel'
          : `${askable} are request-only, on no channel`
      );
    }
    lines.push(parts.join('; '));
  }
  for (const refusal of snapshot.refusals) {
    lines.push(`IGNORED: ${refusal}`);
  }
  return lines;
}

/** Every feature and its state, for the case where the summary is not enough. */
export function describeEveryFeature(snapshot: RolloutSnapshot): string[] {
  return snapshot.decisions.map(
    (decision) =>
      `${decision.enabled ? 'on ' : 'off'} ${decision.name} -- ${explainDecision(decision)}` +
      ` (${FEATURES[decision.name].description})`
  );
}

/** The doctor's section, headed and indented like the others. */
export function rolloutSection(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly verbose?: boolean } = {}
): string[] {
  const snapshot = resolveRollout(env);
  const body = options.verbose
    ? describeEveryFeature(snapshot)
    : describeRollout(snapshot);
  return ['', 'Rollout', ...body.map((line) => `  ${line}`)];
}

/** Named so a caller can print the variable rather than hard-coding it twice. */
export function channelVariable(): string {
  return CHANNEL_ENV;
}

export function widestChannel(): RolloutChannel {
  return RolloutChannel.Dev;
}