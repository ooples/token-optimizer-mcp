/**
 * What the doctor prints.
 *
 * The block is the only way a user learns any of this, so the wording is held to
 * the same standard as the behaviour: it may not offer a remedy that would not
 * work, and it may not stay silent about an input that was thrown away.
 */
import { describe, it, expect } from '@jest/globals';
import {
  describeEveryFeature,
  describeRollout,
  rolloutSection,
} from '../../../src/rollout/describe.js';
import {
  CHANNEL_ENV,
  DISABLE_ENV,
  FeatureName,
  REQUEST_ENV,
  resolveRollout,
} from '../../../src/rollout/resolve.js';
import { allFeatures } from '../../../src/rollout/features.js';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...extra }) as NodeJS.ProcessEnv;
const text = (extra: Record<string, string> = {}): string =>
  describeRollout(resolveRollout(env(extra))).join('\n');

describe('the rollout block', () => {
  it('leads with the channel and lists what is on', () => {
    const lines = describeRollout(resolveRollout(env()));
    expect(lines[0]).toBe('channel: stable');
    expect(lines.join('\n')).toContain('defer_tools: on by default from stable');
  });

  it('names a wider channel only when that channel would change something', () => {
    // dev carries nothing of its own. Offering it as the way to get the rest would
    // send a user to a channel where they would find exactly what they have now.
    expect(text()).toContain('beta, canary carry more');
    expect(text()).not.toContain('dev carry');
    expect(text({ [CHANNEL_ENV]: 'canary' })).not.toMatch(/carr(y|ies) more/);
  });

  it('counts the request-only features apart from the staged ones', () => {
    const askable = allFeatures().filter((s) => s.defaultEnabledIn === null).length;
    expect(text({ [CHANNEL_ENV]: 'dev' })).toContain(
      `${askable} are request-only, on no channel`
    );
  });

  it('says what it ignored, because ignoring it silently is the whole problem', () => {
    const broken = text({
      [CHANNEL_ENV]: 'canry',
      [REQUEST_ENV]: 'substitue',
      TOKEN_OPTIMIZER_PROXY_SUBSTITUTE: 'maybe',
    });
    expect(broken).toContain('IGNORED: unknown rollout channel "canry"');
    expect(broken).toContain('IGNORED: unknown feature "substitue"');
    expect(broken).toContain('IGNORED: TOKEN_OPTIMIZER_PROXY_SUBSTITUTE="maybe"');
  });

  it('calls out a feature that was asked for and is not running', () => {
    const blocked = text({ [REQUEST_ENV]: 'substitution' });
    expect(blocked).toContain('substitution: asked for, but it needs the canary channel');
  });

  it('offers only the switch for a request-only feature, not a channel', () => {
    const every = describeEveryFeature(resolveRollout(env())).join('\n');
    expect(every).toContain(
      'off substitution -- off; set TOKEN_OPTIMIZER_PROXY_SUBSTITUTE=1 -- no channel turns this one on for you'
    );
    expect(every).toContain(
      'off auto_repair -- off; switch to the beta channel, or set TOKEN_OPTIMIZER_AUTO_REPAIR=1'
    );
  });

  it('reads no environment of its own, so a test cannot leak into it', () => {
    const section = rolloutSection(env({ [DISABLE_ENV]: 'defer_tools' }));
    expect(section.join('\n')).toContain('defer_tools');
    expect(section.join('\n')).toContain('switched off');
    expect(section[0]).toBe('');
    expect(section[1]).toBe('Rollout');
  });

  it('says so plainly when nothing at all is on', () => {
    const names = allFeatures().map((s) => s.name).join(',');
    const all = text({ [DISABLE_ENV]: names });
    expect(all).toContain('nothing enabled: this copy is running its shipped behaviour');
    // A silent block here would read as "the rollout system is not installed" when
    // what happened is that every feature was switched off on purpose.
    expect(all).toContain(`switched off by ${DISABLE_ENV}`);
  });

  it('names WHICH switch turned a feature off', () => {
    // The two live in different places, and "switched off" alone sends a user
    // looking through the wrong one.
    expect(text({ TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS: '0' })).toContain(
      'defer_tools: switched off by TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS'
    );
    expect(text({ [DISABLE_ENV]: 'defer_tools' })).toContain(
      `defer_tools: switched off by ${DISABLE_ENV}`
    );
  });

  it('counts only the features nobody mentioned', () => {
    // A feature named in a variable is printed, so it must not also be counted in
    // the "others" tally -- a number that double-counts is a number nobody trusts.
    const snapshot = resolveRollout(env({ [DISABLE_ENV]: 'defer_tools' }));
    const listed = describeRollout(snapshot);
    const tally = listed.find((line) => line.includes('other feature'));
    // Everything the block did not spell out by name: not the ones it listed as on,
    // and not the one it just told the user it had switched off.
    const spelledOut = snapshot.enabled.length + 1;
    expect(tally).toContain(
      `${allFeatures().length - spelledOut} other features off`
    );
  });
});