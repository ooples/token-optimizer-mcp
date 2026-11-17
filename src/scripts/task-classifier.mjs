#!/usr/bin/env node
/** Train or inspect an optional local task model; hooks do inference in Node. */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { localTaskClassifier, TASK_CLASSIFIER_ENV } from '../hooks-core/learned-task-class.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const value = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return null;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[at + 1];
};
try {
  const accepted = new Set(command === 'train' ? ['--input', '--output', '--python'] : ['--model']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    if (!accepted.has(args[i]) || seen.has(args[i])) throw new Error(`Unknown or duplicate option: ${args[i]}`);
    seen.add(args[i]);
    value(args[i]);
  }
  if (command === 'inspect') {
    const path = value('--model') || process.env[TASK_CLASSIFIER_ENV];
    const status = localTaskClassifier(path ? { [TASK_CLASSIFIER_ENV]: resolve(path) } : {});
    const { classify, ...diagnostic } = status;
    console.log(JSON.stringify(diagnostic, null, 2));
    if (!status.ok) process.exitCode = 1;
  } else if (command === 'train') {
    const input = value('--input');
    const output = resolve(value('--output') || join(process.env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer'), 'models', 'task-classifier.json'));
    const python = value('--python') || process.env.TOKEN_OPTIMIZER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const script = join(dirname(fileURLToPath(import.meta.url)), 'train-task-classifier.py');
    const result = spawnSync(python, [script, '--output', output, ...(input ? ['--input', resolve(input)] : [])], {
      stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
    else console.log(`To opt in, set ${TASK_CLASSIFIER_ENV} to ${output}`);
  } else {
    console.log('Usage: token-optimizer-task-classifier train [--input labels.jsonl] [--output model.json] [--python python3]\n       token-optimizer-task-classifier inspect [--model model.json]\n\nInput records: {"prompt":"...","before":"previous assistant text","label":"fix"}.\nTraining stays local. Python/scikit-learn are needed only for training; hooks use Node.');
    if (command && command !== '--help' && command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(`Task classifier: ${error.message || error}`);
  process.exitCode = 1;
}
