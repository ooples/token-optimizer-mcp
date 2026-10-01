/**
 * The rollout inspector.
 *
 * WHAT IT IS FOR. `resolveRollout` has taken `requested`, `disabled` and
 * `strict` since it was written and no shipped caller passed any of them, so
 * the conditional question -- "what would I get on canary with these two
 * features?" -- could only be asked by exporting variables into a shell. These
 * tests drive that question through the flags.
 *
 * THE --strict EXIT IS THE LOAD-BEARING ONE. Ignoring a misspelled feature
 * name is deliberate in a hook and wrong in CI, so the one mode that fails on
 * a refusal is pinned in both directions: lenient reports and succeeds, strict
 * reports and fails.
 */
import { describe, it, expect } from '@jest/globals';
import {
  main,
  parseArguments,
  snapshotJson,
} from '../../../src/rollout/cli.js';
import {
  CHANNEL_ENV,
  DISABLE_ENV,
  REQUEST_ENV,
  ROLLOUT_SCHEMA_VERSION,
  FeatureName,
  resolveRollout,
} from '../../../src/rollout/resolve.js';
import { RolloutChannel } from '../../../src/rollout/channel.js';

/** A run with nothing inherited from the box this is running on. */
function run(args: readonly string[], extra: Record<string, string> = {}) {
  const written: string[] = [];
  return {
    code: main(args, {
      env: { ...extra } as NodeJS.ProcessEnv,
      write: (text: string) => void written.push(text),
    }),
    text: () => written.join(''),
  };
}

describe('parseArguments', () => {
  it('defaults to the environment, a summary, and lenience', () => {
    expect(parseArguments([])).toEqual({
      channel: null,
      requested: [],
      disabled: [],
      all: false,
      json: false,
      strict: false,
      help: false,
    });
  });

  it('reads every flag it documents', () => {
    expect(
      parseArguments([
        '--channel',
        'canary',
        '--features',
        'a,b',
        '--disable-features',
        'c',
        '--all',
        '--json',
        '--strict',
      ])
    ).toEqual({
      channel: 'canary',
      requested: ['a,b'],
      disabled: ['c'],
      all: true,
      json: true,
      strict: true,
      help: false,
    });
  });

  it('accumulates a flag given more than once', () => {
    expect(
      parseArguments(['--features', 'a', '--features', 'b'])
    ).toMatchObject({
      requested: ['a', 'b'],
    });
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    expect(parseArguments(['--featurez', 'a'])).toBe(
      'unknown option --featurez'
    );
  });

  it('refuses a value flag with nothing after it', () => {
    expect(parseArguments(['--channel'])).toBe('--channel needs a value');
    expect(parseArguments(['--features'])).toBe('--features needs a value');
    expect(parseArguments(['--disable-features'])).toBe(
      '--disable-features needs a value'
    );
  });

  it('refuses a value flag followed by another flag, not swallowing it', () => {
    expect(parseArguments(['--channel', '--json'])).toBe(
      '--channel needs a value'
    );
  });

  it('does not treat a value as a positional it could reject', () => {
    expect(parseArguments(['--channel', 'beta'])).toMatchObject({
      channel: 'beta',
    });
    expect(parseArguments(['beta'])).toBe('unknown option beta');
  });
});

describe('answering the conditional question', () => {
  it('resolves against a channel passed as a flag, with no variable set', async () => {
    const r = run(['--channel', 'canary']);
    await expect(r.code).resolves.toBe(0);
    expect(r.text()).toContain('channel: canary');
  });

  it('reads a channel alias through the same parser the variable uses', async () => {
    const r = run(['--channel', 'nightly']);
    await expect(r.code).resolves.toBe(0);
    expect(r.text()).toContain('channel: canary');
  });

  it('lets the flag override the variable, so a shell need not be edited', async () => {
    const r = run(['--channel', 'beta'], { [CHANNEL_ENV]: 'stable' });
    await expect(r.code).resolves.toBe(0);
    expect(r.text()).toContain('channel: beta');
  });

  it('turns a feature on without a variable, and shows why', async () => {
    const r = run([
      '--channel',
      'canary',
      '--features',
      FeatureName.OutputShaper,
      '--all',
    ]);
    await expect(r.code).resolves.toBe(0);
    expect(r.text()).toContain(`on  ${FeatureName.OutputShaper}`);
  });

  it('shows a request the channel does not carry as blocked, not as on', async () => {
    const r = run(['--features', FeatureName.ToolCodeMode, '--all']);
    await expect(r.code).resolves.toBe(0);
    const said = r.text();
    expect(said).toContain(`off ${FeatureName.ToolCodeMode}`);
    expect(said.toLowerCase()).toContain('stable');
  });

  it('switches a default-on feature off from the flag', async () => {
    const r = run(['--disable-features', FeatureName.DeferTools, '--all']);
    await expect(r.code).resolves.toBe(0);
    expect(r.text()).toContain(`off ${FeatureName.DeferTools}`);
  });

  it('adds to the variables rather than replacing them', async () => {
    // On canary, where substitution is actually available -- a request the
    // channel does not carry proves nothing about whether the two lists merged.
    const r = run(
      ['--channel', 'canary', '--features', FeatureName.Substitution, '--all'],
      {
        [REQUEST_ENV]: FeatureName.KnowledgeInjection,
      }
    );
    await expect(r.code).resolves.toBe(0);
    const said = r.text();
    expect(said).toContain(`on  ${FeatureName.Substitution}`);
    expect(said).toContain(`on  ${FeatureName.KnowledgeInjection}`);
  });

  it('prints every feature with --all and fewer lines without it', async () => {
    const all = run(['--all']);
    const summary = run([]);
    await all.code;
    await summary.code;
    for (const name of Object.values(FeatureName)) {
      expect(all.text()).toContain(name);
    }
    expect(all.text().split('\n').length).toBeGreaterThan(
      summary.text().split('\n').length
    );
  });
});

