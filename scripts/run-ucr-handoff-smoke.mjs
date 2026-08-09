#!/usr/bin/env node
/**
 * One-pair, cross-model executable smoke test for UCR cognition transfer.
 *
 * This is deliberately not a superiority benchmark. It proves that a Codex
 * producer can author a signed, evidence-backed failure record in one process
 * and that a fresh Claude Code consumer can page the correction from the same
 * event store while a blinded empty-memory control abstains.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  EventStore,
  canonicalJson,
  sha256,
  signGraderReceipt,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  execute: false,
  output: join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'live-cross-model-handoff-v1.json'
  ),
  codexModel: 'gpt-5.6-sol',
  claudeModel: 'sonnet',
  timeoutMs: 600_000,
};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--execute') options.execute = true;
  else if (arg.startsWith('--')) {
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`unknown option ${arg}`);
    options[key] = process.argv[++index];
  }
}
options.timeoutMs = Number(options.timeoutMs);
options.output = isAbsolute(options.output)
  ? options.output
  : resolve(ROOT, options.output);

const executable = (name) => {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, [name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const candidates = result.stdout.split(/\r?\n/).filter(Boolean);
  if (process.platform !== 'win32') return candidates[0] || null;
  return (
    candidates.find((path) => /\.(?:exe|cmd|bat)$/i.test(path)) ||
    candidates[0] ||
    null
  );
};
const availability = {
  codex: executable('codex'),
  claude: executable('claude'),
};
const codexInvocation =
  process.platform === 'win32' && availability.codex
    ? {
        command: process.execPath,
        prefix: [
          join(
            dirname(availability.codex),
            'node_modules',
            '@openai',
            'codex',
            'bin',
            'codex.js'
          ),
        ],
      }
    : { command: availability.codex, prefix: [] };
const versionOf = (command, prefix = []) => {
  const result = spawnSync(command, [...prefix, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0
    ? String(result.stdout || result.stderr || '').trim() || null
    : null;
};

if (!options.execute) {
  console.log(
    JSON.stringify(
      {
        evidenceClass: 'live-cross-model-executable-smoke',
        execute: false,
        availability: Object.fromEntries(
          Object.entries(availability).map(([key, value]) => [
            key,
            Boolean(value),
          ])
        ),
        stages: [
          'blinded Claude empty-memory control',
          'Codex signed semantic harvest',
          'fresh Claude UCR consumer',
          'state and action grading',
        ],
        note: 'Run with --execute only when paid CLI model invocations are authorized.',
      },
      null,
      2
    )
  );
  process.exit(availability.codex && availability.claude ? 0 : 1);
}
if (!availability.codex || !availability.claude)
  throw new Error('codex and claude executables are required');

const attemptsPath = join(
  dirname(options.output),
  'live-cross-model-handoff-attempts.jsonl'
);
mkdirSync(dirname(options.output), { recursive: true });
if (readFileIfPresent(options.output)) {
  const prior = JSON.parse(readFileSync(options.output, 'utf8'));
  const existing = readFileIfPresent(attemptsPath) || '';
  if (prior.reportHash && !existing.includes(prior.reportHash)) {
    appendFileSync(
      attemptsPath,
      `${canonicalJson({
        schemaVersion: 'ucr.live-handoff-attempt/1',
        executedAt: prior.executedAt,
        taskHash: prior.taskHash,
        clients: prior.clients,
        arms: prior.arms,
        producer: prior.producer,
        eventEvidence: prior.eventEvidence,
        passed: prior.passed,
        reportHash: prior.reportHash,
      })}\n`,
      'utf8'
    );
  }
}

function readFileIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function run(command, args, { env = process.env, cwd = ROOT } = {}) {
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        ...result,
        timedOut,
        latencyMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr.push(Buffer.from(error.message));
      finish({ exitCode: null, signal: null });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({ exitCode, signal });
    });
  });
}

function collectNumbers(text) {
  const values = {};
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number') values[key] = item;
      else visit(item);
    }
  };
  for (const line of String(text).split(/\r?\n/)) {
    try {
      visit(JSON.parse(line));
    } catch {
      /* non-JSON CLI output */
    }
  }
  const choose = (...keys) =>
    keys.map((key) => values[key]).find(Number.isFinite) ?? null;
  return {
    inputTokens: choose('input_tokens', 'inputTokens'),
    cachedInputTokens: choose(
      'cache_read_input_tokens',
      'cached_input_tokens',
      'cachedInputTokens'
    ),
    outputTokens: choose('output_tokens', 'outputTokens'),
    totalTokens: choose('total_tokens', 'totalTokens'),
    costUsd: choose('total_cost_usd', 'cost_usd', 'costUsd'),
  };
}

const tomlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const temp = mkdtempSync(join(tmpdir(), 'ucr-live-handoff-'));
const ucrRoot = join(temp, 'ucr');
const taskNonce = randomBytes(8).toString('hex');
const taskId = `live-handoff-${taskNonce}`;
const recoveryCode = `ORANGE-${randomBytes(12).toString('hex').toUpperCase()}`;
const graderSecret = randomBytes(32).toString('hex');
const projectId = 'ucr-live-cross-model-v1';
const receipt = signGraderReceipt(
  {
    graderId: 'ucr-hidden-recovery-code-v1',
    passed: true,
    artifactHash: sha256({
      taskId,
      recoveryCode,
      expectedState: 'producer-correction-verified',
    }),
    taskId,
    issuedAt: new Date().toISOString(),
  },
  graderSecret
);

