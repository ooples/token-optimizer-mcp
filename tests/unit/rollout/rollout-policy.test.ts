/**
 * The rollout policy.
 *
 * The properties asserted here are the ones a flag system is worth having for:
 * a kill switch that cannot be outvoted, a variable a user already set that keeps
 * working, a channel that gates the NEW interface and not the old one, and an
 * unknown name that turns nothing on. Every one of those is a way this could have
 * silently changed behaviour for someone who upgraded.
 */
import { describe, it, expect } from '@jest/globals';
import {
  RolloutChannel,
  RolloutConfigurationError,
  channelAllows,
  parseChannel,
} from '../../../src/rollout/channel.js';
import {
  CHANNEL_ENV,
  DISABLE_ENV,
  REQUEST_ENV,
  DecisionReason,
  FeatureName,
  featureEnabled,
  resolveRollout,
} from '../../../src/rollout/resolve.js';
import {
  FEATURES,
  allFeatures,
  registryDigest,
} from '../../../src/rollout/features.js';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...extra }) as NodeJS.ProcessEnv;

describe('channels', () => {
  it('orders from stable outwards, each carrying the narrower ones', () => {
    expect(channelAllows(RolloutChannel.Dev, RolloutChannel.Beta)).toBe(true);
    expect(channelAllows(RolloutChannel.Canary, RolloutChannel.Beta)).toBe(true);
    expect(channelAllows(RolloutChannel.Beta, RolloutChannel.Canary)).toBe(false);
    expect(channelAllows(RolloutChannel.Stable, RolloutChannel.Stable)).toBe(true);
  });

  it('reads the names people type', () => {
    expect(parseChannel('PRODUCTION').channel).toBe(RolloutChannel.Stable);
    expect(parseChannel(' Nightly ').channel).toBe(RolloutChannel.Canary);
    expect(parseChannel('development').channel).toBe(RolloutChannel.Dev);
  });

  it('falls back to the narrowest channel on a name it cannot read', () => {
    const parsed = parseChannel('canry');
    expect(parsed.channel).toBe(RolloutChannel.Stable);
    expect(parsed.refused).toContain('unknown rollout channel');
  });

  it('throws in strict mode instead, for the inspector', () => {
    expect(() => parseChannel('canry', { strict: true })).toThrow(
      RolloutConfigurationError
    );
  });

  it('treats an absent channel as stable, not as unset', () => {
    expect(parseChannel(undefined).refused).toBeNull();
    expect(parseChannel('   ').channel).toBe(RolloutChannel.Stable);
  });
});

describe('the registry', () => {
  it('gives every feature a switch of its own', () => {
    for (const spec of allFeatures()) {
      expect(spec.env.startsWith('TOKEN_OPTIMIZER_')).toBe(true);
    }
  });

  it('never defaults a feature on in a channel that cannot run it', () => {
    // A registry entry saying "available in canary, default-on in beta" would
    // enable something on a channel that is not allowed to have it. The resolver
    // would then contradict itself, so the invariant is asserted on the data.
    for (const spec of allFeatures()) {
      if (spec.defaultEnabledIn === null) continue;
      expect(channelAllows(spec.defaultEnabledIn, spec.availableIn)).toBe(true);
    }
  });

  it('digests the fields that change a decision and not the prose', () => {
    const before = registryDigest();
    expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(registryDigest()).toBe(before);
  });
});

