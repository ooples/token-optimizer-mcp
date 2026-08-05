/**
 * What is allowed to spend money and send data, and what is not.
 *
 * The harvest used to enable itself whenever an API key was visible:
 *
 *   harvestEnabled = Boolean(apiKey()) && MODE !== 'off'
 *
 * ANTHROPIC_API_KEY is set in most development environments already, so that
 * rule would have started billing a third-party call, carrying a digest of the
 * user's prompts and commands off the machine, without anyone choosing it. An
 * ambient credential is not consent.
 *
 * The rule now separates the two things that actually differ -- cost and
 * disclosure -- rather than treating "a key exists" as permission:
 *
 *   local endpoint  -> free and private, so on by default
 *   anything else   -> deliberate opt-in AND a key
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { pathToFileURL } from 'url';
import { join } from 'path';

const HARVEST = pathToFileURL(
  join(process.cwd(), 'plugin', 'hooks', 'lib', 'harvest.mjs')
).href;

/** Imported fresh each time: the module reads env per call, but be explicit. */
async function harvest() {
  return import(`${HARVEST}?t=${Date.now()}${Math.random()}`);
}

const VARS = [
  'ANTHROPIC_API_KEY',
  'TOKEN_OPTIMIZER_API_KEY',
  'TOKEN_OPTIMIZER_HARVEST',
  'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
  'TOKEN_OPTIMIZER_MODE',
];

describe('harvest enablement', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('does NOT bill just because an API key happens to be in the environment', async () => {
    // The regression this whole rule exists for.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-consent';
    const { harvestMode, harvestEnabled } = await harvest();
    expect(harvestMode()).toBe('off:not-opted-in');
    expect(harvestEnabled()).toBe(false);
  });

  it('runs against a paid endpoint only with an explicit opt-in AND a key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    process.env.TOKEN_OPTIMIZER_HARVEST = '1';
    const { harvestMode, harvestEnabled } = await harvest();
    expect(harvestMode()).toBe('remote');
    expect(harvestEnabled()).toBe(true);
  });

  it('says which of the two is missing', async () => {
    process.env.TOKEN_OPTIMIZER_HARVEST = '1';
    const { harvestMode } = await harvest();
    // Opted in, no credential -- a different problem from not opting in, and
    // the user can only act on it if the two are distinguishable.
    expect(harvestMode()).toBe('off:no-key');
  });

  it('runs against a LOCAL endpoint with no key and no opt-in', async () => {
    // Nothing is spent and nothing leaves the machine, so there is nothing to
    // consent to.
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT =
      'http://localhost:11434/v1/messages';
    const { harvestMode, harvestEnabled, localEndpoint } = await harvest();
    expect(localEndpoint()).toBeTruthy();
    expect(harvestMode()).toBe('local');
    expect(harvestEnabled()).toBe(true);
  });

  it('treats a REMOTE endpoint as remote even with a key present', async () => {
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT =
      'https://api.anthropic.com/v1/messages';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    const { harvestMode, localEndpoint } = await harvest();
    expect(localEndpoint()).toBeNull();
    expect(harvestMode()).toBe('off:not-opted-in');
  });

  it('does not mistake a hostname that merely contains "localhost" for local', async () => {
    // localhost.attacker.example resolves wherever its owner wants it to.
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT =
      'https://localhost.attacker.example/v1/messages';
    const { localEndpoint } = await harvest();
    expect(localEndpoint()).toBeNull();
  });

  it('stays off entirely when the optimizer is off', async () => {
    process.env.TOKEN_OPTIMIZER_MODE = 'off';
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT =
      'http://localhost:11434/v1/messages';
    const { harvestMode, harvestEnabled } = await harvest();
    expect(harvestMode()).toBe('off:mode');
    expect(harvestEnabled()).toBe(false);
  });

  it('extract() is a no-op rather than an unauthenticated request when disabled', async () => {
    // ASSERT ON THE TRANSPORT, not just the return value. `resolves.toEqual([])`
    // passes either way: extract() returns [] when it declines to run AND when
    // it fires a request that fails or comes back empty. Those are opposite
    // outcomes -- one spends nothing and discloses nothing, the other bills a
    // call and ships a digest of the user's prompts off the machine -- and the
    // whole point of this module is the difference between them. Counting fetch
    // calls is what actually distinguishes the two.
    const realFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error('no request should have been made'));
    };

    try {
      const { extract, harvestEnabled } = await harvest();
      // The precondition, stated so a failure here is not misread as a
      // transport bug: with the env cleared by beforeEach, harvesting is off.
      expect(harvestEnabled()).toBe(false);

      await expect(extract('some digest')).resolves.toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('does make a request once a local endpoint enables it', async () => {
    // The negative test above is only meaningful next to a positive one: if
    // extract() never called fetch under ANY configuration, zero calls would
    // prove nothing about the gate.
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT =
      'http://127.0.0.1:11434/v1/messages';

    const realFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error('transport stubbed'));
    };

    try {
      const { extract, harvestEnabled } = await harvest();
      expect(harvestEnabled()).toBe(true);

      // A rejected transport still yields [] -- the module swallows transport
      // failure by design -- which is exactly why the count is the assertion.
      await expect(extract('some digest')).resolves.toEqual([]);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
