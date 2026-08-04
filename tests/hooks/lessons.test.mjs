/**
 * The feedback loop's two refusals, and the phrasing rule the A/B forced.
 *
 * A correction is the highest-value thing a session produces and the easiest to
 * mislabel. These pin the guarantees: human origin is claimed only on a quote
 * that is actually in the transcript, every lesson carries a trigger, and the
 * claim leads with the action rather than burying it.
 */
import { describe, it, expect } from '@jest/globals';
import {
  buildFeedbackDigest,
  quoteIsVerbatim,
  isImperative,
  validateLessons,
  LESSON_PROMPT,
} from '../../hooks-core/lessons.mjs';
import { ORIGIN_HUMAN, ORIGIN_HARVESTED } from '../../hooks-core/curate.mjs';

const TURNS = [
  { role: 'user', text: 'run the unit tests please' },
  { role: 'assistant', text: 'Running them.', tools: [{ name: 'Bash', command: 'npx jest tests/' }] },
  {
    role: 'user',
    text: 'no, use npm test — bare npx jest silently skips the ESM suites in this repo',
  },
  { role: 'assistant', text: 'You are right, re-running.', tools: [{ name: 'Bash', command: 'npm test' }] },
];

describe('provenance', () => {
  it('claims human origin only when the quote is really in the transcript', () => {
    const { lessons } = validateLessons(
      [
        {
          claim: 'Run npm test, not npx jest. Bare jest skips the ESM suites here.',
          quote: 'no, use npm test',
          trigger: '\\bnpx\\s+jest\\b',
          anchors: [],
        },
      ],
      TURNS
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].origin).toBe(ORIGIN_HUMAN);
    expect(lessons[0].confidence).toBe(0.95);
    expect(lessons[0].quote).toBe('no, use npm test');
  });

  it('demotes a paraphrase to harvested rather than letting it outrank its source', () => {
    // Human findings carry the highest ranking weight. A model's reading of a
    // correction must not be stored as the correction itself.
    const { lessons } = validateLessons(
      [
        {
          claim: 'Run npm test, not npx jest.',
          quote: 'the user said to prefer npm test over npx jest',
          trigger: '\\bnpx\\s+jest\\b',
        },
      ],
      TURNS
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].origin).toBe(ORIGIN_HARVESTED);
    expect(lessons[0].confidence).toBeLessThan(0.95);
    expect(lessons[0].quote).toBeUndefined();
  });

  it('ignores assistant text when verifying a quote', () => {
    // Otherwise the agent could "verify" its own words as the user's.
    expect(quoteIsVerbatim('You are right, re-running.', TURNS)).toBe(false);
  });

  it('tolerates whitespace differences but not rewording', () => {
    expect(quoteIsVerbatim('no,   use   npm test', TURNS)).toBe(true);
    expect(quoteIsVerbatim('please use npm test', TURNS)).toBe(false);
  });
});

describe('the phrasing rule', () => {
  it('accepts a claim that leads with the action', () => {
    expect(isImperative('Run npm test, not npx jest.')).toBe(true);
    expect(isImperative('Check mergeStateStatus before investigating CI.')).toBe(true);
  });

  it('rejects claims that bury the action behind context', () => {
    // The A/B case that failed even when correctly delivered read exactly like
    // these: the instruction arrived after three sentences of background.
    expect(isImperative('The user prefers npm test over npx jest.')).toBe(false);
    expect(isImperative('It is better to run npm test here.')).toBe(false);
    expect(isImperative('You should check mergeStateStatus.')).toBe(false);
  });

  it('drops a non-imperative lesson and says why', () => {
    const { lessons, rejected } = validateLessons(
      [{ claim: 'The user prefers npm test to npx jest.', quote: 'no, use npm test', trigger: 'jest' }],
      TURNS
    );
    expect(lessons).toHaveLength(0);
    expect(rejected[0].reason).toBe('not-imperative');
  });
});

describe('triggers are mandatory', () => {
  it('rejects a lesson with no trigger', () => {
    const { lessons, rejected } = validateLessons(
      [{ claim: 'Run npm test, not npx jest.', quote: 'no, use npm test' }],
      TURNS
    );
    expect(lessons).toHaveLength(0);
    expect(rejected[0].reason).toBe('no-trigger');
  });

  it('rejects a trigger that is not a valid regex', () => {
    const { lessons, rejected } = validateLessons(
      [{ claim: 'Run npm test.', quote: 'no, use npm test', trigger: '([unclosed' }],
      TURNS
    );
    expect(lessons).toHaveLength(0);
    expect(rejected[0].reason).toBe('bad-trigger-regex');
  });
});

describe('extractor input', () => {
  it('renders the conversation with commands but never tool results', () => {
    const digest = buildFeedbackDigest(TURNS);
    expect(digest).toContain('USER: run the unit tests please');
    expect(digest).toContain('npx jest tests/');
    // Nothing in the archive carries results, so nothing can leak through here.
    expect(digest).not.toMatch(/PASS|FAIL|Tests:/);
  });

  it('keeps the END of a long transcript, where corrections cluster', () => {
    const many = [];
    for (let i = 0; i < 500; i++) many.push({ role: 'user', text: `filler turn ${i} ${'x'.repeat(200)}` });
    many.push({ role: 'user', text: 'THE CORRECTION AT THE END' });

    const digest = buildFeedbackDigest(many, { maxChars: 2000 });
    expect(digest).toContain('THE CORRECTION AT THE END');
    expect(digest).not.toContain('filler turn 0 ');
  });

  it('returns null for an empty session rather than prompting on nothing', () => {
    expect(buildFeedbackDigest([])).toBeNull();
  });
});

describe('the prompt itself', () => {
  it('asks for the action first and for a verbatim quote', () => {
    // The two properties everything downstream depends on.
    expect(LESSON_PROMPT).toMatch(/IMPERATIVE with the action FIRST/);
    expect(LESSON_PROMPT).toMatch(/copied EXACTLY/);
    // And it must make an empty answer feel correct, or it will invent lessons.
    expect(LESSON_PROMPT).toMatch(/empty list is a correct and common answer/);
  });
});

describe('malformed extractor output', () => {
  it('survives unparseable JSON', () => {
    const { lessons, rejected } = validateLessons('not json at all', TURNS);
    expect(lessons).toHaveLength(0);
    expect(rejected[0].reason).toBe('unparseable');
  });

  it('strips a markdown fence the model added anyway', () => {
    const raw =
      '```json\n[{"claim":"Run npm test, not npx jest.","quote":"no, use npm test","trigger":"jest"}]\n```';
    const { lessons } = validateLessons(raw, TURNS);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].origin).toBe(ORIGIN_HUMAN);
  });
});
