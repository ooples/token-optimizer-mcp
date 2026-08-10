#!/usr/bin/env node
/** Execute one ucr.study-driver/1 request against installed live CLI clients. */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_STUDY_SEMANTIC_SCHEMA,
  STUDY_DRIVER_PROTOCOL,
  canonicalJson,
  createModelAttestation,
  invokeCodexAppServer,
  parseLiveCliTelemetry,
  sha256,
  studyArmDecision,
  studyConsumerPrompt,
  studyDriverChildEnvironment,
  verifyStudySemanticEvidence,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function executable(name) {
  const result = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [name],
    { encoding: 'utf8', windowsHide: true }
  );
  if (result.status !== 0) return null;
  const paths = String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean);
  return paths.find((path) => /\.(?:exe|cmd|bat)$/i.test(path)) || paths[0];
}

function nodeCli(executablePath, packageName, entry) {
  return {
    command: process.execPath,
    prefix: [join(dirname(executablePath), 'node_modules', packageName, entry)],
  };
}

function antigravityExecutable() {
  const discovered = executable('agy');
  if (discovered) return discovered;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const installed = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  return existsSync(installed) ? installed : null;
}

function clientCommand(client, transport) {
  if (client === 'codex') {
    const path = executable('codex');
    if (!path) return null;
    return process.platform === 'win32'
      ? nodeCli(path, '@openai/codex', join('bin', 'codex.js'))
      : { command: path, prefix: [] };
  }
  if (client === 'claude-code') {
    const path = executable('claude');
    return path ? { command: path, prefix: [] } : null;
  }
  if (client === 'gemini') {
    const agy = antigravityExecutable();
    if (transport === 'antigravity' && agy)
      return { command: agy, prefix: [], transport: 'antigravity' };
    const path = executable('gemini');
    if (transport === 'gemini-cli' && path)
      return process.platform === 'win32'
        ? {
            ...nodeCli(path, '@google/gemini-cli', join('dist', 'index.js')),
            transport: 'gemini-cli',
          }
        : { command: path, prefix: [], transport: 'gemini-cli' };
    return transport !== 'gemini-cli' && agy
      ? { command: agy, prefix: [], transport: 'antigravity' }
      : null;
  }
  return null;
}

