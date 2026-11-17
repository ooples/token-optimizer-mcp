import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  localTaskClassifier, MAX_MODEL_BYTES, MODEL_FORMAT, predictTask, taskFeatures, validateTaskModel,
} from '../../src/hooks-core/learned-task-class.mjs';
import { resolveTaskPrompt } from '../../src/hooks-core/task-context.mjs';
import { probeTaskSettings } from '../../src/hooks-core/doctor.mjs';

const labels = ['build', 'explain', 'fix', 'locate', 'rewrite', 'survey', 'unknown'];
const model = (category = 'survey', strength = 12) => ({
  format: MODEL_FORMAT, labels: [...labels], terms: ['estimates'], idf: [1], bias: labels.map(() => 0),
  weights: labels.map((label) => [label === category ? strength : 0, 0]),
  contextWeight: .2, minimumScore: .4, switchThreshold: .85,
});
let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'learned-task-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const save = (value, name = Math.random().toString(36).slice(2)) => {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

describe('local model inference', () => {
  test('word/bigram counts, sublinear TF and independent L2 normalization', () => {
    const m = { terms: ['hello', 'world', 'hello world'], idf: [1, 2, 3] };
    const values = new Map(taskFeatures('HELLO hello world', m));
    const raw = [1 + Math.log(2), 2, 3];
    const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
    for (let i = 0; i < 3; i++) expect(values.get(i)).toBeCloseTo(raw[i] / norm, 12);
  });

  test('Unicode normalization and long tokens match the training contract', () => {
    expect(taskFeatures('cafe\u0301', { terms: ['café'], idf: [1] })).toEqual([[0, 1]]);
    expect(taskFeatures('a'.repeat(97), { terms: ['a'.repeat(96)], idf: [1] })).toEqual([]);
  });

  test('context occupies its own feature block and is weighted once', () => {
    const m = model('fix', 0);
    m.weights[2][1] = 10;
    const got = predictTask(m, '', 'estimates');
    expect(got.category).toBe('fix');
    expect(got.score).toBeCloseTo(Math.exp(2) / (Math.exp(2) + 6), 12);
  });

  test('unknown vocabulary cannot manufacture a prediction from the intercept', () => {
    const m = model(); m.bias[0] = 100;
    expect(predictTask(m, 'different vocabulary')).toBeNull();
  });

  test('weak setting-changing predictions fall back and strong ones carry only a model id', () => {
    const weak = localTaskClassifier({ TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: save(model('survey', 1)) });
    expect(weak.classify('estimates')).toBeNull();
    const strong = localTaskClassifier({ TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: save(model()) });
    expect(strong.classify('estimates')).toMatchObject({ category: 'survey', source: 'local-model' });
    expect(strong.classify('estimates').signals).toEqual([`local-model:${strong.id}`]);
  });

  test('returning to default settings is also a consequential transition', () => {
    const partial = localTaskClassifier({ TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: save(model('fix', 2)) });
    expect(partial.classify('estimates')?.category).toBe('fix');
    expect(partial.classify('estimates', [], { category: 'rewrite' })).toBeNull();
  });

  test('absent, missing, malformed and oversized models retain the rule fallback', () => {
    expect(localTaskClassifier({})).toMatchObject({ enabled: false, ok: true, classify: null });
    for (const path of [join(dir, 'missing.json'), save('{broken'), dir, 'relative.json'])
      expect(localTaskClassifier({ TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: path })).toMatchObject({ enabled: true, ok: false, classify: null });
    const path = save('{}'); truncateSync(path, MAX_MODEL_BYTES + 1);
    expect(localTaskClassifier({ TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: path }).ok).toBe(false);
  });

  test.each([
    (m) => { m.labels[0] = 'rewrite'; },
    (m) => { m.labels[0] = 'typo'; },
    (m) => { m.idf = []; },
    (m) => { m.weights[0] = [1]; },
    (m) => { m.weights[0][0] = 1e300; },
    (m) => { m.contextWeight = -1; },
    (m) => { m.minimumScore = 2; },
    (m) => { m.switchThreshold = .1; },
  ])('rejects invalid schemas and numerically unsafe coefficients', (mutate) => {
    const m = model(); mutate(m); expect(() => validateTaskModel(m)).toThrow();
  });

  test('the doctor warns when an opted-in model is unusable', () => {
    const result = probeTaskSettings({ TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: join(dir, 'missing.json') });
    expect(JSON.stringify(result)).toContain('unavailable; using rules');
    expect(JSON.stringify(result)).toContain('Train a valid local task model');
  });

  test('model exceptions, cancellations and numbered choices retain deterministic behavior', () => {
    expect(resolveTaskPrompt('no, do not rewrite the file', { intentClassifier() { throw new Error('must not run'); } }).category).toBe('unknown');
    expect(resolveTaskPrompt('estimates', { intentClassifier() { throw new Error('broken'); } }).category).toBe('unknown');
    expect(resolveTaskPrompt('yes option 1', { messages: [{ role: 'assistant', text: '1. Rewrite the whole file.\n2. Fix the cache bug.' }],
      intentClassifier() { return { category: 'fix' }; },
    }).category).toBe('rewrite');
    expect(resolveTaskPrompt('Rewrite the whole file in TypeScript', {
      intentClassifier() { throw new Error('clear request must win'); },
    }).category).toBe('rewrite');
  });
});

