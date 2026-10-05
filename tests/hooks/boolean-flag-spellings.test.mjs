import { flagOn, flagOff } from '../../hooks-core/flags.mjs';

/**
 * Both readings are checked against an injected environment rather than
 * process.env, so nothing here depends on -- or disturbs -- the real one.
 */
describe('boolean environment flags', () => {
  it('accepts every affirmative spelling, however it is written', () => {
    for (const raw of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', ' true ', '\ttrue\n']) {
      expect(flagOn('F', { F: raw })).toBe(true);
    }
  });

  it('accepts every negative spelling, however it is written', () => {
    for (const raw of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF', ' off ']) {
      expect(flagOff('F', { F: raw })).toBe(true);
    }
  });

  it('reads an unset variable as no decision, not as either answer', () => {
    // Both must be false, because this is what makes a default survive: a switch
    // that is off by default stays off, and one that is on by default stays on.
    expect(flagOn('F', {})).toBe(false);
    expect(flagOff('F', {})).toBe(false);
    expect(flagOn('F', { F: '' })).toBe(false);
    expect(flagOff('F', { F: '   ' })).toBe(false);
  });

  it('does not let a typo turn a feature on or off', () => {
    // `flagOff` is deliberately NOT `!flagOn`. If it were, `HARVEST=ture` would
    // read as an opt-out and silently disable a feature the user meant to keep.
    for (const raw of ['ture', 'y', 'n', 'enabled', 'disable', '2', '-1', 'null']) {
      expect(flagOn('F', { F: raw })).toBe(false);
      expect(flagOff('F', { F: raw })).toBe(false);
    }
  });

  it('answers only for the variable it was asked about', () => {
    expect(flagOn('WANTED', { OTHER: '1' })).toBe(false);
    expect(flagOn('WANTED', { OTHER: '1', WANTED: '1' })).toBe(true);
  });

  it('falls back to process.env when no environment is passed', () => {
    const name = 'TOKEN_OPTIMIZER_FLAGS_SPEC';
    const before = process.env[name];
    try {
      process.env[name] = 'yes';
      expect(flagOn(name)).toBe(true);
      process.env[name] = 'off';
      expect(flagOn(name)).toBe(false);
      expect(flagOff(name)).toBe(true);
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  });
});

describe('the switches that were reading one spelling only', () => {
  /** Runs `read` with `name` set to `raw`, then puts the environment back. */
  const withEnv = async (name, raw, read) => {
    const before = process.env[name];
    try {
      process.env[name] = raw;
      return await read();
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  };

  it('turns the full harvest delta on for 1 as well as for true', async () => {
    // This one compared against 'true' alone, so TOKEN_OPTIMIZER_HARVEST_FULL=1
    // sent the digest instead of the delta and said nothing about it.
    const { buildDigest } = await import('../../hooks-core/harvest.mjs');
    expect(typeof buildDigest).toBe('function');
    for (const raw of ['1', 'true', 'yes', 'on']) {
      expect(await withEnv('TOKEN_OPTIMIZER_HARVEST_FULL', raw, () => flagOn('TOKEN_OPTIMIZER_HARVEST_FULL'))).toBe(
        true
      );
    }
  });

  it('opts a project out of the shared tier for true as well as for 1', async () => {
    // And this one compared against '1' alone, in the other direction.
    const { quarantineSharedSource } = await import('../../hooks-core/harvest-write.mjs');
    const ephemeral = `${process.env.TEMP || '/tmp'}/appdata/local/temp/a-study/project`.replace(/\\/g, '/');
    const quarantined = await withEnv('TOKEN_OPTIMIZER_ALLOW_EPHEMERAL_SHARED', '', () =>
      quarantineSharedSource(ephemeral)
    );
    expect(quarantined).toBe(true);
    for (const raw of ['1', 'true', 'YES', 'on']) {
      expect(await withEnv('TOKEN_OPTIMIZER_ALLOW_EPHEMERAL_SHARED', raw, () => quarantineSharedSource(ephemeral))).toBe(
        false
      );
    }
  });

  it('disables the wiki for on as well as for 1, true and yes', async () => {
    const { wikiDisabled } = await import('../../hooks-core/wiki.mjs');
    for (const raw of ['1', 'true', 'yes', 'on']) {
      expect(await withEnv('TOKEN_OPTIMIZER_WIKI_DISABLED', raw, () => wikiDisabled())).toBe(true);
    }
    for (const raw of ['', '0', 'ture']) {
      expect(await withEnv('TOKEN_OPTIMIZER_WIKI_DISABLED', raw, () => wikiDisabled())).toBe(false);
    }
  });
});