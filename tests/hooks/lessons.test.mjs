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
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { standingRules, safeTrigger } from '../../hooks-core/inject.mjs';
import { wikiDir, load, putNode } from '../../hooks-core/wiki.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

describe('the checks the review found were passable without passing', () => {
  const TURNS = [{ role: 'user', text: 'no, use npm test not npx jest' }];

  it('rejects a quote whose capitalisation never occurred', () => {
    // Both sides were lower-cased before comparing, so a quote the user never
    // typed satisfied a VERBATIM check -- and then earned ORIGIN_HUMAN and 0.95
    // confidence on the strength of it. The prompt asks for an exact copy.
    expect(quoteIsVerbatim('use npm test not npx jest', TURNS)).toBe(true);
    expect(quoteIsVerbatim('USE NPM TEST NOT NPX JEST', TURNS)).toBe(false);
    expect(quoteIsVerbatim('Use Npm Test Not Npx Jest', TURNS)).toBe(false);
  });

  it('still forgives whitespace, which the storage layer chose, not the user', () => {
    expect(quoteIsVerbatim('use  npm   test' + String.fromCharCode(92) + 'n not npx jest'.trim(), TURNS)).toBe(false);
    expect(quoteIsVerbatim('use  npm  test  not  npx  jest', TURNS)).toBe(true);
  });

  it('does not throw when there is no archive to check against', () => {
    expect(() => quoteIsVerbatim('use npm test', null)).not.toThrow();
    expect(quoteIsVerbatim('use npm test', null)).toBe(false);
    expect(quoteIsVerbatim('use npm test', undefined)).toBe(false);
  });

  it('rejects a noun-led description that merely avoids the denylist', () => {
    // The old rule listed the openings a paraphrase usually starts with and
    // accepted everything else, so any noun-led sentence walked through and was
    // stored as a standing rule despite describing rather than instructing.
    expect(isImperative('npm test is preferred over npx jest.')).toBe(false);
    expect(isImperative('jest runs faster than the npm wrapper.')).toBe(false);
    expect(isImperative('builds should be run from the worktree.')).toBe(false);

    // And still accepts the shape a real instruction has.
    expect(isImperative('Use npm test, not npx jest.')).toBe(true);
    expect(isImperative('Never force-push a shared branch.')).toBe(true);
    expect(isImperative('Verify the refspec before trusting a fetch.')).toBe(true);
  });

  it('fails closed on an opening it does not recognise', () => {
    // The direction matters more than the coverage: this text becomes an
    // always-on instruction, so an unrecognised opening is refused rather than
    // admitted.
    expect(isImperative('frobnicate the widget.')).toBe(false);
    expect(isImperative('')).toBe(false);
  });
});

describe('a verified correction survives the write boundary', () => {
  // THE FINDING THAT MADE THE WHOLE FEATURE INERT. `validateLessons` computed a
  // per-lesson origin and kept the verified quote; `writeHarvested` took ONE
  // origin from its options and persisted no quote at all. So every lesson
  // landed as ORIGIN_HARVESTED, the standing-rules layer selects on human
  // origin, and it therefore matched nothing this pipeline had ever written.
  // The verbatim check ran and had no observable effect.
  //
  // This drives the real write path and then the real selector, because both
  // halves passed their own unit tests for the entire time the pair did nothing.
  it('is stored as human, keeps its evidence, and reaches the standing rules', () => {
    const project = mkdtempSync(join(tmpdir(), 'lesson-origin-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    const dir = join(project, '.token-optimizer', 'wiki');
    mkdirSync(dir, { recursive: true });

    const anchor = join(project, 'a.ts');
    writeFileSync(anchor, 'export const a = 1;');
    putNode(dir, { kind: 'file', key: anchor, hash: 'h' });

    const written = writeHarvested(
      dir,
      [
        {
          type: 'feedback',
          claim: 'Use npm test, not npx jest.',
          confidence: 0.95,
          origin: ORIGIN_HUMAN,
          quote: 'no, use npm test not npx jest',
          anchors: [anchor],
        },
        {
          type: 'feedback',
          claim: 'Prefer the worktree build.',
          confidence: 0.6,
          origin: ORIGIN_HARVESTED,
          anchors: [anchor],
        },
      ],
      // The batch default is still HARVESTED, exactly as the worker passes it.
      { sessionId: 's1', origin: ORIGIN_HARVESTED }
    );
    expect(written).toHaveLength(2);

    const graph = load(dir);
    const findings = [...graph.nodes.values()].filter((n) => n.kind === 'finding');
    const verified = findings.find((n) => n.claim.startsWith('Use npm test'));
    const paraphrase = findings.find((n) => n.claim.startsWith('Prefer the worktree'));

    // The verified one is promoted, and carries the evidence that promoted it.
    expect(verified.origin).toBe(ORIGIN_HUMAN);
    expect(verified.quote).toBe('no, use npm test not npx jest');

    // The unverified one is NOT promoted. A caller cannot simply declare
    // machine output human; it is the quote that earns it.
    expect(paraphrase.origin).toBe(ORIGIN_HARVESTED);
    expect(paraphrase.quote).toBeUndefined();

    // And the selector that exists to consume it now finds it.
    const rules = standingRules(dir, load(dir));
    expect(rules).toContain('Use npm test, not npx jest.');
    expect(rules).not.toContain('Prefer the worktree build.');

    rmSync(project, { recursive: true, force: true });
  }, 60_000);
});

describe('a session whose corrections are worth keeping is not skipped for its size', () => {
  it('one oversize turn does not abort the whole digest', () => {
    // THE DEFECT: the loop walks turns backwards to keep the END -- the module's own reasoning is
    // that corrections cluster where the work went wrong -- and `break`s the moment a turn would
    // overflow the budget. When the NEWEST turn is on its own larger than maxChars (one pasted
    // stack trace, one dumped file, one long diff), the break fired on the FIRST iteration, `out`
    // stayed empty and this returned null. harvest-worker guards on `if (feedback)`, so the entire
    // feedback pass was skipped: no extraction, no lesson validation, no metrics record, no signal
    // anywhere. And a big terminal turn is exactly what a session that went wrong tends to produce.
    const turns = [
      { role: 'user', text: 'use npm test, not npx jest' },
      { role: 'assistant', text: 'understood' },
      { role: 'assistant', text: 'X'.repeat(50_000) },
    ];
    const digest = buildFeedbackDigest(turns, { maxChars: 1_000 });
    expect(digest).not.toBeNull();
    expect(digest).toContain('use npm test');
    expect(digest).not.toContain('X'.repeat(200));
  });

  it('the budget is still respected for turns that fit', () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({ role: 'user', text: `line ${i} `.repeat(20) }));
    const digest = buildFeedbackDigest(turns, { maxChars: 1_000 });
    expect(digest.length).toBeLessThanOrEqual(1_200);
  });

  it('a genuinely empty set of turns is still null', () => {
    expect(buildFeedbackDigest([], { maxChars: 1_000 })).toBeNull();
  });
});