test('the distributed training corpus contains only the public development examples', () => {
  const corpus = readFileSync(new URL('../../src/scripts/task-classifier-examples.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const publicExamples = JSON.parse(readFileSync(new URL('../fixtures/task-class-dev.json', import.meta.url), 'utf8')).prompts;
  expect(corpus.map(({ prompt, label }) => ({ prompt, label }))).toEqual(publicExamples.map(({ prompt, label }) => ({ prompt, label })));
  expect(corpus.every((r) => r.before === '')).toBe(true);
});

test('the CLI rejects misspelled options and reports an unusable model', () => {
  const script = fileURLToPath(new URL('../../src/scripts/task-classifier.mjs', import.meta.url));
  const typo = spawnSync(process.execPath, [script, 'inspect', '--modle', 'missing.json'], { encoding: 'utf8' });
  expect(typo.status).toBe(1);
  expect(typo.stderr).toContain('Unknown or duplicate option');
  const invalid = spawnSync(process.execPath, [script, 'inspect', '--model', save('{broken')], { encoding: 'utf8' });
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ enabled: true, ok: false });
});

test('shipped hook applies the opted-in model, respects overrides, and stores no input text', () => {
  const path = save(model());
  const script = fileURLToPath(new URL('../../src/plugin/hooks/user-prompt-submit.mjs', import.meta.url));
  const run = (session, extra = {}) => spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: session, cwd: dir, prompt: 'estimates PRIVATE-CONTENT' }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'states'), TOKEN_OPTIMIZER_HOME: join(dir, 'home'),
      TOKEN_OPTIMIZER_MODE: 'assist', TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: path,
      TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '', TOKEN_OPTIMIZER_INJECTION_HOLDOUT: 'off', ...extra },
  });
  const selected = run('learned-selected');
  expect(selected.status).toBe(0);
  expect(selected.stdout).not.toContain('Keep output lean');
  const control = run('learned-control', { TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL: '' });
  expect(control.status).toBe(0);
  expect(control.stdout).toContain('Keep output lean');
  expect(run('learned-forced', { TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: 'on' }).stdout).toContain('Keep output lean');
  const states = readdirSync(join(dir, 'states')).filter((n) => n.endsWith('.json')).map((n) => readFileSync(join(dir, 'states', n), 'utf8'));
  expect(states.some((s) => JSON.parse(s).taskClass?.source === 'local-model')).toBe(true);
  expect(states.join('')).not.toContain('PRIVATE-CONTENT');
  expect(readFileSync(join(dir, 'home', 'task-classes.jsonl'), 'utf8')).not.toContain('PRIVATE-CONTENT');
});
