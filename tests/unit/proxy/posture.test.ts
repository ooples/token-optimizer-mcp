/**
 * A POSTURE IS ONE WORD THAT SETS EIGHT THINGS, SO THE WORD IS THE RISK.
 *
 * Everything here exists because a posture is the one piece of configuration in
 * this package where what the operator typed and what the proxy does are furthest
 * apart. Four questions follow from that, and each one is a test below:
 *
 *   Does seeding actually reach the readers, or is a posture a variable nothing
 *   honours? -- which is this package's named recurring defect, in its env-shaped
 *   form: a capability registered, tested and green while nothing reads it.
 *
 *   Does an operator's own setting survive? setdefault says yes; assignment would
 *   say no while every report in the package agreed on a value nobody chose.
 *
 *   Can a reassuringly-named posture turn on a response-side feature? The `-lossy`
 *   rule says no, and the rule is enforced here rather than remembered.
 *
 *   Does the disclosure describe what happened, or what was asked for? A channel
 *   refuses features, and a notice that claimed them would be the same defect
 *   again, printed at the operator.
 */

import { describe, expect, it } from '@jest/globals';
import {
  COMPRESSION_ENV,
  LOSSY_SUFFIX,
  POSTURES,
  POSTURE_ENV,
  PostureName,
  applyPosture,
  postureFromEnv,
  postureIsHonestlyNamed,
  postureNotice,
  postureVariables,
} from '../../../src/proxy/posture.js';
import { presetFromEnv } from '../../../src/compress/options.js';
import {
  keepToolsFromEnv,
  smallToolCharsFromEnv,
} from '../../../src/proxy/server.js';
import {
  CHANNEL_ENV,
  DecisionReason,
  REQUEST_ENV,
  resolveRollout,
} from '../../../src/rollout/resolve.js';
import { FeatureName, FEATURES } from '../../../src/rollout/features.js';
import { RolloutChannel } from '../../../src/rollout/channel.js';

/** A bare environment, so nothing inherited from the runner can decide a case. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...extra };
}

/**
 * EVERY VARIABLE A POSTURE CAN SEED, PAIRED WITH THE SHIPPED READER THAT HONOURS IT.
 *
 * The pairing is BEHAVIOURAL on purpose: each entry sets the variable and calls the
 * function the proxy itself calls, so the test fails if the reader stops reading it.
 * A grep for the name would pass on a doc comment, and this package has already
 * found that exact failure in its own feature registry -- "a registry entry has to
 * be wired to a call site that reads it, or it is documentation pretending to be a
 * mechanism".
 */
const READERS: Readonly<
  Record<
    string,
    {
      readonly set: string;
      readonly read: (e: NodeJS.ProcessEnv) => unknown;
      readonly expect: unknown;
    }
  >
> = {
  [COMPRESSION_ENV]: {
    set: 'aggressive',
    read: (e) => presetFromEnv(e),
    expect: 'aggressive',
  },
  [REQUEST_ENV]: {
    set: FeatureName.NetSavingGuard,
    read: (e) =>
      resolveRollout(e).decisions.find(
        (d) => d.name === FeatureName.NetSavingGuard
      )?.reason,
    expect: DecisionReason.Requested,
  },
  TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS: {
    set: '3',
    read: (e) => keepToolsFromEnv(e),
    expect: 3,
  },
  TOKEN_OPTIMIZER_PROXY_SMALL_TOOL_CHARS: {
    set: '7',
    read: (e) => smallToolCharsFromEnv(e),
    expect: 7,
  },
};

/**
 * The variables a posture must never write, and why they are not an oversight.
 *
 * Each one carries consent rather than a setting: capture writes conversation
 * content to a directory, the ledger writes a file, and either holdout spends real
 * money on a control arm that is deliberately paying more. The feature registry
 * excludes them for this reason and says so; a one-word posture cannot say where or
 * how much on an operator's behalf.
 */
const CONSENT_BEARING: readonly string[] = [
  'TOKEN_OPTIMIZER_PROXY_CAPTURE',
  'TOKEN_OPTIMIZER_PROXY_ACCOUNTING',
  'TOKEN_OPTIMIZER_OUTPUT_HOLDOUT',
  'TOKEN_OPTIMIZER_PROXY_DEFER_HOLDOUT',
];

