#!/usr/bin/env node
/**
 * Paired live-model evaluation for cross-client mistake transfer.
 *
 * One producer encounters a required dead end and is responsible for semantic
 * harvesting. Every consumer arm then receives the SAME frozen post-producer
 * workspace. The only intended difference is its graph: empty, natural,
 * oracle, irrelevant, or explicitly stale. Grading uses filesystem state,
 * fixture audit sentinels, and tool traces; model prose is never the oracle.
 */

import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseRunIdentity, parseUsage } from './run-evidence-eval.mjs';
import { record, readEvidence } from '../hooks-core/metrics.mjs';
import { load as loadGraph, putNode, wikiDir } from '../hooks-core/wiki.mjs';
import { writeHarvested } from '../hooks-core/harvest-write.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HANDOFF_ARMS = Object.freeze(['empty', 'natural', 'oracle', 'irrelevant', 'stale']);

const git = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true,
});
const status = spawnSync('git', ['status', '--porcelain'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true,
});
const PROVENANCE = {
  commit: git.status === 0 ? git.stdout.trim() : null,
  dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
};

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fromRoot = (path) => isAbsolute(path) ? path : resolve(ROOT, path);

function parseArgs(argv) {
  const options = {
    suite: join(ROOT, 'evals', 'handoff-suite.json'),
    repetitions: 1,
    output: join(ROOT, '.token-optimizer', 'evals', `handoff-${Date.now()}.jsonl`),
    graphDir: wikiDir(ROOT),
    dryRun: false,
    keepWorkspaces: false,
    includeTranscript: false,
  };
  const valueOptions = new Set([
    'suite', 'repetitions', 'output', 'graphDir', 'scenarios', 'arms',
    'runner', 'producer', 'consumer', 'producerModel', 'consumerModel',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep-workspaces') options.keepWorkspaces = true;
    else if (arg === '--include-transcript') options.includeTranscript = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!valueOptions.has(key)) throw new Error(`unknown option: ${arg}`);
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      options[key] = value;
    }
  }
  options.repetitions = Math.max(1, Number(options.repetitions) || 1);
  return options;
}

/** Generalized cyclic Latin rotation for any declared arm count. */
export function handoffSchedule(scenarios, repetitions, arms = HANDOFF_ARMS) {
  const schedule = [];
  for (const scenario of scenarios) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const order = arms.map((_, index) => arms[(index + repetition) % arms.length]);
      schedule.push({
        scenario,
        repetition,
        pairId: `${scenario.id}-${repetition + 1}`,
        arms: order,
      });
    }
  }
  return schedule;
}

function replace(value, context) {
  return String(value).replace(
    /\{(prompt|workspace|phase|client|model|scenarioId|pairId|episodeId|graphDir|graphDirToml|stateDir|stateDirToml|auditPath|auditPathToml)\}/g,
    (_, key) => String(context[key] ?? '')
  );
}

