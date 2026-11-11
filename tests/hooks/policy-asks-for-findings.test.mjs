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
  join(process.cwd(), 'src', 'hooks-core', 'adapter.mjs')
).href;

let policyText;
let recordingGuidance;
let volatileLines;

// THE GUIDANCE MOVED OUT OF policyText (#357, M5): SessionStart no longer
// carries it, and the first post-tool event after real work delivers
// recordingGuidance() once instead. What it must say is unchanged, so these
// assertions read it from where it now lives.
beforeAll(async () => {
  ({ policyText, recordingGuidance } = await import(ADAPTER));
  ({ volatileLines } = await import(
    pathToFileURL(join(process.cwd(), 'src', 'hooks-core', 'cache.mjs')).href
  ));
});

describe('the standing policy asks for findings', () => {
  it('names the tool that records them', () => {
    expect(recordingGuidance()).toMatch(/wiki_write/);
  });

  it('states the anchor requirement, which the tool enforces', () => {
    // Without this the agent learns the rule by having writes refused.
    expect(recordingGuidance()).toMatch(/anchor/i);
  });

  it('says what is worth recording, not merely that recording exists', () => {
    // "Record findings" is an exhortation. The graph's own extraction prompt is
    // specific -- what was TRIED AND REJECTED, and why, because that exists
    // nowhere in the source tree -- and the briefing has to carry that same
    // specificity or it produces restatements of what the code already says.
    expect(recordingGuidance()).toMatch(/rejected|failure|decision/i);
  });

  it('is the same briefing in both enforcement modes, and in neither SessionStart', () => {
    // Recording findings is not an enforcement feature, so it must not depend on
    // the denial wording either mode uses: it is one text, delivered after the
    // session has done real work, and neither policy block repeats it.
    expect(recordingGuidance()).toMatch(/wiki_write/);
    expect(policyText(true)).not.toMatch(/Record what you work out/);
    expect(policyText(false)).not.toMatch(/Record what you work out/);
  });
});

/**
 * ...in one short line, whatever extracts findings after the session.
 *
 * It used to end with a per-mode notice of what would extract findings after
 * the session (local endpoint, credential, host CLI, opted out, none). On the
 * 15-pair learned SWE-bench pilot the ~1,000-character block was injected in 8
 * of 13 plugin sessions and the model made 0 wiki_write calls, so it is now one
 * line. The extraction state is the person's configuration, and doctor's
 * harvest check states it to them.
 */
describe('the recording guidance is one short line in every harvest mode', () => {
  const KEYS = [
    'TOKEN_OPTIMIZER_MODE',
    'TOKEN_OPTIMIZER_HARVEST',
    'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
    'TOKEN_OPTIMIZER_API_KEY',
    'ANTHROPIC_API_KEY',
  ];
  const MODES = [
    {},
    { TOKEN_OPTIMIZER_API_KEY: 'sk-test' },
    { TOKEN_OPTIMIZER_HARVEST: '0' },
    { TOKEN_OPTIMIZER_HARVEST_ENDPOINT: 'http://localhost:11434/v1/chat/completions' },
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

  it('is the same short text in every mode, keeping the measured last-message rule', () => {
    const texts = MODES.map((env) => {
      for (const key of KEYS) delete process.env[key];
      Object.assign(process.env, env);
      return recordingGuidance();
    });
    expect(new Set(texts).size).toBe(1);
    expect(texts[0].length).toBeLessThanOrEqual(260);
    expect(texts[0]).toMatch(/never as your last message/);
  });

  it('carries nothing volatile in ANY mode, so it cannot re-price the prefix', () => {
    for (const env of MODES) {
      for (const key of KEYS) delete process.env[key];
      Object.assign(process.env, env);
      expect(volatileLines(policyText(true))).toHaveLength(0);
      expect(volatileLines(recordingGuidance())).toHaveLength(0);
    }
  });

  it('leaves the extraction options to doctor, which tells the person', async () => {
    const { probeHarvest } = await import(
      pathToFileURL(join(process.cwd(), 'src', 'hooks-core', 'doctor.mjs')).href
    );
    const advice = probeHarvest().map((check) => check.detail).join('\n');
    expect(advice).toMatch(/TOKEN_OPTIMIZER_HARVEST_ENDPOINT/);
    expect(advice).toMatch(/free and private/i);
    expect(recordingGuidance()).not.toMatch(/TOKEN_OPTIMIZER_HARVEST_ENDPOINT/);
  });
});
