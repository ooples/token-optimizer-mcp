#!/usr/bin/env node
/**
 * Bidirectional transcript-free live handoff matrix across OpenAI and
 * Anthropic models in Codex, Claude Code, and GitHub Copilot CLIs. Every
 * direction uses a fresh hidden task,
 * blinded control, active-model semantic producer, and fresh consumer.
 */

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EventStore,
  canonicalJson,
  createEvidenceRun,
  sealEvidenceLedger,
  sha256,
  signGraderReceipt,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  execute: false,
  directions: 'all',
  direction: null,
  output: join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'live-multimodel-handoff-v1.json'
  ),
  codexModel: 'gpt-5.6-sol',
  claudeModel: 'sonnet',
  copilotModel: 'claude-sonnet-4.5',
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

function executable(name) {
  const result = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [name],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  if (result.status !== 0) return null;
  const paths = result.stdout.split(/\r?\n/).filter(Boolean);
  return (
    paths.find((path) => /\.(?:exe|cmd|bat)$/i.test(path)) || paths[0] || null
  );
}

function nodeCliPath(executablePath, packageName, entry) {
  if (process.platform !== 'win32') return null;
  return join(dirname(executablePath), 'node_modules', packageName, entry);
}

const paths = {
  codex: executable('codex'),
  'claude-code': executable('claude'),
  copilot: executable('copilot'),
};
const commands = {
  codex:
    process.platform === 'win32'
      ? {
          command: process.execPath,
          prefix: [
            nodeCliPath(paths.codex, '@openai/codex', join('bin', 'codex.js')),
          ],
        }
      : { command: paths.codex, prefix: [] },
  'claude-code': { command: paths['claude-code'], prefix: [] },
  copilot:
    process.platform === 'win32'
      ? {
          command: process.execPath,
          prefix: [
            nodeCliPath(paths.copilot, '@github/copilot', 'npm-loader.js'),
          ],
        }
      : { command: paths.copilot, prefix: [] },
};
const clients = {
  codex: { family: 'openai', model: options.codexModel },
  'claude-code': { family: 'anthropic', model: options.claudeModel },
  copilot: { family: 'anthropic', model: options.copilotModel },
};
const allDirections = Object.keys(clients).flatMap((producer) =>
  Object.keys(clients)
    .filter((consumer) => consumer !== producer)
    .map((consumer) => [producer, consumer])
);
const ringDirections = [
  ['codex', 'claude-code'],
  ['claude-code', 'copilot'],
  ['copilot', 'codex'],
];
const requestedDirection = options.direction
  ? [String(options.direction).split('->')]
  : null;
if (
  requestedDirection &&
  (requestedDirection[0].length !== 2 ||
    !clients[requestedDirection[0][0]] ||
    !clients[requestedDirection[0][1]] ||
    requestedDirection[0][0] === requestedDirection[0][1])
) {
  throw new Error(`invalid direction ${options.direction}`);
}
const directions =
  requestedDirection ||
  (options.directions === 'ring' ? ringDirections : allDirections);

if (!options.execute) {
  console.log(
    JSON.stringify(
      {
        execute: false,
        evidenceClass:
          'live-multimodel-executable-smoke-not-powered-effectiveness',
        availability: Object.fromEntries(
          Object.entries(paths).map(([client, path]) => [client, Boolean(path)])
        ),
        directions: directions.map(
          ([producer, consumer]) => `${producer}->${consumer}`
        ),
        modelInvocations: directions.length * 3,
        note: 'Each direction uses a paid blinded control, producer, and consumer invocation.',
      },
      null,
      2
    )
  );
  process.exit(Object.values(paths).every(Boolean) ? 0 : 1);
}
if (!Object.values(paths).every(Boolean))
  throw new Error('codex, claude, and copilot executables are required');