function execute(command, args, { cwd, env, timeoutMs }) {
  return new Promise((finish) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      settle({
        exitCode: null, signal: null, timedOut, latencyMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}`.trim(),
      });
    });
    child.on('close', (exitCode, signal) => {
      settle({
        exitCode, signal, timedOut, latencyMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function toolObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  const type = String(value.type || value.kind || '');
  if (
    type === 'tool_use'
    || type === 'command_execution'
    || type === 'file_change'
    || type === 'mcp_tool_call'
    || type === 'tool-outcome'
    || type === 'mcp-tool'
  ) out.push(value);
  for (const child of Object.values(value)) toolObjects(child, out);
  return out;
}

/** Redacted tool trace: only action class, command, path, outcome, and order. */
export function extractToolTrace(text, evidence = []) {
  const objects = [];
  for (const line of String(text).split('\n')) {
    try { toolObjects(JSON.parse(line), objects); } catch { /* mixed CLI output */ }
  }
  for (const event of evidence) toolObjects(event, objects);
  return objects.map((value, order) => {
    const input = value.input || value.tool_input || value.arguments || value.item || {};
    const command = input.command || value.command || input.cmd || null;
    const paths = [
      input.file_path, input.path, value.anchor, value.path,
      ...(Array.isArray(value.changes) ? value.changes.map((change) => change.path) : []),
    ].filter((item) => typeof item === 'string');
    return {
      order,
      tool: value.name || value.toolName || value.tool_name || value.type || value.kind || null,
      command: command == null ? null : String(command),
      paths,
      success: value.success ?? (value.status === 'failed' ? false : null),
      at: Number(value.at) || null,
    };
  });
}

/** Keys acknowledged by successful wiki_write tool results in a CLI stream. */
export function extractAcceptedFindingIds(text) {
  const accepted = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') && trimmed.length < 100_000) {
        try { visit(JSON.parse(trimmed)); } catch { /* ordinary tool text */ }
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (
      value.success === true
      && Number(value.written) > 0
      && Array.isArray(value.keys)
    ) {
      for (const key of value.keys) if (typeof key === 'string') accepted.add(key);
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const line of String(text).split('\n')) {
    try { visit(JSON.parse(line)); } catch { /* mixed CLI output */ }
  }
  return [...accepted];
}

const includes = (value, fragment) =>
  String(value || '').toLowerCase().includes(String(fragment).toLowerCase());

export function targetFindingMatches(finding, target) {
  if (!finding || finding.kind !== 'finding' || finding.retired) return false;
  const searchable = [
    finding.claim, finding.evidence, finding.applicability,
    ...(finding.invalidators || []), finding.trigger,
  ].join(' ').toLowerCase();
  const first = (target.claimAny || []).some((term) => searchable.includes(String(term).toLowerCase()));
  const second = (target.claimAnySecondary || []).some(
    (term) => searchable.includes(String(term).toLowerCase())
  );
  return first && second;
}

function isTargetFindingContract(node) {
  return node.origin === 'agent'
    && typeof node.evidence === 'string' && Boolean(node.evidence.trim())
    && typeof node.applicability === 'string' && Boolean(node.applicability.trim())
    && ['verified', 'probable', 'speculative'].includes(node.confidenceLabel)
    && Array.isArray(node.invalidators) && node.invalidators.length > 0
    && typeof node.scope === 'string' && Boolean(node.scope);
}

export function diagnoseNaturalFinding(finding, target) {
  const searchable = [
    finding?.claim, finding?.evidence, finding?.applicability,
    ...(finding?.invalidators || []), finding?.trigger,
  ].join(' ').toLowerCase();
  return {
    key: finding?.key || null,
    targetPrimaryMatch: (target.claimAny || []).some(
      (term) => searchable.includes(String(term).toLowerCase())
    ),
    targetSecondaryMatch: (target.claimAnySecondary || []).some(
      (term) => searchable.includes(String(term).toLowerCase())
    ),
    originAgent: finding?.origin === 'agent',
    hasEvidence: typeof finding?.evidence === 'string' && Boolean(finding.evidence.trim()),
    hasApplicability:
      typeof finding?.applicability === 'string' && Boolean(finding.applicability.trim()),
    calibratedConfidence: ['verified', 'probable', 'speculative'].includes(
      finding?.confidenceLabel
    ),
    invalidatorCount: Array.isArray(finding?.invalidators) ? finding.invalidators.length : 0,
    hasScope: typeof finding?.scope === 'string' && Boolean(finding.scope),
    type: finding?.type || null,
    claimHash: finding?.claim ? hash(finding.claim) : null,
  };
}

export function findNaturalCapture(graph, target) {
  return [...graph.nodes.values()].filter(
    (node) => targetFindingMatches(node, target) && isTargetFindingContract(node)
  );
}

function traceContains(trace, pattern) {
  return trace.some((action) =>
    pattern.test(String(action.command || ''))
    || action.paths.some((path) => pattern.test(String(path)))
  );
}

function traceCommandContains(trace, pattern) {
  return trace.some((action) => pattern.test(String(action.command || '')));
}

function readFixtureJson(workspace, path) {
  try { return JSON.parse(readFileSync(join(workspace, path), 'utf8')); } catch { return null; }
}

function readFixtureText(workspace, path) {
  try { return readFileSync(join(workspace, path), 'utf8').trim(); } catch { return null; }
}

/** Hidden behavioral grader; it never scores claims made in the final answer. */
export function gradeBehavior(scenario, phase, workspace, audit, trace) {
  const target = phase === 'producer'
    ? scenario.grader.producerTarget
    : scenario.grader.consumerTarget;
  let correct = false;
  let mistakeAttempted = false;
  let mistakeExecuted = false;
  let proof = false;

  if (scenario.grader.kind === 'verification') {
    const bad = new RegExp(`verify-${target}\\.mjs`, 'i');
    mistakeAttempted = traceCommandContains(trace, bad);
    mistakeExecuted = audit.some(
      (event) => event.kind === 'unsupported-verification' && event.target === target
    );
    proof = audit.some(
      (event) => event.kind === 'supported-verification' && event.target === target && event.passed
    );
    correct = readFixtureJson(workspace, `src/${target}.json`)?.state === 'ready' && proof;
  } else if (scenario.grader.kind === 'generated') {
    const generated = new RegExp(`clients[\\\\/]${target}[\\\\/]policy\\.txt`, 'i');
    mistakeAttempted = traceContains(trace, generated);
    mistakeExecuted = mistakeAttempted;
    const synchronized = audit.some(
      (event) => event.kind === 'sync-check' && event.synchronized === true
    );
    const source = readFixtureText(workspace, `source/${target}-policy.txt`);
    const client = readFixtureText(workspace, `clients/${target}/policy.txt`);
    proof = synchronized;
    correct = source === 'modern' && client === 'modern' && synchronized;
  } else if (scenario.grader.kind === 'validation') {
    const bad = new RegExp(`check-${target}\\.mjs`, 'i');
    mistakeAttempted = traceCommandContains(trace, bad);
    mistakeExecuted = audit.some(
      (event) => event.kind === 'false-positive-validation' && event.target === target
    );
    proof = audit.some(
      (event) => event.kind === 'scoped-validation'
        && event.target === target && event.exercised && event.passed
    );
    correct = readFixtureJson(workspace, `targets/${target}.json`)?.ready === true && proof;
  }

  return {
    correct,
    firstPass: correct && !mistakeExecuted,
    mistakeAttempted,
    mistakeExecuted,
    proof,
  };
}

function materialize(fixture, prefix) {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fromRoot(fixture), workspace, { recursive: true });
  return workspace;
}

function frozenSnapshot(producerWorkspace, pairRoot) {
  const frozen = join(pairRoot, 'frozen-workspace');
  cpSync(producerWorkspace, frozen, { recursive: true });
  for (const name of ['.git', '.claude', '.codex', '.token-optimizer']) {
    rmSync(join(frozen, name), { recursive: true, force: true });
  }
  return frozen;
}

function copyDir(source, destination) {
  mkdirSync(destination, { recursive: true });
  if (existsSync(source)) cpSync(source, destination, { recursive: true });
}

function seedArm(arm, scenario, workspace, graphDir) {
  if (arm === 'empty' || arm === 'natural') return [];
  const source = arm === 'irrelevant' ? scenario.irrelevantFinding : scenario.oracleFinding;
  const finding = {
    ...source,
    ...(arm === 'stale' ? { type: 'finding' } : {}),
    anchors: source.anchors.map((anchor) => join(workspace, anchor)),
  };
  const keys = writeHarvested(graphDir, [finding], {
    sessionId: `${arm}-control`,
    projectRoot: workspace,
  });
  if (arm === 'stale') {
    const graph = loadGraph(graphDir);
    const node = [...graph.nodes.values()].find((candidate) => candidate.key === keys[0]);
    if (node) {
      putNode(graphDir, {
        ...node,
        kind: 'finding',
        key: node.key,
        stale: true,
        staleReason: 'pre-registered stale control',
        diff: '- prior control evidence\n+ changed control evidence',
      });
    }
  }
  return keys;
}

export function graphDigest(dir) {
  if (!existsSync(dir)) return hash('empty');
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(`${relative(dir, path)}\0${readFileSync(path)}`);
    }
  };
  visit(dir);
  return hash(files.sort().join('\0'));
}

export async function runClient({
  profile, client, model, prompt, phase, scenario, pairId, workspace, graphDir, auditPath,
}) {
  const episodeId = `${pairId}-${phase}-${client}`;
  const stateDir = join(dirname(graphDir), 'state');
  const context = {
    prompt,
    workspace,
    phase,
    client,
    model,
    scenarioId: scenario.id,
    pairId,
    episodeId,
    graphDir,
    graphDirToml: graphDir.replace(/\\/g, '/'),
    stateDir,
    stateDirToml: stateDir.replace(/\\/g, '/'),
    auditPath,
    auditPathToml: auditPath.replace(/\\/g, '/'),
  };
  const args = [...(profile.fullArgs || []), ...(profile.args || [])]
    .map((arg) => replace(arg, context));
  const env = {
    ...process.env,
    ...(profile.env || {}),
    TOKEN_OPTIMIZER_EXPERIMENT_ARM: 'full',
    TOKEN_OPTIMIZER_EPISODE_ID: episodeId,
    TOKEN_OPTIMIZER_PAIR_ID: pairId,
    TOKEN_OPTIMIZER_TASK_ID: scenario.id,
    TOKEN_OPTIMIZER_MODEL: model || profile.model || '',
    TOKEN_OPTIMIZER_CLIENT_VERSION: profile.version || '',
    TOKEN_OPTIMIZER_WIKI_DIR: graphDir,
    TOKEN_OPTIMIZER_SHARED_DIR: graphDir,
    TOKEN_OPTIMIZER_STATE_DIR: stateDir,
    TOKEN_OPTIMIZER_EVAL_AUDIT: auditPath,
    TOKEN_OPTIMIZER_EVAL_WRITER_ID: episodeId,
    TOKEN_OPTIMIZER_EVAL_SCENARIO_ID: scenario.id,
    TOKEN_OPTIMIZER_EVAL_PHASE: phase,
  };
  const run = await execute(profile.command, args, {
    cwd: workspace,
    env,
    timeoutMs: Number(profile.timeoutMs) || 600_000,
  });
  const evidence = readEvidence(graphDir).filter((event) => event.episodeId === episodeId);
  const trace = extractToolTrace(`${run.stdout}\n${run.stderr}`, evidence);
  const acceptedFindingIds = extractAcceptedFindingIds(`${run.stdout}\n${run.stderr}`);
  return { run, evidence, trace, acceptedFindingIds, episodeId };
}

function deliveryGrade(evidence, findingIds, audit, behavior) {
  const relevant = evidence.filter((event) =>
    event.kind === 'inject'
    && (event.findingIds || []).some((id) => findingIds.includes(id))
  );
  const firstMistakeAt = audit.find((event) => {
    if (behavior.mistakeExecuted && ['unsupported-verification', 'false-positive-validation'].includes(event.kind)) return true;
    return behavior.mistakeExecuted && event.kind === 'sync-check' && event.synchronized === false;
  })?.at ?? null;
  const first = relevant.sort((a, b) => (a.at || 0) - (b.at || 0))[0] || null;
  return {
    delivered: Boolean(first),
    surface: first?.surface || null,
    injectionId: first?.injectionId || null,
    deliveredTokens: relevant.reduce((sum, event) => sum + (event.deliveredTokens || 0), 0),
    beforeFirstExecutedMistake: first
      ? (firstMistakeAt === null || Number(first.at) <= Number(firstMistakeAt))
      : null,
  };
}

function safeEvidence(event) {
  const { anchor, cwd, projectRoot, ...safe } = event;
  return {
    ...safe,
    anchorHash: anchor ? hash(anchor) : undefined,
    cwdHash: cwd ? hash(cwd) : undefined,
    projectRootHash: projectRoot ? hash(projectRoot) : undefined,
  };
}

function validateProfile(profile, name) {
  if (!profile || !profile.command || !Array.isArray(profile.args)) {
    throw new Error(`runner profile ${name} must declare command and args`);
  }
  if (!profile.treatmentConfiguration) {
    throw new Error(`runner profile ${name} must document treatmentConfiguration`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suite = json(fromRoot(options.suite));
  let scenarios = suite.scenarios || [];
  if (options.scenarios) {
    const selected = new Set(String(options.scenarios).split(',').map((item) => item.trim()));
    scenarios = scenarios.filter((scenario) => selected.has(scenario.id));
  }
  if (!scenarios.length) throw new Error('no handoff scenarios selected');
  const arms = options.arms
    ? String(options.arms).split(',').map((item) => item.trim()).filter(Boolean)
    : (suite.arms || HANDOFF_ARMS);
  const unknownArms = arms.filter((arm) => !HANDOFF_ARMS.includes(arm));
  if (!arms.length || unknownArms.length) {
    throw new Error(
      `--arms must select one or more of ${HANDOFF_ARMS.join(', ')}; unknown: ${unknownArms.join(', ')}`
    );
  }
  const schedule = handoffSchedule(scenarios, options.repetitions, arms);
  if (options.dryRun) {
    process.stdout.write(JSON.stringify({
      suite: suite.name,
      runs: schedule.map(({ scenario, ...item }) => ({ scenarioId: scenario.id, ...item })),
    }, null, 2));
    return;
  }
  if (!options.runner || !options.producer || !options.consumer) {
    throw new Error('--runner, --producer, and --consumer are required unless --dry-run is used');
  }
  const runners = json(fromRoot(options.runner));
  const producerProfile = runners[options.producer];
  const consumerProfile = runners[options.consumer];
  validateProfile(producerProfile, options.producer);
  validateProfile(consumerProfile, options.consumer);
  const aggregateDir = fromRoot(options.graphDir);
  const output = fromRoot(options.output);
  mkdirSync(aggregateDir, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });

  for (const item of schedule) {
    const pairRoot = mkdtempSync(join(tmpdir(), `token-optimizer-handoff-${item.pairId}-`));
    const producerWorkspace = materialize(item.scenario.fixture, `producer-${item.pairId}-`);
    try {
    const producerGraph = join(pairRoot, 'producer-graph');
    const producerAuditPath = join(pairRoot, 'producer-audit.jsonl');
    mkdirSync(producerGraph, { recursive: true });
    const producer = await runClient({
      profile: producerProfile,
      client: options.producer,
      model: options.producerModel || producerProfile.model,
      prompt: item.scenario.producerPrompt,
      phase: 'producer',
      scenario: item.scenario,
      pairId: item.pairId,
      workspace: producerWorkspace,
      graphDir: producerGraph,
      auditPath: producerAuditPath,
    });
    const producerAudit = readJsonl(producerAuditPath);
    const producerBehavior = gradeBehavior(
      item.scenario, 'producer', producerWorkspace, producerAudit, producer.trace
    );
    const producerGraphState = loadGraph(producerGraph);
    const producerAgentFindings = [...producerGraphState.nodes.values()].filter(
      (finding) => finding.kind === 'finding' && finding.origin === 'agent' && !finding.retired
    );
    const naturalFindings = findNaturalCapture(producerGraphState, item.scenario.targetFinding);
    const naturalFindingIds = naturalFindings.map((finding) => finding.key);
    const naturalCaptureDiagnostics = producerAgentFindings.map(
      (finding) => diagnoseNaturalFinding(finding, item.scenario.targetFinding)
    );
    for (const event of producer.evidence) record(aggregateDir, {
      ...safeEvidence(event),
      evidenceSource: 'live-handoff-producer-trace',
    });
    const frozen = frozenSnapshot(producerWorkspace, pairRoot);

    for (const [order, arm] of item.arms.entries()) {
      const workspace = join(pairRoot, `consumer-${order}-${arm}`);
      cpSync(frozen, workspace, { recursive: true });
      const graphDir = join(pairRoot, `graph-${order}-${arm}`);
      if (arm === 'natural') copyDir(producerGraph, graphDir);
      else mkdirSync(graphDir, { recursive: true });
      const seededFindingIds = seedArm(arm, item.scenario, workspace, graphDir);
      const auditPath = join(pairRoot, `audit-${order}-${arm}.jsonl`);
      const consumer = await runClient({
        profile: consumerProfile,
        client: options.consumer,
        model: options.consumerModel || consumerProfile.model,
        prompt: item.scenario.consumerPrompt,
        phase: `consumer-${arm}`,
        scenario: item.scenario,
        pairId: item.pairId,
        workspace,
        graphDir,
        auditPath,
      });
      const audit = readJsonl(auditPath);
      const behavior = gradeBehavior(item.scenario, 'consumer', workspace, audit, consumer.trace);
      const expectedFindingIds = arm === 'natural' ? naturalFindingIds : seededFindingIds;
      const delivery = deliveryGrade(consumer.evidence, expectedFindingIds, audit, behavior);
      const observed = parseRunIdentity(consumer.run.stdout);
      const usage = parseUsage(`${consumer.run.stdout}\n${consumer.run.stderr}`, consumerProfile);
      const producerIdentity = parseRunIdentity(producer.run.stdout);
      const producerUsage = parseUsage(
        `${producer.run.stdout}\n${producer.run.stderr}`, producerProfile
      );
      const result = {
        kind: 'handoff-run',
        schemaVersion: 3,
        suite: suite.name,
        suiteVersion: suite.version,
        scenarioId: item.scenario.id,
        scenarioFamily: item.scenario.family,
        pairId: item.pairId,
        repetition: item.repetition,
        order,
        arm,
        producer: {
          client: options.producer,
          clientVersion: producerIdentity.clientVersion || producerProfile.version || null,
          model: options.producerModel || producerProfile.model || null,
          modelVersion: producerIdentity.modelVersion || producerProfile.modelVersion || null,
          sessionId: producerIdentity.sessionId,
          correct: producerBehavior.correct,
          mistakeAttempted: producerBehavior.mistakeAttempted,
          mistakeExecuted: producerBehavior.mistakeExecuted,
          captureSuccess: naturalFindings.length > 0,
          capturedFindingIds: naturalFindingIds,
          acceptedFindingIds: producer.acceptedFindingIds,
          naturalCaptureDiagnostics,
          latencyMs: producer.run.latencyMs,
          exitCode: producer.run.exitCode,
          timedOut: producer.run.timedOut,
          ...producerUsage,
          toolCalls: producerUsage.toolCalls ?? producer.trace.length,
          failedToolCalls: producerUsage.failedToolCalls
            ?? producer.trace.filter((action) => action.success === false).length,
        },
        consumer: {
          client: options.consumer,
          clientVersion: observed.clientVersion || consumerProfile.version || null,
          model: options.consumerModel || consumerProfile.model || null,
          modelVersion: observed.modelVersion || consumerProfile.modelVersion || null,
          sessionId: observed.sessionId,
          ...behavior,
          latencyMs: consumer.run.latencyMs,
          exitCode: consumer.run.exitCode,
          timedOut: consumer.run.timedOut,
          ...usage,
          toolCalls: usage.toolCalls ?? consumer.trace.length,
          failedToolCalls: usage.failedToolCalls
            ?? consumer.trace.filter((action) => action.success === false).length,
        },
        delivery,
        expectedFindingIds,
        naturalCaptureMissing: arm === 'natural' && naturalFindings.length === 0,
        graphHash: graphDigest(graphDir),
        repoCommit: process.env.GITHUB_SHA || PROVENANCE.commit,
        workingTreeDirty: PROVENANCE.dirty,
        producerPromptHash: hash(item.scenario.producerPrompt),
        consumerPromptHash: hash(item.scenario.consumerPrompt),
        fixtureHash: hash(
          JSON.stringify(item.scenario.grader) + graphDigest(fromRoot(item.scenario.fixture))
        ),
        stdoutHash: hash(consumer.run.stdout),
        stderrHash: hash(consumer.run.stderr),
        ...(options.includeTranscript
          ? { stdout: consumer.run.stdout, stderr: consumer.run.stderr }
          : {}),
      };
      appendFileSync(output, `${JSON.stringify(result)}\n`);
      record(aggregateDir, result);
      for (const event of consumer.evidence) record(aggregateDir, {
        ...safeEvidence(event),
        evidenceSource: 'live-handoff-trace',
      });
      process.stdout.write(
        `${behavior.correct ? 'PASS' : 'FAIL'} ${item.scenario.id} `
        + `${options.producer}->${options.consumer} ${arm} `
        + `(mistake=${behavior.mistakeExecuted ? 'yes' : 'no'}, capture=${naturalFindings.length ? 'yes' : 'no'})\n`
      );
    }

    } finally {
      rmSync(producerWorkspace, { recursive: true, force: true });
      if (!options.keepWorkspaces) rmSync(pairRoot, { recursive: true, force: true });
    }
  }
  process.stdout.write(`Handoff evidence artifact: ${output}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
