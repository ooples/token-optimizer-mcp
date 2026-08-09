#!/usr/bin/env node
/** Live concurrency proof: several producer agents, one graph, one later client. */

import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  extractToolTrace, findNaturalCapture, gradeBehavior, readJsonl, runClient,
} from './run-handoff-eval.mjs';
import { parseRunIdentity, parseUsage } from './run-evidence-eval.mjs';
import { audit as auditGraph } from '../hooks-core/curate.mjs';
import { record } from '../hooks-core/metrics.mjs';
import { load as loadGraph, wikiDir } from '../hooks-core/wiki.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const fromRoot = (path) => isAbsolute(path) ? path : resolve(ROOT, path);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
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

function options(argv) {
  const out = {
    suite: join(ROOT, 'evals', 'handoff-suite.json'),
    repetitions: 1,
    output: join(ROOT, '.token-optimizer', 'evals', `concurrent-handoff-${Date.now()}.jsonl`),
    graphDir: wikiDir(ROOT),
    keepWorkspaces: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--keep-workspaces') out.keepWorkspaces = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      out[key] = value;
    }
  }
  out.repetitions = Math.max(1, Number(out.repetitions) || 1);
  return out;
}

function parseIntegrityFile(path) {
  if (!existsSync(path)) return { lines: 0, malformed: 0 };
  let lines = 0;
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    lines += 1;
    try { JSON.parse(line); } catch { malformed += 1; }
  }
  return { lines, malformed };
}

export function graphIntegrity(graphDir, expectedFindingIds = []) {
  const graph = loadGraph(graphDir);
  const audit = auditGraph(graph);
  const log = parseIntegrityFile(join(graphDir, 'graph.jsonl'));
  const snapshots = parseIntegrityFile(join(graphDir, 'snapshots.jsonl'));
  const activeKeys = new Set(
    [...graph.nodes.values()].filter((node) => node.kind === 'finding' && !node.retired)
      .map((node) => node.key)
  );
  const missingAcceptedWrites = expectedFindingIds.filter((key) => !activeKeys.has(key));
  const acceptanceObservable = expectedFindingIds.length > 0;
  return {
    graphLines: log.lines,
    snapshotLines: snapshots.lines,
    malformedLines: log.malformed + snapshots.malformed,
    orphanedFindings: audit.orphaned.length,
    contradictedFindings: audit.contradicted.length,
    activeFindings: activeKeys.size,
    acceptedWritesObserved: expectedFindingIds.length,
    acceptanceObservable,
    missingAcceptedWrites,
    zeroLoss: acceptanceObservable && missingAcceptedWrites.length === 0,
    parseable: log.malformed + snapshots.malformed === 0,
  };
}

function combinedPrompt() {
  return [
    'Continue all three independent beta follow-ups in this fixture.',
    '1. Set src/beta.json state to ready and verify beta with the supported project command.',
    '2. Change the beta policy from legacy to modern through its maintainable source of truth, regenerate outputs, and verify synchronization.',
    '3. Set targets/beta.json ready to true and validate it with evidence that beta was actually exercised.',
    'Avoid repeating dead ends already established by earlier agents. Complete and verify every item.',
  ].join(' ');
}

function validateProfile(profile, name) {
  if (!profile?.command || !Array.isArray(profile.args) || !profile.treatmentConfiguration) {
    throw new Error(`runner profile ${name} must declare command, args, and treatmentConfiguration`);
  }
}