function version(client) {
  const invocation = commands[client];
  const result = spawnSync(
    invocation.command,
    [...invocation.prefix, '--version'],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  return result.status === 0
    ? String(result.stdout || result.stderr || '').trim() || null
    : null;
}

function run(command, args, { cwd = ROOT, env = process.env } = {}) {
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
    }, options.timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => stderr.push(Buffer.from(error.message)));
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        latencyMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function collectUsage(text) {
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
      // Some CLIs emit a JSON document rather than JSONL, or status text.
    }
  }
  try {
    visit(JSON.parse(text));
  } catch {
    // Non-JSON output has no trustworthy native token measurement.
  }
  const choose = (...keys) =>
    keys.map((key) => values[key]).find(Number.isFinite) ?? null;
  return {
    inputTokens: choose('input_tokens', 'inputTokens', 'promptTokenCount'),
    cachedInputTokens: choose(
      'cache_read_input_tokens',
      'cached_input_tokens',
      'cachedInputTokens',
      'cachedContentTokenCount'
    ),
    outputTokens: choose(
      'output_tokens',
      'outputTokens',
      'candidatesTokenCount'
    ),
    totalTokens: choose('total_tokens', 'totalTokens', 'totalTokenCount'),
    costUsd: choose('total_cost_usd', 'cost_usd', 'costUsd'),
    tokenAccounting: 'provider-cli-native',
  };
}

function copyCopilotAuthentication(configDirectory) {
  const source = join(homedir(), '.copilot', 'config.json');
  if (!existsSync(source))
    throw new Error('copilot authentication configuration was not found');
  const configuration = JSON.parse(readFileSync(source, 'utf8'));
  const authentication = {
    last_logged_in_user: configuration.last_logged_in_user,
    logged_in_users: configuration.logged_in_users,
    banner: 'never',
  };
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, 'config.json'),
    `${JSON.stringify(authentication, null, 2)}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    join(configDirectory, 'mcp-config.json'),
    `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function configuredCopilotServers() {
  const configPath = join(homedir(), '.copilot', 'mcp-config.json');
  if (!existsSync(configPath)) return [];
  try {
    const configuration = JSON.parse(readFileSync(configPath, 'utf8'));
    return Object.keys(configuration.mcpServers || {}).sort();
  } catch {
    return [];
  }
}

function tomlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function invoke(client, role, prompt, context) {
  const invocation = commands[client];
  if (client === 'codex') {
    const mcpArgs =
      role === 'baseline'
        ? []
        : [
            '-c',
            `mcp_servers.token-optimizer.command=${tomlLiteral(process.execPath)}`,
            '-c',
            `mcp_servers.token-optimizer.args=[${tomlLiteral(join(ROOT, 'dist', 'server', 'index.js'))}]`,
            '-c',
            `mcp_servers.token-optimizer.env={${Object.entries(
              context.environment
            )
              .map(([key, value]) => `${key}=${tomlLiteral(value)}`)
              .join(',')}}`,
          ];
    return run(
      invocation.command,
      [
        ...invocation.prefix,
        'exec',
        '--json',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--dangerously-bypass-approvals-and-sandbox',
        '--model',
        clients[client].model,
        ...mcpArgs,
        prompt,
      ],
      { cwd: context.workspace }
    );
  }
  if (client === 'claude-code') {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      clients[client].model,
      '--max-budget-usd',
      '1',
      '--no-session-persistence',
      '--setting-sources',
      'local',
      '--permission-mode',
      'dontAsk',
    ];
    if (role !== 'baseline') {
      args.push(
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            'token-optimizer': {
              command: process.execPath,
              args: [join(ROOT, 'dist', 'server', 'index.js')],
              env: context.environment,
            },
          },
        }),
        '--allowedTools',
        role === 'producer'
          ? 'mcp__token-optimizer__cognition_record'
          : 'mcp__token-optimizer__context_page'
      );
    }
    return run(invocation.command, args, { cwd: context.workspace });
  }
  const configDirectory = join(context.workspace, 'copilot-config');
  copyCopilotAuthentication(configDirectory);
  const disabledServerArgs = configuredCopilotServers().flatMap((name) => [
    '--disable-mcp-server',
    name,
  ]);
  const args = [
    ...invocation.prefix,
    '--prompt',
    prompt,
    '--silent',
    '--model',
    clients[client].model,
    '--config-dir',
    configDirectory,
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    ...disabledServerArgs,
    '--no-ask-user',
    '--no-color',
    '--no-auto-update',
    '--stream',
    'off',
    '--allow-all-tools',
  ];
  if (role !== 'baseline') {
    args.push(
      '--additional-mcp-config',
      JSON.stringify({
        mcpServers: {
          'ucr-eval': {
            type: 'local',
            command: process.execPath,
            args: [join(ROOT, 'dist', 'server', 'index.js')],
            env: context.environment,
            tools: ['*'],
          },
        },
      })
    );
  }
  return run(invocation.command, args, { cwd: context.workspace });
}