describe('--strict', () => {
  it('exits clean and says nothing was refused when the input is good', async () => {
    const r = run(['--strict', '--channel', 'beta']);
    await expect(r.code).resolves.toBe(0);
  });

  it('fails on an unknown channel rather than quietly using stable', async () => {
    const r = run(['--strict', '--channel', 'canry']);
    await expect(r.code).resolves.toBe(1);
    expect(r.text()).toContain('canry');
    expect(r.text()).toContain('known channels');
  });

  it('fails on a misspelled feature name, which is the point in CI', async () => {
    const r = run(['--strict'], { [REQUEST_ENV]: 'defer_tolls' });
    await expect(r.code).resolves.toBe(1);
    expect(r.text()).toContain('defer_tolls');
  });

  it('control: the same bad input succeeds without --strict, which hooks rely on', async () => {
    const lenient = run([], { [REQUEST_ENV]: 'defer_tolls' });
    await expect(lenient.code).resolves.toBe(0);
    expect(lenient.text()).toContain('defer_tolls');
  });

  it('control: the same bad channel succeeds without --strict', async () => {
    const lenient = run(['--channel', 'canry']);
    await expect(lenient.code).resolves.toBe(0);
    expect(lenient.text()).toContain('channel: stable');
  });

  it('fails on a name given to --disable-features that no feature has', async () => {
    const r = run(['--strict', '--disable-features', 'defer_tolls']);
    await expect(r.code).resolves.toBe(1);
  });
});

describe('--json', () => {
  it('emits the whole resolved state, including the digest a run is compared by', async () => {
    const r = run(['--json', '--channel', 'canary']);
    await expect(r.code).resolves.toBe(0);
    const parsed = JSON.parse(r.text()) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(ROLLOUT_SCHEMA_VERSION);
    expect(parsed.channel).toBe(RolloutChannel.Canary);
    expect(typeof parsed.digest).toBe('string');
    expect((parsed.digest as string).length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.decisions)).toBe(true);
    expect(parsed.decisions).toHaveLength(Object.values(FeatureName).length);
  });

  it('reports a refusal in the JSON as well as the text', async () => {
    const r = run(['--json'], { [DISABLE_ENV]: 'nonesuch' });
    await expect(r.code).resolves.toBe(0);
    const parsed = JSON.parse(r.text()) as { refusals: string[] };
    expect(parsed.refusals.join(' ')).toContain('nonesuch');
  });

  it('carries the digest, which stringifying the snapshot directly would drop', () => {
    const snapshot = resolveRollout({} as NodeJS.ProcessEnv);
    expect(JSON.parse(JSON.stringify(snapshot)).digest).toBeUndefined();
    expect(snapshotJson(snapshot).digest).toBe(snapshot.digest());
  });

  it('gives two runs of the same configuration the same digest, and two the opposite', () => {
    const base = resolveRollout({} as NodeJS.ProcessEnv);
    const same = resolveRollout({} as NodeJS.ProcessEnv);
    const other = resolveRollout({
      [CHANNEL_ENV]: 'canary',
    } as NodeJS.ProcessEnv);
    expect(snapshotJson(same).digest).toBe(snapshotJson(base).digest);
    expect(snapshotJson(other).digest).not.toBe(snapshotJson(base).digest);
  });
});

describe('main', () => {
  it('prints usage for --help and resolves nothing', async () => {
    const r = run(['--help']);
    await expect(r.code).resolves.toBe(0);
    expect(r.text()).toContain('token-optimizer-rollout [options]');
    expect(r.text()).not.toContain('channel: ');
  });

  it('names the variables in its usage, rather than making a reader find them', async () => {
    const r = run(['--help']);
    await r.code;
    for (const variable of [CHANNEL_ENV, REQUEST_ENV, DISABLE_ENV]) {
      expect(r.text()).toContain(variable);
    }
  });

  it('exits 2 with usage for a flag it does not have', async () => {
    const r = run(['--nope']);
    await expect(r.code).resolves.toBe(2);
    expect(r.text()).toContain('unknown option --nope');
    expect(r.text()).toContain('--strict');
  });
});