async function main() {
  const cli = options(process.argv.slice(2));
  if (!cli.runner || !cli.producer || !cli.consumer) {
    throw new Error('--runner, --producer, and --consumer are required');
  }
  const suite = readJson(fromRoot(cli.suite));
  const scenarios = suite.scenarios || [];
  if (scenarios.length < 3) throw new Error('concurrency suite requires at least three scenarios');
  const runners = readJson(fromRoot(cli.runner));
  const producerProfile = runners[cli.producer];
  const consumerProfile = runners[cli.consumer];
  validateProfile(producerProfile, cli.producer);
  validateProfile(consumerProfile, cli.consumer);
  const aggregate = fromRoot(cli.graphDir);
  const output = fromRoot(cli.output);
  mkdirSync(aggregate, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });

  for (let repetition = 0; repetition < cli.repetitions; repetition++) {
    const pairId = `concurrent-${repetition + 1}`;
    const root = mkdtempSync(join(tmpdir(), `token-optimizer-${pairId}-`));
    const workspace = join(root, 'workspace');
    cpSync(fromRoot(scenarios[0].fixture), workspace, { recursive: true });
    const graphDir = join(root, 'shared-graph');
    const auditPath = join(root, 'producer-audit.jsonl');
    mkdirSync(graphDir, { recursive: true });

    // Promise.all is deliberate: these are separate CLI processes appending to
    // the same graph and metrics logs, not sequential calls labeled concurrent.
    const producers = await Promise.all(scenarios.map((scenario) => runClient({
      profile: producerProfile,
      client: cli.producer,
      model: cli.producerModel || producerProfile.model,
      prompt: scenario.producerPrompt,
      phase: `writer-${scenario.id}`,
      scenario,
      pairId,
      workspace,
      graphDir,
      auditPath,
    })));
    const producerAudit = readJsonl(auditPath);
    const graph = loadGraph(graphDir);
    const captures = scenarios.map((scenario) =>
      findNaturalCapture(graph, scenario.targetFinding)
    );
    const findingIds = [...new Set(captures.flat().map((finding) => finding.key))];
    const acceptedFindingIds = [...new Set(
      producers.flatMap((producer) => producer.acceptedFindingIds)
    )];
    const producerRows = producers.map((producer, index) => {
      const scenario = scenarios[index];
      const identity = parseRunIdentity(producer.run.stdout);
      const usage = parseUsage(`${producer.run.stdout}\n${producer.run.stderr}`, producerProfile);
      return {
        scenarioId: scenario.id,
        episodeId: producer.episodeId,
        client: cli.producer,
        clientVersion: identity.clientVersion || producerProfile.version || null,
        model: cli.producerModel || producerProfile.model || null,
        modelVersion: identity.modelVersion || producerProfile.modelVersion || null,
        ...gradeBehavior(scenario, 'producer', workspace, producerAudit, producer.trace),
        captureSuccess: captures[index].length > 0,
        capturedFindingIds: captures[index].map((finding) => finding.key),
        acceptedFindingIds: producer.acceptedFindingIds,
        exitCode: producer.run.exitCode,
        timedOut: producer.run.timedOut,
        latencyMs: producer.run.latencyMs,
        ...usage,
        toolCalls: usage.toolCalls ?? producer.trace.length,
        failedToolCalls: usage.failedToolCalls
          ?? producer.trace.filter((action) => action.success === false).length,
      };
    });
    const integrity = graphIntegrity(graphDir, acceptedFindingIds);
    const frozen = join(root, 'frozen');
    cpSync(workspace, frozen, { recursive: true });
    const arms = repetition % 2 ? ['natural', 'empty'] : ['empty', 'natural'];

    for (const [order, arm] of arms.entries()) {
      const consumerWorkspace = join(root, `consumer-${arm}`);
      cpSync(frozen, consumerWorkspace, { recursive: true });
      const consumerGraph = join(root, `consumer-graph-${arm}`);
      mkdirSync(consumerGraph, { recursive: true });
      if (arm === 'natural') cpSync(graphDir, consumerGraph, { recursive: true });
      const consumerAuditPath = join(root, `consumer-audit-${arm}.jsonl`);
      const synthetic = { id: 'concurrent-combined', family: 'concurrent-multi-writer' };
      const consumer = await runClient({
        profile: consumerProfile,
        client: cli.consumer,
        model: cli.consumerModel || consumerProfile.model,
        prompt: combinedPrompt(),
        phase: `concurrent-consumer-${arm}`,
        scenario: synthetic,
        pairId,
        workspace: consumerWorkspace,
        graphDir: consumerGraph,
        auditPath: consumerAuditPath,
      });
      const consumerAudit = readJsonl(consumerAuditPath);
      const behaviors = scenarios.map((scenario) =>
        gradeBehavior(scenario, 'consumer', consumerWorkspace, consumerAudit, consumer.trace)
      );
      const deliveryEvents = consumer.evidence.filter((event) =>
        event.kind === 'inject' && event.surface === 'session-start'
      );
      const deliveredIds = new Set(deliveryEvents.flatMap((event) => event.findingIds || []));
      const identity = parseRunIdentity(consumer.run.stdout);
      const usage = parseUsage(
        `${consumer.run.stdout}\n${consumer.run.stderr}`, consumerProfile
      );
      const result = {
        kind: 'concurrency-run',
        schemaVersion: 3,
        suite: suite.name,
        pairId,
        repetition,
        order,
        arm,
        writerCount: producers.length,
        producerClient: cli.producer,
        producerModel: cli.producerModel || producerProfile.model || null,
        writers: producerRows,
        captureSuccesses: producerRows.filter((row) => row.captureSuccess).length,
        acceptedFindingIds,
        integrity,
        consumer: {
          client: cli.consumer,
          clientVersion: identity.clientVersion || consumerProfile.version || null,
          model: cli.consumerModel || consumerProfile.model || null,
          modelVersion: identity.modelVersion || consumerProfile.modelVersion || null,
          sessionId: identity.sessionId,
          correct: behaviors.every((behavior) => behavior.correct),
          firstPass: behaviors.every((behavior) => behavior.firstPass),
          mistakeAttempted: behaviors.some((behavior) => behavior.mistakeAttempted),
          mistakeExecuted: behaviors.some((behavior) => behavior.mistakeExecuted),
          scenarioResults: Object.fromEntries(
            scenarios.map((scenario, index) => [scenario.id, behaviors[index]])
          ),
          exitCode: consumer.run.exitCode,
          timedOut: consumer.run.timedOut,
          latencyMs: consumer.run.latencyMs,
          ...usage,
          toolCalls: usage.toolCalls ?? consumer.trace.length,
          failedToolCalls: usage.failedToolCalls
            ?? consumer.trace.filter((action) => action.success === false).length,
        },
        delivery: {
          expected: arm === 'natural' ? findingIds.length : 0,
          delivered: arm === 'natural'
            ? findingIds.filter((id) => deliveredIds.has(id)).length
            : 0,
          allBeforeFirstAction: arm === 'natural'
            ? findingIds.every((id) => deliveredIds.has(id))
            : null,
          deliveredTokens: deliveryEvents.reduce(
            (sum, event) => sum + (event.deliveredTokens || 0), 0
          ),
        },
        graphHash: hash(
          existsSync(join(graphDir, 'graph.jsonl'))
            ? readFileSync(join(graphDir, 'graph.jsonl'), 'utf8')
            : 'empty'
        ),
        producerPromptHashes: scenarios.map((scenario) => hash(scenario.producerPrompt)),
        consumerPromptHash: hash(combinedPrompt()),
        repoCommit: process.env.GITHUB_SHA || PROVENANCE.commit,
        workingTreeDirty: PROVENANCE.dirty,
      };
      appendFileSync(output, `${JSON.stringify(result)}\n`);
      record(aggregate, result);
      process.stdout.write(
        `${result.consumer.correct ? 'PASS' : 'FAIL'} ${pairId} ${cli.producer}x${producers.length}`
        + `->${cli.consumer} ${arm} captures=${result.captureSuccesses}/${producers.length}`
        + ` delivered=${result.delivery.delivered}/${result.delivery.expected}`
        + ` malformed=${integrity.malformedLines} lost=${integrity.missingAcceptedWrites.length}\n`
      );
    }

    if (!cli.keepWorkspaces) rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`Concurrency evidence artifact: ${output}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