describe('resolving', () => {
  it('runs the shipped defaults on stable', () => {
    const snapshot = resolveRollout(env());
    expect(snapshot.channel).toBe(RolloutChannel.Stable);
    expect(snapshot.isEnabled(FeatureName.DeferTools)).toBe(true);
    expect(snapshot.decisionFor(FeatureName.DeferTools).reason).toBe(
      DecisionReason.Default
    );
    expect(snapshot.isEnabled(FeatureName.Substitution)).toBe(false);
  });

  it('honours a variable the user already had set, whatever the channel', () => {
    // THE REGRESSION THIS RULES OUT. Substitution needs canary, and someone has
    // TOKEN_OPTIMIZER_PROXY_SUBSTITUTE=1 in their settings today. A channel that
    // vetoed it would turn "we added rollout channels" into "your flag stopped
    // working" with the flag still sitting in the file.
    const snapshot = resolveRollout(
      env({ TOKEN_OPTIMIZER_PROXY_SUBSTITUTE: '1' })
    );
    expect(snapshot.channel).toBe(RolloutChannel.Stable);
    expect(snapshot.isEnabled(FeatureName.Substitution)).toBe(true);
    expect(snapshot.decisionFor(FeatureName.Substitution).reason).toBe(
      DecisionReason.Explicit
    );
  });

  it('gates the new feature list by channel, since nobody has it set yet', () => {
    const narrow = resolveRollout(env({ [REQUEST_ENV]: 'substitution' }));
    expect(narrow.isEnabled(FeatureName.Substitution)).toBe(false);
    expect(narrow.decisionFor(FeatureName.Substitution).reason).toBe(
      DecisionReason.BlockedByChannel
    );
    const wide = resolveRollout(
      env({ [CHANNEL_ENV]: 'canary', [REQUEST_ENV]: 'substitution' })
    );
    expect(wide.isEnabled(FeatureName.Substitution)).toBe(true);
    expect(wide.decisionFor(FeatureName.Substitution).reason).toBe(
      DecisionReason.Requested
    );
  });

  it('turns on what its channel stages, without naming a single feature', () => {
    // Otherwise the channel is decoration: TOKEN_OPTIMIZER_FEATURES alone would do
    // everything it does, and picking beta would change nothing at all.
    const beta = resolveRollout(env({ [CHANNEL_ENV]: 'beta' }));
    expect(beta.isEnabled(FeatureName.AutoRepair)).toBe(true);
    expect(beta.decisionFor(FeatureName.AutoRepair).reason).toBe(
      DecisionReason.Default
    );
    expect(beta.isEnabled(FeatureName.ToolCodeMode)).toBe(false);
    const canary = resolveRollout(env({ [CHANNEL_ENV]: 'canary' }));
    expect(canary.isEnabled(FeatureName.AutoRepair)).toBe(true);
    expect(canary.isEnabled(FeatureName.ToolCodeMode)).toBe(true);
  });

  it('never turns on a request-only feature, however wide the channel', () => {
    // These change what the model writes or force an answer the code works out on
    // its own. A user who opted into a risk tier did not ask for either, so dev --
    // the widest channel there is -- still only makes them askable.
    const dev = resolveRollout(env({ [CHANNEL_ENV]: 'dev' }));
    for (const spec of allFeatures()) {
      if (spec.defaultEnabledIn !== null) continue;
      expect(dev.isEnabled(spec.name)).toBe(false);
      expect(dev.decisionFor(spec.name).reason).toBe(DecisionReason.NotRequested);
    }
    expect(
      allFeatures().filter((spec) => spec.defaultEnabledIn === null).length
    ).toBeGreaterThan(0);
  });
  it('lets the switch off win over every way of turning it on', () => {
    const both = resolveRollout(
      env({
        [CHANNEL_ENV]: 'dev',
        [REQUEST_ENV]: 'substitution',
        [DISABLE_ENV]: 'substitution',
        TOKEN_OPTIMIZER_PROXY_SUBSTITUTE: '1',
      })
    );
    expect(both.isEnabled(FeatureName.Substitution)).toBe(false);
    expect(both.decisionFor(FeatureName.Substitution).reason).toBe(
      DecisionReason.Disabled
    );
  });

  it('lets a feature be switched off even when it is a shipped default', () => {
    const off = resolveRollout(
      env({ TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS: 'off' })
    );
    expect(off.isEnabled(FeatureName.DeferTools)).toBe(false);
    expect(off.decisionFor(FeatureName.DeferTools).reason).toBe(
      DecisionReason.Disabled
    );
  });

  it('turns nothing on for a name it does not know', () => {
    const snapshot = resolveRollout(
      env({ [CHANNEL_ENV]: 'dev', [REQUEST_ENV]: 'substitue' })
    );
    expect(snapshot.enabled).not.toContain(FeatureName.Substitution);
    expect(snapshot.refusals.join('\n')).toContain('unknown feature "substitue"');
  });

  it('accepts a hyphen where the name has an underscore', () => {
    const snapshot = resolveRollout(
      env({ [CHANNEL_ENV]: 'canary', [REQUEST_ENV]: 'DROP-THINKING' })
    );
    expect(snapshot.isEnabled(FeatureName.DropThinking)).toBe(true);
    expect(snapshot.refusals).toHaveLength(0);
  });

  it('reports a value it cannot read rather than treating it as on', () => {
    const snapshot = resolveRollout(
      env({ TOKEN_OPTIMIZER_PROXY_SUBSTITUTE: 'maybe' })
    );
    expect(snapshot.isEnabled(FeatureName.Substitution)).toBe(false);
    expect(snapshot.refusals.join('\n')).toContain(
      'TOKEN_OPTIMIZER_PROXY_SUBSTITUTE="maybe"'
    );
  });

  it('accepts a mode word as on where the feature declares one', () => {
    // `all` both enables dropping and says how far. The resolver has to call that
    // on, or the inspector would report ignored while the proxy honoured it.
    const snapshot = resolveRollout(
      env({ TOKEN_OPTIMIZER_PROXY_DROP_THINKING: 'all' })
    );
    expect(snapshot.isEnabled(FeatureName.DropThinking)).toBe(true);
    expect(snapshot.refusals).toHaveLength(0);
    expect(FEATURES[FeatureName.DropThinking].extraOnValues).toContain('all');
  });

  it('is frozen, so one request cannot change its mind halfway', () => {
    const snapshot = resolveRollout(env());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.decisions)).toBe(true);
    expect(Object.isFrozen(snapshot.decisions[0])).toBe(true);
  });

  it('digests identical state identically and different state differently', () => {
    const a = resolveRollout(env({ [CHANNEL_ENV]: 'beta' }));
    const b = resolveRollout(env({ [CHANNEL_ENV]: 'preview' }));
    expect(a.digest()).toBe(b.digest());
    const c = resolveRollout(env({ [CHANNEL_ENV]: 'canary' }));
    expect(c.digest()).not.toBe(a.digest());
  });

  it('throws on anything unusable in strict mode', () => {
    expect(() =>
      resolveRollout(env({ [REQUEST_ENV]: 'nope' }), { strict: true })
    ).toThrow(RolloutConfigurationError);
    expect(() =>
      resolveRollout(env({ TOKEN_OPTIMIZER_PROXY_SUBSTITUTE: 'maybe' }), {
        strict: true,
      })
    ).toThrow(RolloutConfigurationError);
  });

  it('answers a single flag without a snapshot', () => {
    expect(featureEnabled(FeatureName.DeferTools, env())).toBe(true);
    expect(featureEnabled(FeatureName.OutputShaper, env())).toBe(false);
  });
});