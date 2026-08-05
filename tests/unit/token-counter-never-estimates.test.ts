import { describe, it, expect, afterEach } from '@jest/globals';
import { TokenCounter } from '../../src/core/token-counter.js';

/**
 * A token count is the number every reported saving is derived from. It must be
 * measured, never guessed.
 *
 * TokenCounter picked its model from CLAUDE_MODEL / ANTHROPIC_MODEL /
 * OPENAI_MODEL / GOOGLE_AI_MODEL, and nulled its encoder for any model tiktoken
 * does not name -- after which `count()` returned Math.ceil(length / 4)
 * silently, in the same field, with nothing marking it as an estimate.
 *
 * Measured against real tokenization, that estimate is wrong by:
 *
 *   whitespace-heavy source   +130.4%   <- indented code, and it OVERSTATES
 *   typescript source          +14.7%
 *   english prose              +11.9%
 *   minified json              -27.0%
 *   emoji                      -62.5%
 *   japanese                   -74.2%
 *   base64                     -75.0%
 *
 * It was reachable with GOOGLE_AI_MODEL or a non-tiktoken OPENAI_MODEL set, and
 * this package ships a Gemini integration. mapToTiktokenModel already defaults
 * to gpt-4, so an encoder is always available.
 */

const MODEL_VARS = [
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'GOOGLE_AI_MODEL',
];
const saved = new Map<string, string | undefined>();

const withModelEnv = (key: string, value: string): TokenCounter => {
  for (const v of MODEL_VARS) {
    if (!saved.has(v)) saved.set(v, process.env[v]);
    delete process.env[v];
  }
  process.env[key] = value;
  return new TokenCounter();
};

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/** Indented source: the case where the estimate was worst, and overstated. */
const WHITESPACE_HEAVY = ('    '.repeat(8) + 'const indented = true;\n').repeat(
  25
);
const estimateFor = (s: string) => Math.ceil(s.length / 4);

describe('token counting never silently estimates', () => {
  const models: Array<[string, string]> = [
    ['GOOGLE_AI_MODEL', 'gemini-2.0-flash'],
    ['OPENAI_MODEL', 'o3-mini'],
    ['ANTHROPIC_MODEL', 'claude-sonnet-4-5'],
    ['CLAUDE_MODEL', 'some-unreleased-model-name'],
  ];

  for (const [key, value] of models) {
    it(`tokenizes for real with ${key}=${value}`, () => {
      const counter = withModelEnv(key, value);
      const { tokens } = counter.count(WHITESPACE_HEAVY);
      counter.free();

      // The whole point: not length/4.
      expect(tokens).not.toBe(estimateFor(WHITESPACE_HEAVY));
      expect(tokens).toBeGreaterThan(0);
    });
  }

  it('gives every model the same count for the same text', () => {
    // Different models may map to different encoders, but none may fall off
    // onto arithmetic. Equal counts here show they all reached a real encoder.
    const counts = models.map(([key, value]) => {
      const counter = withModelEnv(key, value);
      const n = counter.count(WHITESPACE_HEAVY).tokens;
      counter.free();
      return n;
    });

    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).not.toBe(estimateFor(WHITESPACE_HEAVY));
  });

  it('does not overstate whitespace-heavy source, which is what the estimate did', () => {
    const counter = withModelEnv('GOOGLE_AI_MODEL', 'gemini-2.0-flash');
    const { tokens } = counter.count(WHITESPACE_HEAVY);
    counter.free();

    // The estimate read +130% high here. A real tokenizer collapses runs of
    // spaces, so the true count is well BELOW length/4.
    expect(tokens).toBeLessThan(estimateFor(WHITESPACE_HEAVY));
  });

  it('still scales with the input', () => {
    const counter = withModelEnv('GOOGLE_AI_MODEL', 'gemini-2.0-flash');
    const one = counter.count(WHITESPACE_HEAVY).tokens;
    const two = counter.count(WHITESPACE_HEAVY + WHITESPACE_HEAVY).tokens;
    counter.free();

    expect(two).toBeGreaterThan(one * 1.8);
  });

  it('counts empty text as zero', () => {
    const counter = withModelEnv('GOOGLE_AI_MODEL', 'gemini-2.0-flash');
    expect(counter.count('').tokens).toBe(0);
    counter.free();
  });
});