function finalResponse(client, stdout) {
  const normalize = (value) => {
    const text = String(value).trim();
    const answers = text.match(/RECOVERY_CODE=[A-Z0-9-]+/g);
    return answers?.at(-1) || text;
  };
  if (client === 'copilot') return normalize(stdout);
  if (client === 'claude-code') {
    try {
      return normalize(JSON.parse(stdout).result || '');
    } catch {
      return normalize(stdout);
    }
  }
  let response = '';
  for (const line of String(stdout).split(/\r?\n/)) {
    try {
      const item = JSON.parse(line).item;
      if (item?.type === 'agent_message') response = item.text || response;
    } catch {
      // Preserve the most recent valid agent message from Codex JSONL.
    }
  }
  return normalize(response);
}

const temporary = mkdtempSync(join(tmpdir(), 'ucr-multimodel-live-'));
const results = [];
const attemptsPath = join(
  dirname(options.output),
  'live-multimodel-handoff-attempts.jsonl'
);
mkdirSync(dirname(options.output), { recursive: true });
const graderSecret = randomBytes(32).toString('hex');

function executeRecoveryFixture({ taskId, recoveryCode, staleCode }) {
  const expectedCode = recoveryCode;
  const staleAttemptAccepted = staleCode === expectedCode;
  const correctedAttemptAccepted = recoveryCode === expectedCode;
  if (staleAttemptAccepted || !correctedAttemptAccepted) {
    throw new Error(
      'deterministic recovery fixture did not exercise fail then pass'
    );
  }
  return {
    trigger: `continuing recovery task ${taskId}`,
    attemptedAction: `apply recovery code ${staleCode}`,
    observedFailure: `deterministic fixture rejected ${staleCode}`,
    rootCause:
      'the attempted code did not match the hidden expected recovery code',
    correction: `apply verified recovery code ${recoveryCode}`,
    verificationEvidence: `deterministic fixture accepted ${recoveryCode} after rejecting ${staleCode}`,
    expectedOutcome: `task ${taskId} recovers without repeating ${staleCode}`,
    staleAttemptAccepted,
    correctedAttemptAccepted,
  };
}

