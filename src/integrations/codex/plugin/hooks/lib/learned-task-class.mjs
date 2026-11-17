// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/learned-task-class.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Optional local task classifier: word/bigram TF-IDF and a linear softmax head.
 * Runtime is Node only: no model endpoint, Python process or model download.
 * Models can contain private vocabulary and belong in the user's local home.
 */
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isTaskCategory, TaskCategory } from './task-class.mjs';
import { tableRow } from './task-settings.mjs';
import { isFsSafePath } from './paths.mjs';

export const TASK_CLASSIFIER_ENV = 'TOKEN_OPTIMIZER_TASK_CLASSIFIER_MODEL';
export const MODEL_FORMAT = 'token-optimizer-task-classifier/1';
export const MAX_MODEL_BYTES = 8 * 1024 * 1024;
const MAX_FEATURES = 15000;
const MAX_TEXT = 4000;

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e6);
}

/** Validate dimensions before inference; models are data, never executable code. */
export function validateTaskModel(model) {
  if (!model || model.format !== MODEL_FORMAT) throw new Error('Unsupported task-classifier model format');
  if (!Array.isArray(model.labels) || model.labels.length !== 7 || new Set(model.labels).size !== 7 ||
      !model.labels.every(isTaskCategory)) throw new Error('Model must name every task category exactly once');
  if (!Array.isArray(model.terms) || model.terms.length < 1 || model.terms.length > MAX_FEATURES ||
      new Set(model.terms).size !== model.terms.length ||
      !model.terms.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 200))
    throw new Error('Invalid task-classifier vocabulary');
  const n = model.terms.length;
  if (!finiteVector(model.idf, n) || !model.idf.every((v) => v >= 1 && v <= 100) ||
      !finiteVector(model.bias, 7) || !Array.isArray(model.weights) || model.weights.length !== 7 ||
      !model.weights.every((v) => finiteVector(v, 2 * n))) throw new Error('Invalid task-classifier coefficients');
  if (!Number.isFinite(model.contextWeight) || model.contextWeight < 0 || model.contextWeight > 1)
    throw new Error('Invalid task-classifier context weight');
  if (!Number.isFinite(model.switchThreshold) || model.switchThreshold < .5 || model.switchThreshold > 1)
    throw new Error('Invalid task-classifier setting-switch threshold');
  if (!Number.isFinite(model.minimumScore) || model.minimumScore < 0 || model.minimumScore > 1)
    throw new Error('Invalid task-classifier minimum score');
  return model;
}

/** Match the trainer's Unicode word tokens, unigram/bigram counts and L2 norm. */
export function taskFeatures(text, model, vocabulary = new Map(model.terms.map((t, i) => [t, i]))) {
  const words = String(text || '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const tokens = words.filter((word) => { const length = [...word].length; return length >= 2 && length <= 96; });
  const counts = new Map();
  const count = (term) => {
    const index = vocabulary.get(term);
    if (index !== undefined) counts.set(index, (counts.get(index) || 0) + 1);
  };
  for (let i = 0; i < tokens.length; i++) {
    count(tokens[i]);
    if (i) count(`${tokens[i - 1]} ${tokens[i]}`);
  }
  const values = [...counts].map(([i, n]) => [i, (1 + Math.log(n)) * model.idf[i]]);
  const norm = Math.sqrt(values.reduce((sum, [, v]) => sum + v * v, 0));
  return norm ? values.map(([i, v]) => [i, v / norm]) : [];
}

/** A pure predictor, also used to verify Python/Node parity before deployment. */
export function predictTask(model, prompt, before = '') {
  const vocabulary = new Map(model.terms.map((t, i) => [t, i]));
  const current = taskFeatures(String(prompt || '').slice(0, MAX_TEXT), model, vocabulary);
  const context = taskFeatures(String(before || '').slice(-MAX_TEXT), model, vocabulary);
  if (!current.length && !context.length) return null;
  const n = model.terms.length;
  const logits = model.bias.map((bias, row) => bias +
    current.reduce((sum, [i, v]) => sum + model.weights[row][i] * v, 0) +
    model.contextWeight * context.reduce((sum, [i, v]) => sum + model.weights[row][n + i] * v, 0));
  const max = Math.max(...logits);
  const exponentials = logits.map((v) => Math.exp(v - max));
  const total = exponentials.reduce((a, b) => a + b, 0);
  const probabilities = exponentials.map((v) => v / total);
  const ranked = probabilities.map((score, i) => ({ category: model.labels[i], score })).sort((a, b) => b.score - a.score);
  return { category: ranked[0].category, score: ranked[0].score, margin: ranked[0].score - ranked[1].score, probabilities };
}

function readModel(path) {
  if (!isAbsolute(path) || !isFsSafePath(path)) throw new Error('Task-classifier model path must be an absolute filesystem path');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MODEL_BYTES) throw new Error('Task-classifier model must be a regular file under 8 MiB');
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read !== buffer.length) throw new Error('Task-classifier model changed while reading');
    const raw = buffer.toString('utf8');
    return { model: validateTaskModel(JSON.parse(raw)), id: createHash('sha256').update(raw).digest('hex').slice(0, 12) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A diagnostic explains an unavailable opt-in model rather than claiming it ran. */
export function localTaskClassifier(env = process.env) {
  const path = String(env[TASK_CLASSIFIER_ENV] || '').trim();
  if (!path) return { enabled: false, ok: true, classify: null };
  try {
    const { model, id } = readModel(path);
    return {
      enabled: true, ok: true, id, features: model.terms.length,
      classify(prompt, messages = [], previous = null) {
        const last = messages.at(-1);
        const prediction = predictTask(model, prompt, last?.role === 'assistant' ? last.text : '');
        if (!prediction) return null;
        if (prediction.score < model.minimumScore || prediction.margin < .02) return null;
        // The score is a model posterior, not a guaranteed accuracy. Where a
        // category changes a setting, weak evidence retains the rule fallback.
        const row = JSON.stringify(tableRow(prediction.category));
        const changesDefaults = row !== JSON.stringify(tableRow(TaskCategory.UNKNOWN));
        const changesPrevious = isTaskCategory(previous?.category) && row !== JSON.stringify(tableRow(previous.category));
        if ((changesDefaults || changesPrevious) &&
            (prediction.score < model.switchThreshold || prediction.margin < .15)) return null;
        return { category: prediction.category, source: 'local-model', signals: [`local-model:${id}`] };
      },
    };
  } catch (error) {
    return { enabled: true, ok: false, classify: null, error: String(error.message || error) };
  }
}
