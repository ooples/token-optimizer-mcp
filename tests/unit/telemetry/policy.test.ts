/**
 * These tests are almost entirely about what telemetry REFUSES to do.
 *
 * The package publishes a telemetry badge, so the default is a promise rather
 * than a preference. A regression here is not a bug in a counter — it is the
 * product transmitting something a user did not agree to, which is the one
 * failure that cannot be walked back after a release.
 */
import { describe, it, expect } from '@jest/globals';
import {
  localTelemetryEnabled,
  beaconEnabled,
  doNotTrack,
  describePolicy,
  LOCAL_DEFAULT_ON,
  BEACON_DEFAULT_ON,
} from '../../../src/telemetry/policy.js';
import { buildEvent, sanitiseProperties, machineIdHash } from '../../../src/telemetry/event.js';
import { hostname } from 'node:os';

describe('both defaults are off, and the constants say so', () => {
  it('states the policy in one auditable place', () => {
    // If either of these flips, the badge in the readme is wrong. That is the
    // whole point of asserting a constant.
    expect(LOCAL_DEFAULT_ON).toBe(false);
    expect(BEACON_DEFAULT_ON).toBe(false);
  });

  it('sends nothing on a machine with no configuration', () => {
    expect(localTelemetryEnabled({})).toBe(false);
    expect(beaconEnabled({})).toBe(false);
  });
});

describe('an unrecognised value fails closed', () => {
  it.each(['maybe', 'sure', 'later', ' ', 'ON?'])('treats %p as off', (value) => {
    expect(localTelemetryEnabled({ TOKEN_OPTIMIZER_TELEMETRY: value })).toBe(false);
    expect(beaconEnabled({ TOKEN_OPTIMIZER_BEACON: value })).toBe(false);
  });

  it('accepts the documented on-values', () => {
    for (const value of ['1', 'on', 'true', 'yes', 'enable', 'enabled'])
      expect(localTelemetryEnabled({ TOKEN_OPTIMIZER_TELEMETRY: value })).toBe(true);
  });
});

describe('local stats never imply upload', () => {
  it('permits local aggregation without permitting transmission', () => {
    const env = { TOKEN_OPTIMIZER_TELEMETRY: '1' };
    expect(localTelemetryEnabled(env)).toBe(true);
    // THE UPGRADE TRAP: someone who turned on local stats answered a different
    // question and must not start transmitting because a version changed.
    expect(beaconEnabled(env)).toBe(false);
    expect(describePolicy(env)).toContain('local only');
  });

  it('requires both to be set before anything uploads', () => {
    expect(beaconEnabled({ TOKEN_OPTIMIZER_BEACON: '1' })).toBe(false);
    expect(
      beaconEnabled({ TOKEN_OPTIMIZER_BEACON: '1', TOKEN_OPTIMIZER_TELEMETRY: '1' })
    ).toBe(true);
  });
});

describe('do-not-track wins over an explicit yes', () => {
  it('suppresses both switches', () => {
    const env = {
      DO_NOT_TRACK: '1',
      TOKEN_OPTIMIZER_TELEMETRY: '1',
      TOKEN_OPTIMIZER_BEACON: '1',
    };
    expect(doNotTrack(env)).toBe(true);
    expect(localTelemetryEnabled(env)).toBe(false);
    expect(beaconEnabled(env)).toBe(false);
    expect(describePolicy(env)).toContain('DO_NOT_TRACK');
  });

  it('treats any non-off value as a preference, since the convention is a flag', () => {
    expect(doNotTrack({ DO_NOT_TRACK: 'yes' })).toBe(true);
    expect(doNotTrack({ DO_NOT_TRACK: 'whatever' })).toBe(true);
  });

  it('reads an explicit zero as no preference rather than as a request', () => {
    expect(doNotTrack({ DO_NOT_TRACK: '0' })).toBe(false);
    expect(doNotTrack({ DO_NOT_TRACK: 'false' })).toBe(false);
  });
});

describe('the payload cannot carry content', () => {
  it('drops every string, which is what prompts and paths are', () => {
    const out = sanitiseProperties({
      prompt: 'summarise this file',
      path: '/home/me/secret/project/src/auth.ts',
      command: 'git push --force',
      error: 'Error: ENOENT no such file',
      removedBytes: 4096,
      anchored: true,
    });
    expect(out).toEqual({ removedBytes: 4096, anchored: true });
  });

  it('drops objects and arrays, so nesting cannot smuggle a string', () => {
    const out = sanitiseProperties({
      nested: { path: '/etc/passwd' },
      list: ['a', 'b'],
      kept: 1,
    });
    expect(out).toEqual({ kept: 1 });
  });

  it('drops non-finite numbers rather than transmitting a broken ratio', () => {
    expect(sanitiseProperties({ ratio: NaN, inf: Infinity, real: 0.42 })).toEqual({ real: 0.42 });
  });

  it('builds an event whose properties survived the same filter', () => {
    const event = buildEvent('compression', '7.2.0', { savedTokens: 812, path: '/tmp/x' });
    expect(event.properties).toEqual({ savedTokens: 812 });
    expect(event.event_type).toBe('compression');
    expect(event.library_version).toBe('7.2.0');
    expect(Number.isNaN(Date.parse(event.timestamp_utc))).toBe(false);
  });
});

describe('the machine identifier is stable and not reversible', () => {
  it('is the same across calls on one machine', () => {
    expect(machineIdHash()).toBe(machineIdHash());
  });

  it('is a fixed-width hex digest rather than anything readable', () => {
    const id = machineIdHash();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // A hostname is frequently a person's or an employer's name, so the raw
    // value must not be recoverable from what is sent.
    expect(id).not.toContain(hostname());
  });
});
