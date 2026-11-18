/**
 * How well the prompt classifier (task-class.mjs) does on labelled prompts,
 * as a floor CI holds.
 *
 * TWO SETS, KEPT APART. The rules are tuned on task-class-dev.json; their score
 * there says little. task-class-heldout.json was labelled and committed before
 * the classifier ever ran on it and is never tuned on: its first score with
 * the retuned rules (2026-11-16) was 90/100 against 30/100 before. Fitting a
 * rule to a held-out miss to lift these numbers defeats the set -- add the
 * case to the dev set instead.
 *
 * PRECISION MATTERS MOST WHERE A CATEGORY CHANGES A SETTING. Survey turns
 * output discipline off and rewrite turns outline substitution off
 * (task-settings.mjs); a prompt wrongly put in either loses a default that
 * was measured to help it. Every other wrong answer runs the defaults.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskCategory, classifyPrompt } from '../../src/hooks-core/task-class.mjs';
import { settingsFor } from '../../src/hooks-core/task-settings.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')).prompts;
const CATEGORIES = Object.values(TaskCategory);

function score(prompts) {
  const matrix = Object.fromEntries(CATEGORIES.map((a) => [a, Object.fromEntries(CATEGORIES.map((b) => [b, 0]))]));
  for (const { label, prompt } of prompts) matrix[label][classifyPrompt(prompt, {}).category] += 1;
  const correct = CATEGORIES.reduce((sum, c) => sum + matrix[c][c], 0);
  const recall = (c) => matrix[c][c] / CATEGORIES.reduce((s, p) => s + matrix[c][p], 0);
  const precision = (c) => {
    const predicted = CATEGORIES.reduce((s, l) => s + matrix[l][c], 0);
    return predicted ? matrix[c][c] / predicted : 1;
  };
  return { matrix, correct, total: prompts.length, recall, precision };
}

/** The categories whose settings differ from UNKNOWN's: where a wrong answer costs. */
const consequential = () =>
  CATEGORIES.filter((c) => c !== TaskCategory.UNKNOWN && JSON.stringify(settingsFor(c)) !== JSON.stringify(settingsFor(TaskCategory.UNKNOWN)));

describe('held-out accuracy floor', () => {
  const heldout = score(load('task-class-heldout.json'));

  test('the set is what its file says: 100 prompts across every category', () => {
    expect(heldout.total).toBe(100);
    for (const c of CATEGORIES) expect(heldout.recall(c)).not.toBeNaN();
  });

  test("overall accuracy stays at or above 88/100 (first scored 90; 91 after the 2026-11-16 real-prompt retune)", () => {
    expect(heldout.correct).toBeGreaterThanOrEqual(88);
  });

  test('every task category is recalled at 0.75 or better', () => {
    for (const c of CATEGORIES) expect({ c, recall: heldout.recall(c) >= 0.75 }).toEqual({ c, recall: true });
  });

  test('a category that changes a setting is precise: 0.9 or better', () => {
    const changed = consequential();
    // The test means something only while some category changes a setting.
    expect(changed.length).toBeGreaterThan(0);
    for (const c of changed) expect({ c, precision: heldout.precision(c) >= 0.9 }).toEqual({ c, precision: true });
  });

  test('chat is never given a category', () => {
    expect(heldout.recall(TaskCategory.UNKNOWN)).toBe(1);
  });
});

describe('dev set', () => {
  test('the rules still fit what they were tuned on (109/112 when tuned)', () => {
    expect(score(load('task-class-dev.json')).correct).toBeGreaterThanOrEqual(106);
  });

  test('no prompt appears in both sets', () => {
    const dev = new Set(load('task-class-dev.json').map((p) => p.prompt.toLowerCase()));
    expect(load('task-class-heldout.json').filter((p) => dev.has(p.prompt.toLowerCase()))).toEqual([]);
  });
});

/*
 * REAL PROMPTS ARE NOT LIKE THE FIXTURES. Scored against two judge models'
 * agreed labels on 1,063 real prompts (2026-11-16; the prompts are private and
 * stay off this repository), the rules that scored 90/100 above put 13.6% of
 * non-survey prompts in survey: follow-ups such as "fix the unresolved review
 * comments" matched `review`, "whatever you recommend" matched `recommend`.
 * After the survey bar and deliverable rules, that rate was under 1% on the
 * judge-labelled dev sessions. These paraphrase the misfire patterns; none is
 * a real prompt.
 */
describe('conversational follow-ups are never given a setting-changing category', () => {
  const followUps = [
    ['fix', 'you still have unresolved review comments on PR #41 that need fixing'],
    ['fix', 'there are new review comments on that PR, please address them'],
    ['fix', 'also sort out the merge conflicts and the failing shards on the other PRs'],
    ['fix', "the checks are still red after your push, take another look"],
    [null, 'whatever you recommend, go ahead'],
    [null, 'yes I agree with your recommendation for option B'],
    [null, 'ok start implementing our full plan then'],
    [null, "let's park the architecture discussion until the loops are gone"],
    [null, 'make sure you fix all files touched in this PR'],
    [null, 'I will review the screenshots and add them myself'],
    [null, 'see the report from yesterday and keep going'],
    ['fix', 'merge conflicts on #12 and #14 as well'],
    // A report mentioned plus one weak cue: a mention, not a request.
    [null, 'see the report on all endpoints from yesterday and keep going'],
    // Weak survey evidence only (2 points): the survey bar alone keeps this out.
    [null, 'your job is to add benchmarks to the benchmark project that compare our kernels with other libraries'],
  ];
  const changed = new Set(consequential());

  test.each(followUps)('%s: %s', (expected, prompt) => {
    const { category } = classifyPrompt(prompt, {});
    expect({ prompt, consequential: changed.has(category) }).toEqual({ prompt, consequential: false });
    if (expected) expect(category).toBe(expected);
  });

  test('an explicit request for a report or plan still classifies as survey', () => {
    for (const prompt of [
      // Each matches one deliverable rule only, so each rule is tested.
      'put together a gap analysis of what is left on this milestone',
      'the next step is a comprehensive github issue on the slow kernels',
    ])
      expect({ prompt, category: classifyPrompt(prompt, {}).category }).toEqual({ prompt, category: TaskCategory.SURVEY });
  });
});