try {
  for (const [producerClient, consumerClient] of directions) {
    const nonce = randomBytes(8).toString('hex');
    const taskId = `multimodel-${producerClient}-${consumerClient}-${nonce}`;
    const recoveryCode = `GREEN-${randomBytes(12).toString('hex').toUpperCase()}`;
    const staleCode = `STALE-${randomBytes(8).toString('hex').toUpperCase()}`;
    const projectId = `ucr-multimodel-${nonce}`;
    const ucrRoot = join(temporary, taskId, 'ucr');
    const observations = executeRecoveryFixture({
      taskId,
      recoveryCode,
      staleCode,
    });
    const receipt = signGraderReceipt(
      {
        graderId: 'ucr-hidden-multimodel-recovery-v1',
        passed: true,
        artifactHash: sha256({ taskId, observations }),
        taskId,
        observations,
        issuedAt: new Date().toISOString(),
      },
      graderSecret
    );
    const baseEnvironment = {
      TOKEN_OPTIMIZER_TOOL_PROFILE: 'cognitive',
      TOKEN_OPTIMIZER_UCR_DIR: ucrRoot,
      TOKEN_OPTIMIZER_PROJECT_ID: projectId,
      TOKEN_OPTIMIZER_WORKSPACE_ID: `workspace:${projectId}`,
      TOKEN_OPTIMIZER_GRADER_SECRET: graderSecret,
    };
    const workspace = (role, client) => {
      const path = join(temporary, taskId, `${role}-${client}`);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const controlPrompt = [
      'This is a blinded continuity evaluation. Do not inspect files, shell state, user memory, or the internet.',
      `For task ${taskId}, report the verified recovery code.`,
      'If no authoritative evidence is present, answer exactly RECOVERY_CODE=ABSTAIN.',
      'Otherwise answer exactly RECOVERY_CODE=<code>.',
    ].join('\n');
    const producerPrompt = [
      'The user authorized this controlled semantic-harvest evaluation. Do not inspect or edit files and do not use shell tools.',
      `An external deterministic benchmark runner executed a fail-then-correct fixture for task ${taskId}.`,
      `First call cognition_record with operation=verify-evidence and this receipt as the only evidenceReceipts item: ${JSON.stringify(receipt)}`,
      'Do not trust or record the supplied observations unless that tool returns valid=true.',
      'After successful verification, call cognition_record again with operation=record, kind=failure, the same unchanged receipt, taskId, sessionId=producer-session, and a semanticObject authored from the authenticated observations returned by the verifier.',
      'The semanticObject must include trigger, attemptedAction, observedFailure, rootCause, correction, verificationEvidence, applicability, nonApplicability, invalidators, scope, confidence, confidenceLabel, and expectedOutcome.',
      `Applicability must be a non-empty array specific to ${taskId}; nonApplicability must exclude every other task; invalidators must be an array; confidenceLabel must be verified.`,
      'If verification fails, answer exactly REJECTED. If record schema validation fails, correct it once. After successful activation answer exactly RECORDED.',
    ].join('\n');
    const consumerPrompt = [
      'This is a fresh transcript-free takeover evaluation. Do not inspect files, shell state, user memory, or the internet.',
      `Call context_page for task ${taskId} before answering, with query asking for its verified failure correction, taskId=${taskId}, trigger=task, and budget=256.`,
      'Use only delivered evidence. Answer exactly RECOVERY_CODE=<code>, or RECOVERY_CODE=ABSTAIN if no applicable evidence is delivered.',
      'Never output the failed stale code.',
    ].join('\n');

    console.log(
      `running ${producerClient}->${consumerClient} blinded control...`
    );
    const control = await invoke(consumerClient, 'baseline', controlPrompt, {
      workspace: workspace('control', consumerClient),
      environment: {},
    });
    console.log(`running ${producerClient}->${consumerClient} producer...`);
    const producer = await invoke(producerClient, 'producer', producerPrompt, {
      workspace: workspace('producer', producerClient),
      environment: {
        ...baseEnvironment,
        TOKEN_OPTIMIZER_CLIENT: producerClient,
        TOKEN_OPTIMIZER_AGENT_ID: `producer-${producerClient}`,
        TOKEN_OPTIMIZER_MODEL: clients[producerClient].model,
      },
    });
    console.log(`running ${producerClient}->${consumerClient} consumer...`);
    const consumer = await invoke(consumerClient, 'consumer', consumerPrompt, {
      workspace: workspace('consumer', consumerClient),
      environment: {
        ...baseEnvironment,
        TOKEN_OPTIMIZER_CLIENT: consumerClient,
        TOKEN_OPTIMIZER_AGENT_ID: `consumer-${consumerClient}`,
        TOKEN_OPTIMIZER_MODEL: clients[consumerClient].model,
      },
    });
    const events = new EventStore(ucrRoot).read().events;
    const activated = events.filter(
      (event) => event.type === 'finding.activated'
    );
    const deliveries = events.filter(
      (event) => event.type === 'context.delivered'
    );
    const controlAnswer = finalResponse(consumerClient, control.stdout);
    const consumerAnswer = finalResponse(consumerClient, consumer.stdout);
    const controlCorrect = controlAnswer === `RECOVERY_CODE=${recoveryCode}`;
    const controlAbstained = controlAnswer === 'RECOVERY_CODE=ABSTAIN';
    const producerRecorded = activated.some(
      (event) =>
        event.actor.client === producerClient &&
        String(event.payload?.object?.correction || '').includes(
          recoveryCode
        ) &&
        String(event.payload?.object?.attemptedAction || '').includes(staleCode)
    );
    const delivered = deliveries.some(
      (event) =>
        event.actor.client === consumerClient &&
        event.payload?.action === 'deliver' &&
        event.payload?.objectIds?.length > 0
    );
    const consumerCorrect = consumerAnswer === `RECOVERY_CODE=${recoveryCode}`;
    const repeatedFailure = consumerAnswer === `RECOVERY_CODE=${staleCode}`;
    const passed =
      control.exitCode === 0 &&
      producer.exitCode === 0 &&
      consumer.exitCode === 0 &&
      !controlCorrect &&
      controlAbstained &&
      producerRecorded &&
      delivered &&
      consumerCorrect &&
      !repeatedFailure;
    const row = {
      study: 'cross-client-handoff',
      direction: `${producerClient}->${consumerClient}`,
      producerClient,
      consumerClient,
      producerFamily: clients[producerClient].family,
      consumerFamily: clients[consumerClient].family,
      producerModel: clients[producerClient].model,
      consumerModel: clients[consumerClient].model,
      taskHash: sha256({ taskId, recoveryCode, staleCode }),
      control: {
        exitCode: control.exitCode,
        correct: controlCorrect,
        abstained: controlAbstained,
        usage: collectUsage(control.stdout),
        latencyMs: control.latencyMs,
      },
      producer: {
        exitCode: producer.exitCode,
        recorded: producerRecorded,
        usage: collectUsage(producer.stdout),
        latencyMs: producer.latencyMs,
      },
      runtime: {
        exitCode: consumer.exitCode,
        correct: consumerCorrect,
        delivered,
        mistakeExecuted: repeatedFailure,
        usage: collectUsage(consumer.stdout),
        latencyMs: consumer.latencyMs,
      },
      eventStreamHash: new EventStore(ucrRoot).digest(),
      canonicalEvents: events.length,
      passed,
      transcriptPublished: false,
    };
    results.push(row);
    appendFileSync(
      attemptsPath,
      `${canonicalJson({
        schemaVersion: 'ucr.multimodel-attempt/1',
        ...row,
        attemptHash: sha256(row),
      })}\n`,
      'utf8'
    );
    if (!passed) {
      const redact = (text) =>
        String(text || '')
          .replaceAll(recoveryCode, '[RECOVERY_CODE_REDACTED]')
          .replaceAll(staleCode, '[STALE_CODE_REDACTED]')
          .replaceAll(graderSecret, '[GRADER_SECRET_REDACTED]')
          .slice(-3000);
      console.error(`${row.direction} producer: ${redact(producer.stdout)}`);
      console.error(
        `${row.direction} producer stderr: ${redact(producer.stderr)}`
      );
      console.error(`${row.direction} consumer: ${redact(consumer.stdout)}`);
      console.error(
        `${row.direction} consumer stderr: ${redact(consumer.stderr)}`
      );
    }
  }

  const sourceTreeHash = sha256([
    readFileSync(join(ROOT, 'ucr', 'protocol.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'compiler.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'checkpoint.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'src', 'server', 'ucr-tools.ts'), 'utf8'),
    readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  ]);
  const run = createEvidenceRun({
    runId: `live-multimodel-${randomBytes(8).toString('hex')}`,
    evidenceClass: 'executable-smoke',
    benchmarkHash: sha256(
      readFileSync(join(ROOT, 'evals', 'ucr', 'benchmark-v1.json'), 'utf8')
    ),
    sourceTreeHash,
    runner: {
      name: 'live-multimodel-handoff',
      versions: Object.fromEntries(
        Object.keys(clients).map((client) => [client, version(client)])
      ),
    },
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const ledger = sealEvidenceLedger(run, results, { privateKey });
  const ledgerPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  const ledgerVerification = verifyEvidenceLedger(ledger, { publicKey });
  const body = {
    schemaVersion: 'ucr.live-multimodel-handoff/1',
    evidenceClass: 'live-multimodel-executable-smoke-not-powered-effectiveness',
    executedAt: new Date().toISOString(),
    sourceTreeHash,
    requestedDirections: directions.map(
      ([producer, consumer]) => `${producer}->${consumer}`
    ),
    directionsPassed: results.filter((result) => result.passed).length,
    directionResults: results,
    clients: Object.fromEntries(
      Object.keys(clients).map((client) => [
        client,
        { ...clients[client], version: version(client) },
      ])
    ),
    modelFamilies: new Set(
      Object.values(clients).map((client) => client.family)
    ).size,
    controlsAbstained: results.filter((result) => result.control.abstained)
      .length,
    repeatedVerifiedFailures: results.filter(
      (result) => result.runtime.mistakeExecuted
    ).length,
    ledger,
    ledgerPublicKey,
    ledgerVerification,
    transcriptPublished: false,
    passed:
      results.length === directions.length &&
      results.every((result) => result.passed) &&
      ledgerVerification.valid,
    limitations: [
      'one task per direction is executable coverage, not a powered effectiveness estimate',
      'provider aliases require provider response metadata before exact model-version claims',
      'the installed standalone Gemini CLI and the advertised Copilot Gemini model were unavailable to the authenticated accounts; their failed attempts remain separate negative evidence',
      'no competitive superiority claim is permitted from this smoke matrix',
    ],
  };
  const report = { ...body, reportHash: sha256(body) };
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    canonicalJson({
      output: options.output,
      passed: report.passed,
      directions: `${report.directionsPassed}/${report.requestedDirections.length}`,
      modelFamilies: report.modelFamilies,
      controlsAbstained: report.controlsAbstained,
      repeatedVerifiedFailures: report.repeatedVerifiedFailures,
      ledgerHash: ledger.ledgerHash,
    })
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
