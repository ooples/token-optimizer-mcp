import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { pathToFileURL } from 'url';
import { join } from 'path';

/**
 * The standing policy must ask the agent to RECORD what it concluded.
 *
 * The graph had 851 structural nodes and zero findings on a real project after
 * days of work. Not because extraction was broken -- `wiki_write` works, and
 * writes a finding anchored to real file nodes -- but because nothing ever asked
 * for it. The only other route was `harvest.mjs`, which calls a SEPARATE model
 * and is gated on a credential -- not opt-in, as this comment used to say, but
 * `off:no-key` wherever there is no key -- so on a default install the semantic
 * layer could never fill.
 *
 * The session already running is the right extractor: it knows what it
 * concluded, at no marginal cost, with nothing leaving the machine. The lever
 * that reaches it is the SessionStart briefing -- the same standing context that
 * already redirects reads and searches to the smart tools, and demonstrably
 * changes behaviour for a whole session.
 *
 * ANCHORS ARE ASSERTED HERE because an unanchored finding can never go stale, so
 * it is served as current forever; `wiki_write` refuses one, and a briefing that
 * omitted the requirement would produce refusals the agent cannot diagnose.
 */

const ADAPTER = pathToFileURL(
  join(process.cwd(), 'hooks-core', 'adapter.mjs')
).href;

let policyText;
let volatileLines;

beforeAll(async () => {
  ({ policyText } = await import(ADAPTER));
  ({ volatileLines } = await import(
    pathToFileURL(join(process.cwd(), 'hooks-core', 'cache.mjs')).href
  ));
});

describe('the standing policy asks for findings', () => {
  it('names the tool that records them', () => {
    expect(policyText(true)).toMatch(/wiki_write/);
  });

  it('states the anchor requirement, which the tool enforces', () => {
    // Without this the agent learns the rule by having writes refused.
    expect(policyText(true)).toMatch(/anchor/i);
  });

  it('says what is worth recording, not merely that recording exists', () => {
    // "Record findings" is an exhortation. The graph's own extraction prompt is
    // specific -- what was TRIED AND REJECTED, and why, because that exists
    // nowhere in the source tree -- and the briefing has to carry that same
    // specificity or it produces restatements of what the code already says.
    expect(policyText(true)).toMatch(/rejected|failure|decision/i);
  });

  it('keeps the briefing in both enforcement modes', () => {
    // policyText(false) is the advise-only wording used by clients that cannot
    // deny a tool call. Recording findings is not an enforcement feature, so it
    // must not disappear along with the denial language.
    expect(policyText(false)).toMatch(/wiki_write/);
  });
});

/**
 * ...and says whether anything else is going to extract them.
 *
 * The state was legible only from the doctor, which is a place somebody goes
 * after they already suspect a problem. A user watching a graph fill with
 * structural nodes and no verdicts has no reason to suspect one -- the failure
 * this project has now measured twice -- and the model holding a conclusion has
 * no way to know whether dropping it costs anything.
 *
 * SO THE LINE IS ADDRESSED TO THE MODEL, which is what earns it a place in the
 * prefix instead of a systemMessage. Each mode is asserted separately because
 * the useful content differs per mode, and the one a default install actually
 * gets is the one most likely to be written carelessly.
 */
describe('the standing policy states what will extract findings after the session', () => {
  const KEYS = [
    'TOKEN_OPTIMIZER_MODE',
    'TOKEN_OPTIMIZER_HARVEST',
    'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
    'TOKEN_OPTIMIZER_API_KEY',
    'ANTHROPIC_API_KEY',
  ];
  const saved = new Map();

  beforeEach(() => {
    saved.clear();
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('says a local endpoint runs it free and private, with nothing leaving the machine', () => {
    // The configuration a user would choose if they knew it existed, and the one
    // that was buried deepest: no credential, no billing, no digest sent.
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT =
      'http://127.0.0.1:11434/v1/chat/completions';
    const text = policyText(true);

    expect(text).toMatch(/local model endpoint is configured/i);
    expect(text).toMatch(/free and private/i);
    expect(text).toMatch(/nothing leaving this machine/i);
  });

  it('names what a credentialed harvest sends, and what it never sends', () => {
    process.env.TOKEN_OPTIMIZER_API_KEY = 'sk-test';
    const text = policyText(true);

    expect(text).toMatch(/bounded digest/i);
    expect(text).toMatch(/never file contents/i);
  });

  it('on a machine with no credential, states the consequence and names the free option', () => {
    // THE DEFAULT STATE, and the whole reason this line exists. `off:no-key` is
    // CI, corporate laptops and every subscription-only login.
    const text = policyText(true);

    expect(text).toMatch(/no separate extractor will run/i);
    expect(text).toMatch(/derived locally/i);
    expect(text).toMatch(/TOKEN_OPTIMIZER_HARVEST_ENDPOINT/);
  });

  it('does not argue with a deliberate opt-out, but still states the consequence', () => {
    // Nagging about a setting somebody chose is how a notice stops being read,
    // and this one is charged to every session's prefix.
    process.env.TOKEN_OPTIMIZER_HARVEST = '0';
    process.env.TOKEN_OPTIMIZER_API_KEY = 'sk-test';
    const text = policyText(true);

    expect(text).toMatch(/off by configuration/i);
    expect(text).toMatch(/derived locally/i);
    expect(text).not.toMatch(/TOKEN_OPTIMIZER_HARVEST_ENDPOINT/);
  });

  it('carries nothing volatile in ANY mode, so it cannot re-price the prefix', () => {
    // This text lands near the FRONT of the prompt prefix, which a cache
    // invalidates from the first differing byte onward -- and unlike the project
    // briefing, policyText does NOT pass through `stableText`, so a volatile
    // construct here is emitted rather than dropped. cache.test.mjs asserts this
    // for whatever mode the ambient environment happens to be in; the notice is
    // the one part of the block that differs per mode, so each mode is checked.
    // Volatile means what `volatileLines` means -- a date, a session id, a sha,
    // a run counter, an epoch -- not any digit at all.
    for (const env of [
      {},
      { TOKEN_OPTIMIZER_API_KEY: 'sk-test' },
      { TOKEN_OPTIMIZER_HARVEST: '0' },
      { TOKEN_OPTIMIZER_HARVEST_ENDPOINT: 'http://localhost:11434/v1/chat/completions' },
    ]) {
      for (const key of KEYS) delete process.env[key];
      Object.assign(process.env, env);
      expect(volatileLines(policyText(true))).toHaveLength(0);
    }
  });
});