describe('a posture only names variables something reads', () => {
  it('pairs every seedable variable with a reader that honours it', () => {
    const unpaired = postureVariables().filter(
      (name) => READERS[name] === undefined
    );
    expect(unpaired).toEqual([]);
    // The control: the pairing above is only evidence if there is something to
    // pair. An empty posture table would satisfy the filter trivially.
    expect(postureVariables().length).toBeGreaterThan(3);
  });

  it('proves each reader returns the seeded value, by calling it', () => {
    for (const [name, probe] of Object.entries(READERS)) {
      expect(probe.read(env({ [name]: probe.set }))).toEqual(probe.expect);
      // And the control for each: the reader must not return that value when the
      // variable is absent, or the assertion above would hold for a reader that
      // ignores the environment entirely.
      expect(probe.read(env())).not.toEqual(probe.expect);
    }
  });

  it('never seeds a variable that carries consent rather than a setting', () => {
    const seedable = new Set(postureVariables());
    for (const name of CONSENT_BEARING) expect(seedable.has(name)).toBe(false);
    // The control: the check can see a variable when there is one to see.
    expect(seedable.has(COMPRESSION_ENV)).toBe(true);
  });
});

describe('the -lossy rule', () => {
  it('holds for every posture that ships', () => {
    for (const posture of Object.values(POSTURES)) {
      expect(postureIsHonestlyNamed(posture)).toBe(true);
    }
  });

  it('refuses a reassuring name that reaches the response side', () => {
    const dishonest = {
      ...POSTURES[PostureName.MaxLossy],
      name: 'max' as PostureName,
    };
    expect(postureIsHonestlyNamed(dishonest)).toBe(false);
    // The control: the same features under a name that says so are fine, so the
    // rule is about the name and not about the features.
    expect(
      postureIsHonestlyNamed({
        ...dishonest,
        name: `max${LOSSY_SUFFIX}` as PostureName,
      })
    ).toBe(true);
  });

  it('lets a posture of stable defaults keep a plain name', () => {
    const plain = Object.values(POSTURES).filter(
      (p) => !p.name.endsWith(LOSSY_SUFFIX)
    );
    expect(plain.length).toBeGreaterThan(0);
    for (const posture of plain) {
      for (const name of posture.features) {
        expect(FEATURES[name].defaultEnabledIn).toBe(RolloutChannel.Stable);
      }
    }
  });
});

describe('seeding', () => {
  it('asks for nothing when no posture is named', () => {
    expect(applyPosture(undefined, env())).toBeNull();
    expect(postureFromEnv(env())).toBeUndefined();
    expect(postureFromEnv(env({ [POSTURE_ENV]: '  ' }))).toBeUndefined();
    // The control: a named posture is found, so the nulls above are the absence
    // of a name and not a reader that never works.
    expect(postureFromEnv(env({ [POSTURE_ENV]: ' lean ' }))).toBe('lean');
  });

  it('writes the posture through to the readers the proxy uses', () => {
    const e = env();
    const applied = applyPosture(PostureName.Lean, e);
    expect(applied?.posture?.name).toBe(PostureName.Lean);
    expect(presetFromEnv(e)).toBe('aggressive');
    expect(keepToolsFromEnv(e)).toBe(0);
    expect(smallToolCharsFromEnv(e)).toBe(0);
    // The control: those are not the values a bare environment produces, so the
    // assertions above are reading the posture and not the defaults.
    expect(presetFromEnv(env())).toBe('balanced');
    expect(keepToolsFromEnv(env())).not.toBe(0);
  });

  it('leaves a variable the operator set alone, and seeds the rest', () => {
    const e = env({ TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS: '11' });
    const applied = applyPosture(PostureName.Lean, e);
    expect(keepToolsFromEnv(e)).toBe(11);
    expect(applied?.respected).toEqual(['TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS']);
    // Not a veto on the whole posture: everything else still seeded.
    expect(applied?.seeded).toContain(COMPRESSION_ENV);
    expect(presetFromEnv(e)).toBe('aggressive');
  });

  it('treats a blank variable as unset, because every reader does', () => {
    const e = env({ [COMPRESSION_ENV]: '' });
    applyPosture(PostureName.Careful, e);
    expect(presetFromEnv(e)).toBe('conservative');
  });

  it('asks the channel rather than granting, for a response-side feature', () => {
    const e = env({ [CHANNEL_ENV]: RolloutChannel.Stable });
    applyPosture(PostureName.MaxLossy, e);
    // The posture seeds the REQUEST channel, never a feature's own variable --
    // so the resolver applies exactly the rule it already applies.
    expect(e[FEATURES[FeatureName.DropThinking].env]).toBeUndefined();
    const snapshot = resolveRollout(e);
    const decision = (name: FeatureName): DecisionReason | undefined =>
      snapshot.decisions.find((d) => d.name === name)?.reason;
    expect(decision(FeatureName.NetSavingGuard)).toBe(DecisionReason.Requested);
    expect(decision(FeatureName.DropThinking)).toBe(
      DecisionReason.BlockedByChannel
    );
    // The control: on a channel that carries it, the same posture gets it.
    const canary = env({ [CHANNEL_ENV]: RolloutChannel.Canary });
    applyPosture(PostureName.MaxLossy, canary);
    expect(
      resolveRollout(canary).decisions.find(
        (d) => d.name === FeatureName.DropThinking
      )?.enabled
    ).toBe(true);
  });
});