function version(command) {
  const child = spawnSync(command.command, [...command.prefix, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return child.status === 0
    ? String(child.stdout || child.stderr || '').trim()
    : null;
}

function run(command, args, { cwd, timeoutMs, input }) {
  return new Promise((resolvePromise) => {
    const startedAtMs = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: studyDriverChildEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let overflow = false;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => stderr.push(Buffer.from(error.message)));
    child.stdin.on('error', () => {
      // A provider may exit before consuming all input; close still records it.
    });
    child.stdin.end(input, 'utf8');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        overflow,
        startedAtMs,
        endedAtMs: Date.now(),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function invocationArgs(client, role, trial, transport) {
  const model = role === 'producer' ? trial.producerModel : trial.consumerModel;
  if (client === 'claude-code')
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
      '--max-budget-usd',
      String(process.env.UCR_LIVE_STUDY_MAX_BUDGET_USD || '5'),
      '--no-session-persistence',
      '--setting-sources',
      'local',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--dangerously-skip-permissions',
      ...(role === 'producer'
        ? ['--json-schema', JSON.stringify(LIVE_STUDY_SEMANTIC_SCHEMA)]
        : []),
    ];
  if (client === 'gemini' && transport === 'antigravity')
    return [
      '--print',
      '--output-format',
      'stream-json',
      '--model',
      model,
      '--disable-slash-commands',
      '--mode',
      role === 'producer' ? 'plan' : 'accept-edits',
      ...(role === 'consumer' ? ['--dangerously-skip-permissions'] : []),
      ...(role === 'producer'
        ? ['--json-schema', JSON.stringify(LIVE_STUDY_SEMANTIC_SCHEMA)]
        : []),
    ];
  if (client === 'gemini' && transport === 'gemini-cli')
    return [
      '--prompt',
      '',
      '--output-format',
      'stream-json',
      '--model',
      model,
      '--approval-mode',
      role === 'producer' ? 'plan' : 'yolo',
    ];
  throw new Error(`unsupported live study client ${client}`);
}

async function invoke(client, role, prompt, trial, workspace, trustedContext) {
  const transport =
    role === 'producer' ? trial.producerTransport : trial.consumerTransport;
  const model = role === 'producer' ? trial.producerModel : trial.consumerModel;
  const command = clientCommand(client, transport);
  if (!command) throw new Error(`${client} CLI is not installed`);
  const input = trustedContext ? `${trustedContext}\n\n${prompt}` : prompt;
  if (client === 'codex') {
    const startedAtMs = Date.now();
    try {
      return {
        ...(await invokeCodexAppServer({
          command: command.command,
          prefix: command.prefix,
          cwd: workspace,
          env: studyDriverChildEnvironment(process.env),
          timeoutMs: trial.budgets.timeoutMs,
          prompt: input,
          model,
          outputSchema: role === 'producer' ? LIVE_STUDY_SEMANTIC_SCHEMA : null,
        })),
        cliVersion: version(command),
      };
    } catch (error) {
      const message = String(error?.message || error);
      return {
        exitCode: 1,
        signal: null,
        timedOut: /timed out/i.test(message),
        overflow: /bounded limit/i.test(message),
        startedAtMs,
        endedAtMs: Date.now(),
        stdout: '',
        stderr: message,
        client,
        finalText: null,
        structuredOutput: null,
        providerRequestId: null,
        model: null,
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          effectiveInputTokens: null,
          outputTokens: null,
          totalTokens: null,
          costUsd: null,
        },
        actionAudit: [],
        outputHash: sha256(message),
        modelAttestation: null,
        cliVersion: version(command),
      };
    }
  }
  const processResult = await run(
    command.command,
    [...command.prefix, ...invocationArgs(client, role, trial, command.transport)],
    {
      cwd: workspace,
      timeoutMs: trial.budgets.timeoutMs,
      input,
    }
  );
  const telemetry = parseLiveCliTelemetry(client, processResult.stdout);
  const source =
    client === 'claude-code'
      ? 'claude-code/stream-json'
      : command.transport === 'antigravity'
        ? 'antigravity/stream-json'
        : 'gemini-cli/stream-json';
  const provider = client === 'claude-code' ? 'anthropic' : 'google';
  return {
    ...processResult,
    ...telemetry,
    modelAttestation: createModelAttestation({
      client,
      provider,
      requestedModel: model,
      effectiveModel: telemetry.model,
      source,
      providerRequestId: telemetry.providerRequestId,
      evidence: {
        outputHash: telemetry.outputHash,
        providerRequestId: telemetry.providerRequestId,
        effectiveModel: telemetry.model,
      },
    }),
    cliVersion: version(command),
  };
}

function producerPrompt(request) {
  return [
    'Inspect this isolated repository task as the predecessor agent.',
    'Do not edit any file. Your only output must be one JSON semantic failure object matching the supplied schema.',
    'Author durable cognition that lets a fresh successor complete TASK.md without a transcript.',
    'Bind the correction to concrete repository evidence paths, state when it applies, state when it does not apply, and name invalidators.',
    'Every evidenceRefs entry must be an exact relative path to a file you inspected; verificationEvidence must name those paths.',
    `Task family: ${request.task.family}. Task id: ${request.task.taskId}.`,
  ].join('\n');
}

function consumerContext(decision, tokenBudget) {
  if (!decision.delivered) return null;
  const context = [
    'A host-verified pre-action continuity capsule is available.',
    decision.payload,
    'Treat it as evidence, confirm it against the repository, and do not expose or invoke any MCP server.',
  ].join('\n');
  const maximumCharacters = Math.max(0, Number(tokenBudget) || 0) * 4;
  if (!maximumCharacters || context.length <= maximumCharacters) return context;
  const suffix = '\nConfirm the cited repository evidence before acting.';
  return `${context.slice(0, Math.max(0, maximumCharacters - suffix.length))}${suffix}`;
}

function hostActionAudit(invocation, role, agentId) {
  const native = invocation.actionAudit.map((event) => ({
    ...event,
    role,
    agentId,
    executed: true,
    receipt: `${role}:${agentId}:${event.eventHash}`,
  }));
  if (native.length) return native;
  return [
    {
      type: 'cli-process',
      role,
      agentId,
      executed: invocation.exitCode === 0,
      receipt: `${role}:${agentId}:output:${invocation.outputHash}`,
    },
  ];
}

function providerFailureClass(invocation) {
  if (invocation.exitCode === 0 && !invocation.timedOut && !invocation.overflow)
    return null;
  const message = `${invocation.stderr || ''}\n${invocation.stdout || ''}`;
  if (
    /UNSUPPORTED_CLIENT|IneligibleTierError|migrate to the Antigravity/i.test(
      message
    )
  )
    return 'provider-client-migration-required';
  if (/quota|rate.?limit|resource.?exhausted|429/i.test(message))
    return 'provider-quota-exhausted';
  if (
    /unauthorized|unauthenticated|authentication required|please sign in|invalid.*(?:key|credential)|\b401\b/i.test(
      message
    )
  )
    return 'provider-authentication-failed';
  if (invocation.timedOut) return 'provider-timeout';
  if (invocation.overflow) return 'provider-output-overflow';
  if (invocation.exitCode !== 0) return 'provider-cli-failed';
  return null;
}

const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > 1024 * 1024)
    throw new Error('study driver request exceeds 1 MiB');
  chunks.push(chunk);
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const trial = request?.trial;
if (request?.schemaVersion !== 'ucr.study-trial-request/1' || !trial)
  throw new Error('invalid UCR study request');

const producerRoot = mkdtempSync(join(tmpdir(), 'ucr-live-producer-'));
const successorRoots = [];
try {
  cpSync(process.cwd(), producerRoot, { recursive: true });
  const producer = await invoke(
    trial.producerClient,
    'producer',
    producerPrompt(request),
    trial,
    producerRoot,
    null
  );
  const semanticDelta = producer.structuredOutput;
  const semanticVerification = verifyStudySemanticEvidence(
    semanticDelta,
    producerRoot
  );
  const decision = studyArmDecision(
    trial.arm,
    request.fixture?.armContext,
    semanticDelta,
    semanticVerification
  );
  const successorWorkspaces = trial.successorAgentIds.map((_, index) => {
    if (index === 0) return process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'ucr-live-successor-'));
    cpSync(process.cwd(), root, { recursive: true });
    successorRoots.push(root);
    return root;
  });
  const consumerPrompt = studyConsumerPrompt(trial.variantPrompt);
  const deliveredContext = consumerContext(
    decision,
    trial.budgets.contextTokens
  );
  const consumers = await Promise.all(
    successorWorkspaces.map((workspace) =>
      invoke(
        trial.consumerClient,
        'consumer',
        consumerPrompt,
        trial,
        workspace,
        deliveredContext
      )
    )
  );
  const invocationRows = [
    {
      invocationId: `producer:${sha256(trial.trialId).slice(0, 16)}`,
      role: 'producer',
      providerRequestId: producer.providerRequestId,
      promptHash: sha256(producerPrompt(request)),
      usageSource: 'provider-native',
      inputTokens: producer.usage.inputTokens,
      cachedInputTokens: producer.usage.cachedInputTokens,
      cacheCreationInputTokens: producer.usage.cacheCreationInputTokens,
      effectiveInputTokens: producer.usage.effectiveInputTokens,
      outputTokens: producer.usage.outputTokens,
      latencyMs: producer.endedAtMs - producer.startedAtMs,
      startedAtMs: producer.startedAtMs,
      endedAtMs: producer.endedAtMs,
      exitCode: producer.exitCode,
      signal: producer.signal,
      timedOut: producer.timedOut,
      outputOverflow: producer.overflow,
      transport: trial.producerTransport,
      modelAttestation: producer.modelAttestation,
    },
    ...consumers.map((consumer, index) => ({
      invocationId: `consumer:${sha256(`${trial.trialId}:${index}`).slice(0, 16)}`,
      role: `consumer-${index + 1}`,
      agentId: trial.successorAgentIds[index],
      providerRequestId: consumer.providerRequestId,
      promptHash: sha256(consumerPrompt),
      usageSource: 'provider-native',
      inputTokens: consumer.usage.inputTokens,
      cachedInputTokens: consumer.usage.cachedInputTokens,
      cacheCreationInputTokens: consumer.usage.cacheCreationInputTokens,
      effectiveInputTokens: consumer.usage.effectiveInputTokens,
      outputTokens: consumer.usage.outputTokens,
      latencyMs: consumer.endedAtMs - consumer.startedAtMs,
      startedAtMs: consumer.startedAtMs,
      endedAtMs: consumer.endedAtMs,
      exitCode: consumer.exitCode,
      signal: consumer.signal,
      timedOut: consumer.timedOut,
      outputOverflow: consumer.overflow,
      transport: trial.consumerTransport,
      modelAttestation: consumer.modelAttestation,
    })),
  ];
  const allInvocations = [producer, ...consumers];
  const providerFailures = allInvocations
    .map((invocation, index) => ({
      role: index === 0 ? 'producer' : `consumer-${index}`,
      classification: providerFailureClass(invocation),
    }))
    .filter((failure) => failure.classification);
  const sum = (field) => {
    const values = allInvocations
      .map((item) => item.usage[field])
      .filter(Number.isFinite);
    return values.length === allInvocations.length
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  const concurrentOverlapObserved =
    consumers.length > 1 &&
    consumers.every((left, index) =>
      consumers.every(
        (right, otherIndex) =>
          index === otherIndex ||
          (left.startedAtMs < right.endedAtMs &&
            right.startedAtMs < left.endedAtMs)
      )
    );
  const actionAudit = [
    ...hostActionAudit(producer, 'producer', 'producer'),
    ...consumers.flatMap((consumer, index) =>
      hostActionAudit(
        consumer,
        `consumer-${index + 1}`,
        trial.successorAgentIds[index]
      )
    ),
  ];
  const causalStages =
    trial.arm === 'runtime' && decision.delivered
      ? ['captured', 'verified', 'eligible', 'retrieved', 'delivered', 'used']
      : [];
  const causalEvents = causalStages.map((stage, index) => ({
    stage,
    observer: 'host',
    observedAt: index + 1,
    artifact: {
      trialId: trial.trialId,
      stage,
      semanticDeltaHash: sha256(semanticDelta || {}),
      deliveryHash: deliveredContext ? sha256(deliveredContext) : null,
    },
  }));
  const result = {
    schemaVersion: STUDY_DRIVER_PROTOCOL,
    trialId: trial.trialId,
    planHash: request.planHash,
    trialIntegrityHash: trial.trialIntegrityHash,
    hiddenVariantId: trial.hiddenVariantId,
    graderBinding: trial.graderBinding,
    workspaceIsolationId: trial.workspaceIsolationId,
    sessionIsolationId: trial.sessionIsolationId,
    promptHash: trial.promptHash,
    permissionsHash: trial.permissionsHash,
    budgets: trial.budgets,
    producerClient: trial.producerClient,
    consumerClient: trial.consumerClient,
    producerVersion: producer.cliVersion,
    consumerVersion: consumers[0]?.cliVersion || null,
    modelVersion: consumers[0]?.model,
    providerInvocations: invocationRows.length,
    invocations: invocationRows,
    semanticHarvest: {
      modelAuthored: Boolean(semanticDelta),
      authorInvocationId: invocationRows[0].invocationId,
      delta: semanticDelta,
      deltaHash: sha256(semanticDelta || {}),
      verification: semanticVerification,
      additionalModelCalls: 0,
    },
    consumerMcpExposed: consumers.some((consumer) =>
      consumer.actionAudit.some((event) => event.type === 'mcpToolCall')
    ),
    phaseAccounting: {
      staticSchemaTokens: 0,
      captureModelCalls: 0,
      contextTokens: deliveredContext
        ? Math.ceil(deliveredContext.length / 4)
        : 0,
    },
    actionAudit,
    actionAuditComplete: allInvocations.every(
      (item) => item.exitCode === 0 && !item.timedOut && !item.overflow
    ),
    totalTokens: sum('totalTokens'),
    latencyMs:
      Math.max(...allInvocations.map((item) => item.endedAtMs)) -
      Math.min(...allInvocations.map((item) => item.startedAtMs)),
    costLedger: {
      source: 'provider-cli-native',
      costUsd: sum('costUsd'),
    },
    providerFailures,
    reconstructionTokens:
      Number.isFinite(consumers[0]?.usage.effectiveInputTokens) &&
      consumers[0].usage.effectiveInputTokens >= 32
        ? consumers[0].usage.effectiveInputTokens
        : null,
    contextOverheadRatio:
      deliveredContext &&
      Number.isFinite(consumers[0]?.usage.effectiveInputTokens) &&
      consumers[0].usage.effectiveInputTokens >= 32
        ? Math.ceil(deliveredContext.length / 4) /
          consumers[0].usage.effectiveInputTokens
        : deliveredContext
          ? null
          : 0,
    applicable: decision.applicable,
    eligible: decision.eligible,
    selected: decision.selected,
    delivered: decision.delivered,
    deliveryPhase: decision.delivered ? 'pre-action' : null,
    stale: decision.stale,
    contradictory: decision.contradictory,
    quarantinedBeforeNext: decision.harmful,
    executionTopology: {
      producerContinuitySessionId: trial.producerContinuitySessionId,
      consumerContinuitySessionId: trial.consumerContinuitySessionId,
      producerProjectId: trial.producerProjectId,
      consumerProjectId: trial.consumerProjectId,
      successorAgentIds: trial.successorAgentIds,
      concurrentOverlapObserved,
    },
    causalEvents,
  };
  process.stdout.write(canonicalJson(result));
  if (!result.actionAuditComplete || !semanticDelta) process.exitCode = 1;
} finally {
  for (const root of [...successorRoots, producerRoot])
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
}