const commonEnv = {
  TOKEN_OPTIMIZER_TOOL_PROFILE: 'cognitive',
  TOKEN_OPTIMIZER_UCR_DIR: ucrRoot,
  TOKEN_OPTIMIZER_PROJECT_ID: projectId,
  TOKEN_OPTIMIZER_WORKSPACE_ID: `workspace:${projectId}`,
  TOKEN_OPTIMIZER_GRADER_SECRET: graderSecret,
};
const serverPath = join(ROOT, 'dist', 'server', 'index.js');
const codexMcpArgs = [
  '-c',
  `mcp_servers.token-optimizer.command=${tomlLiteral(process.execPath)}`,
  '-c',
  `mcp_servers.token-optimizer.args=[${tomlLiteral(serverPath)}]`,
  '-c',
  `mcp_servers.token-optimizer.env={TOKEN_OPTIMIZER_TOOL_PROFILE=${tomlLiteral('cognitive')},TOKEN_OPTIMIZER_UCR_DIR=${tomlLiteral(ucrRoot)},TOKEN_OPTIMIZER_PROJECT_ID=${tomlLiteral(projectId)},TOKEN_OPTIMIZER_WORKSPACE_ID=${tomlLiteral(`workspace:${projectId}`)},TOKEN_OPTIMIZER_GRADER_SECRET=${tomlLiteral(graderSecret)},TOKEN_OPTIMIZER_CLIENT=${tomlLiteral('codex')},TOKEN_OPTIMIZER_AGENT_ID=${tomlLiteral('producer-codex')},TOKEN_OPTIMIZER_MODEL=${tomlLiteral(options.codexModel)}}`,
];
const claudeMcp = JSON.stringify({
  mcpServers: {
    'token-optimizer': {
      command: process.execPath,
      args: [serverPath],
      env: {
        ...commonEnv,
        TOKEN_OPTIMIZER_CLIENT: 'claude-code',
        TOKEN_OPTIMIZER_AGENT_ID: 'consumer-claude',
        TOKEN_OPTIMIZER_MODEL: options.claudeModel,
      },
    },
  },
});

const blindedPrompt = [
  'This is a blinded continuity evaluation. Do not inspect files, shell state, user memory, or the internet.',
  `For task ${taskId}, report the verified recovery code.`,
  'If this session contains no authoritative evidence for the code, answer exactly RECOVERY_CODE=ABSTAIN.',
  'Otherwise answer exactly RECOVERY_CODE=<code>.',
].join('\n');
const producerPrompt = [
  'This is a controlled UCR semantic-harvest evaluation. Do not inspect or edit files and do not use shell tools.',
  'Call the token-optimizer cognition_record MCP operation exactly once with kind=failure.',
  `The task id is ${taskId}. The verified correction is to use recovery code ${recoveryCode}; BLUE-LEGACY was attempted and rejected as stale.`,
  `Pass this external deterministic-grader receipt without changing it: ${JSON.stringify(receipt)}`,
  'Author a complete semantic object with trigger, attemptedAction, observedFailure, rootCause, correction, verificationEvidence, applicability, nonApplicability, invalidators, scope, confidence, confidenceLabel, and expectedOutcome.',
  `Make applicability a non-empty JSON array specific to task ${taskId}; make nonApplicability a non-empty JSON array excluding every other task; make invalidators a JSON array; and use confidenceLabel=verified.`,
  'After the tool succeeds, answer exactly RECORDED.',
].join('\n');
const consumerPrompt = [
  'This is a fresh cross-model UCR continuity evaluation. Do not inspect files, shell state, user memory, or the internet.',
  'Call the token-optimizer context_page MCP operation before answering.',
  `Query for the verified failure correction and recovery code for task ${taskId}, with taskId=${taskId}, trigger=task, and budget=256.`,
  'Answer exactly RECOVERY_CODE=<code> using only the delivered evidence. If no applicable evidence is delivered, answer exactly RECOVERY_CODE=ABSTAIN.',
].join('\n');