describe('the disclosure', () => {
  it('names what the resolver enabled, and the variable that stops it', () => {
    const e = env({ [CHANNEL_ENV]: RolloutChannel.Canary });
    const applied = applyPosture(PostureName.MaxLossy, e);
    expect(applied).not.toBeNull();
    const notice = postureNotice(
      applied ?? { requested: '', posture: null, seeded: [], respected: [] },
      e
    );
    for (const name of POSTURES[PostureName.MaxLossy].features) {
      expect(notice).toContain(`ON: ${name}`);
      expect(notice).toContain(FEATURES[name].env);
    }
    expect(notice).toContain(POSTURE_ENV);
  });

  it('reports a refusal as a refusal rather than claiming the feature', () => {
    const e = env({ [CHANNEL_ENV]: RolloutChannel.Stable });
    const applied = applyPosture(PostureName.MaxLossy, e);
    const notice = postureNotice(
      applied ?? { requested: '', posture: null, seeded: [], respected: [] },
      e
    );
    expect(notice).toContain('not carried by channel stable');
    expect(notice).toContain(FeatureName.DropThinking);
    expect(notice).not.toContain(`ON: ${FeatureName.DropThinking}`);
    // The control: something IS on under this posture on this channel, so the
    // absence above is the channel's refusal and not an empty notice.
    expect(notice).toContain(`ON: ${FeatureName.NetSavingGuard}`);
  });

  it('says so when it left the operator settings alone', () => {
    const e = env({ TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS: '11' });
    const applied = applyPosture(PostureName.Lean, e);
    const notice = postureNotice(
      applied ?? { requested: '', posture: null, seeded: [], respected: [] },
      e
    );
    expect(notice).toContain(
      'left as you set it: TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS'
    );
    // The control: with nothing of the operator's to respect, the line is absent
    // rather than printed empty.
    const clean = env();
    const second = applyPosture(PostureName.Lean, clean);
    expect(
      postureNotice(
        second ?? { requested: '', posture: null, seeded: [], respected: [] },
        clean
      )
    ).not.toContain('left as you set it');
  });

  it('announces an unrecognised name instead of running defaults quietly', () => {
    const e = env();
    const applied = applyPosture('maximum', e);
    expect(applied?.posture).toBeNull();
    expect(applied?.seeded).toEqual([]);
    expect(e[COMPRESSION_ENV]).toBeUndefined();
    const notice = postureNotice(
      applied ?? { requested: '', posture: null, seeded: [], respected: [] },
      e
    );
    expect(notice).toContain('UNKNOWN POSTURE "maximum"');
    expect(notice).toContain(PostureName.MaxLossy);
    // The control: a name that IS recognised is not announced as unknown.
    const good = applyPosture(PostureName.Audit, env());
    expect(
      postureNotice(
        good ?? { requested: '', posture: null, seeded: [], respected: [] },
        env()
      )
    ).not.toContain('UNKNOWN');
  });
});
