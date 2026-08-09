#!/usr/bin/env node
/**
 * Reproducible four-arm live-model evaluation runner.
 *
 * Runner profiles own the exact CLI flags because disabling all user config is
 * client/version-specific.  The harness owns everything that must remain the
 * same: task fixture, prompt, pair id, fresh graph/state, arm ordering, grading,
 * raw artifact schema, and the aggregate evidence record consumed by the UI.
 */

import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EXPERIMENT_ARMS } from '../hooks-core/experiment.mjs';
import { record, readEvidence } from '../hooks-core/metrics.mjs';
import { wikiDir, load as loadGraph } from '../hooks-core/wiki.mjs';
import { writeHarvested } from '../hooks-core/harvest-write.mjs';
import { ORIGIN_AGENT } from '../hooks-core/curate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    suite: join(ROOT, 'evals', 'task-suite.json'),
    repetitions: 1,
    output: join(ROOT, '.token-optimizer', 'evals', `run-${Date.now()}.jsonl`),
    graphDir: wikiDir(ROOT),
    dryRun: false,
    includeTranscript: false,
    keepWorkspaces: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--include-transcript') options.includeTranscript = true;
    else if (arg === '--keep-workspaces') options.keepWorkspaces = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      options[key] = value;
    }
  }
  options.repetitions = Math.max(1, Number(options.repetitions) || 1);
  return options;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const resolveFromRoot = (path) => isAbsolute(path) ? path : resolve(ROOT, path);

/** Latin rotation: each arm occupies each order position before repeating. */
export function evaluationSchedule(tasks, repetitions) {
  const schedule = [];
  for (const task of tasks) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const offset = repetition % EXPERIMENT_ARMS.length;
      const arms = EXPERIMENT_ARMS.map((_, index) =>
        EXPERIMENT_ARMS[(index + offset) % EXPERIMENT_ARMS.length]
      );
      for (const [order, arm] of arms.entries()) {
        schedule.push({ task, repetition, order, arm, pairId: `${task.id}-${repetition + 1}` });
      }
    }
  }
  return schedule;
}

function materialize(task) {
  const workspace = mkdtempSync(join(tmpdir(), `token-optimizer-eval-${task.id}-`));
  if (task.fixture) cpSync(resolveFromRoot(task.fixture), workspace, { recursive: true });
  return workspace;
}

function replacePlaceholders(value, context) {
  return String(value).replace(/\{(prompt|workspace|arm|taskId|pairId|model)\}/g, (_, key) =>
    String(context[key] ?? '')
  );
}