let baseline;
let producer;
let consumer;
try {
  console.log('running blinded Claude empty-memory control...');
  baseline = await run(availability.claude, [
    '--safe-mode',
    '-p',
    blindedPrompt,
    '--output-format',
    'json',
    '--model',
    options.claudeModel,
    '--max-budget-usd',
    '1',
    '--no-session-persistence',
  ]);
  console.log(
    `baseline exit=${baseline.exitCode} latencyMs=${baseline.latencyMs}`
  );

  console.log('running Codex active-model semantic producer...');
  producer = await run(
    codexInvocation.command,
    [
      ...codexInvocation.prefix,
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      options.codexModel,
      ...codexMcpArgs,
      producerPrompt,
    ],
    { cwd: temp }
  );
  console.log(
    `producer exit=${producer.exitCode} latencyMs=${producer.latencyMs}`
  );

  console.log('running fresh Claude UCR consumer...');
  consumer = await run(availability.claude, [
    '-p',
    consumerPrompt,
    '--output-format',
    'json',
    '--model',
    options.claudeModel,
    '--max-budget-usd',
    '1',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    claudeMcp,
    '--allowedTools',
    'mcp__token-optimizer__context_page',
  ]);
  console.log(
    `consumer exit=${consumer.exitCode} latencyMs=${consumer.latencyMs}`
  );

  const events = new EventStore(ucrRoot).read().events;
  const activated = events.filter(
    (event) => event.type === 'finding.activated'
  );
  const deliveries = events.filter(
    (event) => event.type === 'context.delivered'
  );
  const baselineCorrect = baseline.stdout.includes(recoveryCode);
  const producerRecorded = activated.some(
    (event) =>
      event.actor.client === 'codex' &&
      String(event.payload?.object?.correction || '').includes(recoveryCode)
  );
  const consumerCorrect = consumer.stdout.includes(recoveryCode);
  const delivered = deliveries.some(
    (event) =>
      event.actor.client === 'claude-code' &&
      event.payload?.action === 'deliver' &&
      event.payload?.objectIds?.length > 0
  );
  const passed =
    baseline.exitCode === 0 &&
    producer.exitCode === 0 &&
    consumer.exitCode === 0 &&
    !baselineCorrect &&
    producerRecorded &&
    delivered &&
    consumerCorrect;
  const reportBody = {
    schemaVersion: 'ucr.live-handoff-smoke/1',
    evidenceClass: 'live-cross-model-executable-smoke-not-superiority-study',
    executedAt: new Date().toISOString(),
    taskId,
    taskHash: sha256({ taskId, recoveryCode }),
    recoveryCodeHash: sha256(recoveryCode),
    sourceTreeHash: sha256([
      readFileSync(join(ROOT, 'ucr', 'protocol.mjs'), 'utf8'),
      readFileSync(join(ROOT, 'ucr', 'compiler.mjs'), 'utf8'),
      readFileSync(join(ROOT, 'src', 'server', 'ucr-tools.ts'), 'utf8'),
    ]),
    clients: {
      producer: {
        client: 'codex',
        version: versionOf(codexInvocation.command, codexInvocation.prefix),
        model: options.codexModel,
      },
      consumer: {
        client: 'claude-code',
        version: versionOf(availability.claude),
        model: options.claudeModel,
      },
    },
    arms: {
      empty: {
        exitCode: baseline.exitCode,
        correct: baselineCorrect,
        abstained: baseline.stdout.includes('RECOVERY_CODE=ABSTAIN'),
        usage: collectNumbers(baseline.stdout),
        latencyMs: baseline.latencyMs,
      },
      runtime: {
        exitCode: consumer.exitCode,
        correct: consumerCorrect,
        delivered,
        usage: collectNumbers(consumer.stdout),
        latencyMs: consumer.latencyMs,
      },
    },
    producer: {
      exitCode: producer.exitCode,
      recorded: producerRecorded,
      usage: collectNumbers(producer.stdout),
      latencyMs: producer.latencyMs,
    },
    eventEvidence: {
      canonicalEvents: events.length,
      activatedFindings: activated.length,
      contextDeliveries: deliveries.length,
      actorClients: [
        ...new Set(events.map((event) => event.actor.client)),
      ].sort(),
      eventStreamHash: new EventStore(ucrRoot).digest(),
    },
    transcriptPublished: false,
    passed,
    limitations: [
      'one task and one pair cannot establish a statistical effect',
      'the smoke measures cross-model transfer and abstention, not competitive superiority',
      'the consumer model alias must be resolved from provider-side run metadata before a model-version claim',
    ],
  };
  const report = { ...reportBody, reportHash: sha256(reportBody) };
  mkdirSync(dirname(options.output), { recursive: true });
  appendFileSync(
    attemptsPath,
    `${canonicalJson({
      schemaVersion: 'ucr.live-handoff-attempt/1',
      executedAt: report.executedAt,
      taskHash: report.taskHash,
      clients: report.clients,
      arms: report.arms,
      producer: report.producer,
      eventEvidence: report.eventEvidence,
      passed: report.passed,
      reportHash: report.reportHash,
    })}\n`,
    'utf8'
  );
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    canonicalJson({
      output: options.output,
      passed,
      events: report.eventEvidence,
      arms: report.arms,
    })
  );
  if (!passed) {
    const redact = (value) =>
      String(value || '')
        .replaceAll(recoveryCode, '[RECOVERY_CODE_REDACTED]')
        .replaceAll(graderSecret, '[GRADER_SECRET_REDACTED]')
        .slice(-4000);
    console.error(`producer stdout: ${redact(producer.stdout)}`);
    console.error(`producer stderr: ${producer.stderr.slice(-1000)}`);
    console.error(`consumer stdout: ${redact(consumer.stdout)}`);
    console.error(`consumer stderr: ${consumer.stderr.slice(-1000)}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