describe('a lesson is only stored if its trigger can ever fire', () => {
  const lesson = (trigger) => JSON.stringify([{
    claim: 'Use npm test rather than npx jest for this repository.',
    trigger,
    anchors: ['package.json'],
  }]);

  it('a trigger the injector would refuse is rejected at store time', () => {
    // THE DEFECT: this validated with a bare `new RegExp`, which only proves the pattern COMPILES.
    // inject.mjs additionally refuses sources over 200 characters and nested-quantifier ReDoS
    // shapes -- and when it refuses, appliesToCommand falls back to a LITERAL substring search of
    // the regex SOURCE against the command. A regex source is not a substring of any real command,
    // so such a lesson was written to the graph, counted as delivered, and could never surface.
    // String.raw, because these are REGEX SOURCES. Written as ordinary quoted strings, JavaScript
    // turns `\b` into U+0008 and drops the backslash from `\w`, `\s` and `\.` -- so the first
    // version of this test exercised `(w+s*)+.csproj` and a backspace-delimited `npxs+jest`,
    // neither of which is the pattern named. The repo's own no-stray-control-characters guard is
    // what caught it.
    const nested = String.raw`(\w+\s*)+\.csproj`;
    const tooLong = String.raw`\b(`
      + Array.from({ length: 40 }, (_, i) => `runner${i}`).join('|')
      + String.raw`)\b`;

    for (const bad of [nested, tooLong]) {
      const out = validateLessons(lesson(bad), []);
      expect(out.lessons).toHaveLength(0);
      expect(out.rejected.some((r) => r.reason === 'bad-trigger-regex')).toBe(true);
    }
  });

  it('the rejection agrees with what the injector would actually do', () => {
    // The property, rather than a restatement of the implementation: anything this stores must be
    // something safeTrigger will run. Asserting against safeTrigger directly means the test still
    // holds if the rejection reason or the validator's internals change.
    // safeTrigger returns the compiled RegExp it would run, or null when it refuses -- which is
    // why the production check is `if (!safeTrigger(trigger))` rather than a boolean comparison.
    const nested = String.raw`(\w+\s*)+\.csproj`;
    expect(safeTrigger(nested)).toBeNull();
    expect(validateLessons(lesson(nested), []).lessons).toHaveLength(0);
  });

  it('an ordinary trigger the injector accepts still passes', () => {
    const good = String.raw`\bnpx\s+jest\b`;
    expect(safeTrigger(good)).toBeInstanceOf(RegExp);
    const out = validateLessons(lesson(good), []);
    expect(out.rejected.filter((r) => r.reason === 'bad-trigger-regex')).toHaveLength(0);
  });
});

describe('a lesson cannot be anchored to a file the session never opened', () => {
  const lesson = (anchors) => JSON.stringify([{
    claim: 'Use npm test rather than npx jest for this repository.',
    trigger: String.raw`\bnpx\s+jest\b`,
    anchors,
  }]);

  it('an invented path is dropped when the touched-file list is known', () => {
    // THE DEFECT: the finding path calls validate() with `knownFiles: filesIn(digest)` and says
    // why in its own comment -- "a model that invents a plausible path cannot anchor a finding to
    // it" -- while this path accepted any non-empty string. A lesson anchored to a file nobody
    // opened is then injected on every future touch of that file: a permanent instruction attached
    // to code it was never about.
    const { lessons } = validateLessons(
      lesson(['/repo/src/real.ts', '/repo/src/invented-by-the-model.ts']),
      TURNS,
      { knownFiles: ['/repo/src/real.ts'] }
    );
    expect(lessons[0].anchors).toEqual(['/repo/src/real.ts']);
  });

  it('without a known-file list every anchor is still accepted', () => {
    // The full-delta path has no such list, so the restriction must not become mandatory.
    const { lessons } = validateLessons(lesson(['/repo/a.ts', '/repo/b.ts']), TURNS);
    expect(lessons[0].anchors).toHaveLength(2);
  });

  it('a path that would abort the process is refused either way', () => {
    // U+10FFFF trips an assert inside libuv rather than throwing, so no downstream try/catch helps.
    const unsafe = `/repo/${String.fromCodePoint(0x10ffff)}.ts`;
    const { lessons } = validateLessons(lesson(['/repo/ok.ts', unsafe]), TURNS);
    expect(lessons[0].anchors).toEqual(['/repo/ok.ts']);
  });
});