function execute(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: null, signal: null, timedOut, latencyMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}`.trim(),
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode, signal, timedOut, latencyMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function walkNumbers(value, output = {}) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number') output[key] = item;
    else if (item && typeof item === 'object') walkNumbers(item, output);
  }
  return output;
}

export function parseUsage(text, profile = {}) {
  const numbers = {};
  for (const line of String(text).split('\n')) {
    try { Object.assign(numbers, walkNumbers(JSON.parse(line))); } catch { /* non-JSON output */ }
  }
  const from = (...keys) => {
    for (const key of keys) if (Number.isFinite(numbers[key])) return numbers[key];
    return null;
  };
  const regexNumber = (pattern) => {
    if (!pattern) return null;
    const match = String(text).match(new RegExp(pattern, 'im'));
    const value = Number(String(match?.[1] || '').replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
  };
  return {
    uncachedInputTokens: from('uncached_input_tokens', 'uncachedInputTokens'),
    cachedInputTokens: from('cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens'),
    outputTokens: from('output_tokens', 'outputTokens'),
    totalTokens: from('total_tokens', 'totalTokens', 'tokens_used', 'tokensUsed')
      ?? regexNumber(profile.tokenPatterns?.total),
    costUsd: from('cost_usd', 'costUsd', 'total_cost_usd')
      ?? regexNumber(profile.tokenPatterns?.costUsd),
    toolCalls: from('tool_calls', 'toolCalls') ?? regexNumber(profile.tokenPatterns?.toolCalls),
    failedToolCalls: from('failed_tool_calls', 'failedToolCalls'),
  };
}

async function grade(task, run, workspace, graphDir, evidenceEvents) {
  const combined = `${run.stdout}\n${run.stderr}`;
  const grader = task.grader || {};
  const required = (grader.responseIncludes || []).every((value) =>
    combined.toLowerCase().includes(String(value).toLowerCase())
  );
  const forbidden = !(grader.responseExcludes || []).some((value) =>
    combined.toLowerCase().includes(String(value).toLowerCase())
  );
  let commandResult = null;
  if (grader.command) {
    commandResult = await execute(
      grader.command,
      grader.args || [],
      { cwd: workspace, env: { ...process.env, TOKEN_OPTIMIZER_EVAL_RESPONSE: run.stdout }, timeoutMs: 60_000 }
    );
  }
  let graphFinding = null;
  if (grader.graphFinding) {
    const graph = loadGraph(graphDir);
    graphFinding = [...graph.nodes.values()].some((node) =>
      node.kind === 'finding'
      && !node.retired
      && node.origin === 'agent'
      && typeof node.evidence === 'string'
      && typeof node.applicability === 'string'
      && ['verified', 'probable', 'speculative'].includes(node.confidenceLabel)
    );
  }
  const deliveredTokens = evidenceEvents
    .filter((event) => event.kind === 'inject')
    .reduce((sum, event) => sum + (event.deliveredTokens || 0), 0);
  const deliveryWithinLimit = grader.maxDeliveredTokens === undefined
    || deliveredTokens <= Number(grader.maxDeliveredTokens);
  return {
    correct: run.exitCode === 0 && !run.timedOut && required && forbidden
      && (!commandResult || commandResult.exitCode === 0)
      && (graphFinding === null || graphFinding)
      && deliveryWithinLimit,
    checks: {
      runnerExitedZero: run.exitCode === 0,
      requiredResponse: required,
      forbiddenResponseAbsent: forbidden,
      commandGrader: commandResult ? commandResult.exitCode === 0 : null,
      graphFinding,
      deliveryWithinLimit,
    },
  };
}

function seedGraph(task, rootWorkspace, activeWorkspace, graphDir, sharedGraph) {
  if (!Array.isArray(task.seedFindings)) return [];
  const seedRoot = task.seedWorkspace
    ? join(rootWorkspace, task.seedWorkspace)
    : activeWorkspace;
  const findings = task.seedFindings.map((finding) => ({
    ...finding,
    anchors: finding.anchors.map((anchor) => join(seedRoot, anchor)),
  }));
  const seedGraphDir = seedRoot === activeWorkspace
    ? graphDir
    : join(seedRoot, '.token-optimizer', 'wiki');
  const previousShared = process.env.TOKEN_OPTIMIZER_SHARED_DIR;
  process.env.TOKEN_OPTIMIZER_SHARED_DIR = sharedGraph;
  try {
    const keys = writeHarvested(seedGraphDir, findings, {
      sessionId: 'seed-session',
      origin: ORIGIN_AGENT,
      projectRoot: seedRoot,
    });
    for (const feedback of task.seedFeedback || []) {
      const findingId = keys[feedback.findingIndex || 0];
      if (!findingId) continue;
      record(graphDir, {
        kind: 'finding-feedback',
        findingId,
        rating: feedback.rating,
        reason: feedback.reason || 'pre-registered adversarial fixture',
        episodeId: 'seed-session',
      });
    }
    return keys;
  } finally {
    if (previousShared === undefined) delete process.env.TOKEN_OPTIMIZER_SHARED_DIR;
    else process.env.TOKEN_OPTIMIZER_SHARED_DIR = previousShared;
  }
  return [];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suite = readJson(resolveFromRoot(options.suite));
  let tasks = suite.tasks || [];
  if (options.tasks) {
    const selected = new Set(String(options.tasks).split(',').map((value) => value.trim()));
    tasks = tasks.filter((task) => selected.has(task.id));
  }
  if (!tasks.length) throw new Error('no evaluation tasks selected');
  const schedule = evaluationSchedule(tasks, options.repetitions);

  if (options.dryRun) {
    process.stdout.write(JSON.stringify({ suite: suite.name, runs: schedule.map(({ task, ...run }) => ({ taskId: task.id, ...run })) }, null, 2));
    return;
  }
  if (!options.runner || !options.client) {
    throw new Error('--runner and --client are required unless --dry-run is used');
  }
  const runners = readJson(resolveFromRoot(options.runner));
  const profile = runners[options.client];
  if (!profile) throw new Error(`runner profile not found for ${options.client}`);
  if (!Array.isArray(profile.armArgs?.baseline) || !profile.baselineIsolation) {
    throw new Error('runner must declare baseline armArgs and baselineIsolation; an ordinary treated session is not a baseline');
  }

  const output = resolveFromRoot(options.output);
  mkdirSync(dirname(output), { recursive: true });
  const aggregateGraph = resolveFromRoot(options.graphDir);
  mkdirSync(aggregateGraph, { recursive: true });

  for (const item of schedule) {
    const rootWorkspace = materialize(item.task);
    const workspace = item.task.workspace
      ? join(rootWorkspace, item.task.workspace)
      : rootWorkspace;
    const isolatedGraph = join(workspace, '.token-optimizer', 'wiki');
    const sharedGraph = join(rootWorkspace, '.token-optimizer', 'shared');
    mkdirSync(isolatedGraph, { recursive: true });
    seedGraph(item.task, rootWorkspace, workspace, isolatedGraph, sharedGraph);
    for (const mutation of item.task.mutateAfterSeed || []) {
      appendFileSync(join(rootWorkspace, mutation.path), mutation.append || '\n// changed after finding\n');
    }
    const context = {
      prompt: item.task.prompt,
      workspace,
      arm: item.arm,
      taskId: item.task.id,
      pairId: item.pairId,
      model: options.model || profile.model || '',
    };
    // Keep arm-level isolation switches ahead of the prompt. Several CLIs stop
    // parsing options once their positional prompt begins.
    const args = [...(profile.armArgs[item.arm] || []), ...(profile.args || [])]
      .map((arg) => replacePlaceholders(arg, context));
    const env = {
      ...process.env,
      ...(profile.env || {}),
      TOKEN_OPTIMIZER_EXPERIMENT_ARM: item.arm,
      TOKEN_OPTIMIZER_EPISODE_ID: `${item.pairId}-${item.arm}`,
      TOKEN_OPTIMIZER_PAIR_ID: item.pairId,
      TOKEN_OPTIMIZER_TASK_ID: item.task.id,
      TOKEN_OPTIMIZER_MODEL: context.model,
      TOKEN_OPTIMIZER_CLIENT_VERSION: profile.version || '',
      TOKEN_OPTIMIZER_WIKI_DIR: isolatedGraph,
      TOKEN_OPTIMIZER_SHARED_DIR: sharedGraph,
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.token-optimizer', 'state'),
    };
    const run = await execute(profile.command, args, {
      cwd: workspace,
      env,
      timeoutMs: Number(profile.timeoutMs) || 600_000,
    });
    const localEvidence = readEvidence(isolatedGraph);
    const grading = await grade(item.task, run, workspace, isolatedGraph, localEvidence);
    const usage = parseUsage(`${run.stdout}\n${run.stderr}`, profile);
    const result = {
      kind: 'eval-run',
      schemaVersion: 2,
      suite: suite.name,
      suiteVersion: suite.version,
      taskId: item.task.id,
      taskFamily: item.task.family,
      pairId: item.pairId,
      repetition: item.repetition,
      order: item.order,
      arm: item.arm,
      client: options.client,
      clientVersion: profile.version || null,
      model: context.model || null,
      modelVersion: profile.modelVersion || null,
      repoCommit: process.env.GITHUB_SHA || null,
      promptHash: hash(item.task.prompt),
      fixtureHash: hash(JSON.stringify(item.task.seedFindings || []) + (item.task.fixture || '')),
      correct: grading.correct,
      grader: grading.checks,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      latencyMs: run.latencyMs,
      ...usage,
      injectedTokens: localEvidence
        .filter((event) => event.kind === 'inject')
        .reduce((sum, event) => sum + (event.deliveredTokens || 0), 0),
      toolCalls: usage.toolCalls ?? localEvidence.filter((event) => ['tool-outcome', 'mcp-tool'].includes(event.kind)).length,
      failedToolCalls: usage.failedToolCalls
        ?? localEvidence.filter((event) => ['tool-outcome', 'mcp-tool'].includes(event.kind) && event.success === false).length,
      harmfulFindings: localEvidence.filter((event) => event.kind === 'finding-feedback' && event.rating === 'harmful').length,
      stdoutHash: hash(run.stdout),
      stderrHash: hash(run.stderr),
      ...(options.includeTranscript ? { stdout: run.stdout, stderr: run.stderr } : {}),
    };
    appendFileSync(output, `${JSON.stringify(result)}\n`);
    record(aggregateGraph, result);
    process.stdout.write(`${grading.correct ? 'PASS' : 'FAIL'} ${item.task.id} ${item.arm} (${run.latencyMs}ms)\n`);

    if (!options.keepWorkspaces) rmSync(rootWorkspace, { recursive: true, force: true });
  }
  process.stdout.write(`Evidence artifact: ${output}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
