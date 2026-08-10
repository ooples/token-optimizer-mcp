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
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CognitiveCostLedger,
  EventStore,
  PreActionController,
  SemanticHarvestController,
  canonicalJson,
  createEvidenceRun,
  createTiktokenCounter,
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
        modelInvocations: directions.length * 4,
        note: 'Each direction uses matched no-capture and in-turn-capture predecessors plus matched control and runtime consumers. Semantic harvesting adds zero model calls.',
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

function runContextPreflight(request, context) {
  const started = Date.now();
  const child = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'ucr-context-preflight.mjs')],
    {
      cwd: context.workspace,
      env: { ...process.env, ...context.environment },
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    }
  );
  if (child.status !== 0) {
    throw new Error(
      `adapter preflight failed before consumer invocation: ${String(
        child.stderr || child.error?.message || ''
      ).trim()}`
    );
  }
  try {
    return {
      ...JSON.parse(child.stdout),
      preflightProcessLatencyMs: Date.now() - started,
    };
  } catch (error) {
    throw new Error(`adapter preflight returned invalid JSON: ${error.message}`);
  }
}

function runCognitionSidecar(request, context) {
  const child = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'ucr-cognition-sidecar.mjs')],
    {
      cwd: context.workspace,
      env: { ...process.env, ...context.environment },
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    }
  );
  if (child.status !== 0) {
    throw new Error(
      `cognition sidecar failed: ${String(
        child.stderr || child.error?.message || ''
      ).trim()}`
    );
  }
  try {
    return JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(`cognition sidecar returned invalid JSON: ${error.message}`);
  }
}

function auditToolSurface(profile, stateRoot) {
  mkdirSync(stateRoot, { recursive: true });
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'handoff-surface-audit', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const child = spawnSync(
    process.execPath,
    [join(ROOT, 'dist', 'server', 'index.js')],
    {
      cwd: stateRoot,
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_TOOL_PROFILE: profile,
        TOKEN_OPTIMIZER_CACHE_DIR: join(stateRoot, 'cache'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(stateRoot, 'wiki'),
        TOKEN_OPTIMIZER_STATE_DIR: join(stateRoot, 'state'),
      },
      input: `${messages.map(JSON.stringify).join('\n')}\n`,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    }
  );
  if (child.status !== 0)
    throw new Error(`failed to audit ${profile} MCP surface: ${child.stderr}`);
  const response = child.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((item) => item.id === 2);
  const tools = response?.result?.tools || [];
  const counter = createTiktokenCounter('cl100k_base');
  try {
    return {
      profile,
      toolNames: tools.map((tool) => tool.name),
      schemaTokens: counter.count(tools),
      tokenAccounting: counter.method,
    };
  } finally {
    counter.close();
  }
}

function collectUsage(text, client = null) {
  if (client === 'claude-code') {
    try {
      const parsed = JSON.parse(text);
      const usage = parsed.usage || {};
      const inputTokens =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0);
      const outputTokens = Number(usage.output_tokens) || 0;
      return {
        inputTokens,
        cachedInputTokens: Number(usage.cache_read_input_tokens) || 0,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: Number.isFinite(parsed.total_cost_usd)
          ? parsed.total_cost_usd
          : null,
        tokenAccounting: 'provider-cli-native-logical-input',
      };
    } catch {
      // Fall through to the generic JSON/JSONL collector.
    }
  }
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

function aggregateUsage(runs, client) {
  const usage = runs.map((run) => collectUsage(run.stdout, client));
  const sum = (key) => {
    const values = usage.map((item) => item[key]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    outputTokens: sum('outputTokens'),
    totalTokens: sum('totalTokens'),
    costUsd: sum('costUsd'),
    tokenAccounting: 'provider-cli-native',
    invocations: runs.length,
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

function guardHookSource(client) {
  const adapterUrl = pathToFileURL(join(ROOT, 'hooks-core', 'adapter.mjs')).href;
  return [
    '#!/usr/bin/env node',
    `import { run } from ${JSON.stringify(adapterUrl)};`,
    `run(${JSON.stringify(client)}, 'pre-tool').catch(() => process.exit(0));`,
    '',
  ].join('\n');
}

function configureClaudeGuardSettings(workspace) {
  const hooksRoot = join(workspace, '.ucr-live-hooks');
  const settingsPath = join(hooksRoot, 'claude-settings.json');
  mkdirSync(hooksRoot, { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|MultiEdit|Write|Bash|PowerShell',
            hooks: [
              {
                type: 'command',
                command: `node ${JSON.stringify(join(hooksRoot, 'pre-tool.mjs'))}`,
              },
            ],
          },
        ],
      },
    })}\n`,
    'utf8'
  );
  writeFileSync(
    join(hooksRoot, 'pre-tool.mjs'),
    guardHookSource('claude-code'),
    'utf8'
  );
  return settingsPath;
}

function configureCodexGuardPlugin(workspace) {
  const codexHome = join(workspace, '.codex-live-home');
  const marketplaceRoot = join(workspace, 'ucr-live-marketplace');
  const marketplaceManifest = join(
    marketplaceRoot,
    '.agents',
    'plugins',
    'marketplace.json'
  );
  const pluginRoot = join(
    marketplaceRoot,
    'plugins',
    'ucr-live-guard'
  );
  const manifestRoot = join(pluginRoot, '.codex-plugin');
  const hooksRoot = join(pluginRoot, 'hooks');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(manifestRoot, { recursive: true });
  mkdirSync(hooksRoot, { recursive: true });
  mkdirSync(dirname(marketplaceManifest), { recursive: true });
  const sourceCodexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  for (const name of ['auth.json', 'cap_sid']) {
    const source = join(sourceCodexHome, name);
    if (existsSync(source)) copyFileSync(source, join(codexHome, name));
  }
  writeFileSync(
    join(manifestRoot, 'plugin.json'),
    `${JSON.stringify({
      name: 'ucr-live-guard',
      version: '1.0.0',
      description: 'Minimal live UCR guard enforcement harness.',
    })}\n`,
    'utf8'
  );
  writeFileSync(
    join(hooksRoot, 'hooks.json'),
    `${JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|edit_file|apply_patch|Write|write_file|Bash|shell|run_command',
            hooks: [
              {
                type: 'command',
                command: 'node "${PLUGIN_ROOT}/hooks/pre-tool.mjs"',
                commandWindows: 'node "$env:PLUGIN_ROOT\\hooks\\pre-tool.mjs"',
                timeout: 5,
              },
            ],
          },
        ],
      },
    })}\n`,
    'utf8'
  );
  writeFileSync(
    join(hooksRoot, 'pre-tool.mjs'),
    guardHookSource('codex'),
    'utf8'
  );
  writeFileSync(
    marketplaceManifest,
    `${JSON.stringify({
      name: 'ucr-live',
      interface: { displayName: 'UCR Live' },
      plugins: [
        {
          name: 'ucr-live-guard',
          source: { source: 'local', path: './plugins/ucr-live-guard' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    })}\n`,
    'utf8'
  );
  const environment = { ...process.env, CODEX_HOME: codexHome };
  for (const args of [
    ['plugin', 'marketplace', 'add', marketplaceRoot],
    ['plugin', 'add', 'ucr-live-guard@ucr-live'],
  ]) {
    const result = spawnSync(commands.codex.command, [...commands.codex.prefix, ...args], {
      cwd: workspace,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error(`failed to configure isolated Codex guard plugin: ${result.stderr}`);
  }
  return codexHome;
}

async function invoke(client, role, prompt, context) {
  const invocation = commands[client];
  const processEnvironment = {
    ...process.env,
    ...context.environment,
    ...(context.guardEnforcement
      ? { TOKEN_OPTIMIZER_EXPERIMENT_ARM: 'baseline' }
      : {}),
  };
  if (client === 'codex' && context.guardEnforcement) {
    processEnvironment.CODEX_HOME = configureCodexGuardPlugin(
      context.workspace
    );
  }
  const attestationEnvironment = context.attestation
    ? {
        ...context.environment,
        TOKEN_OPTIMIZER_TOOL_PROFILE: 'attestation',
      }
    : context.environment;
  if (client === 'codex') {
    const outputSchemaPath = context.outputSchema
      ? join(context.workspace, 'semantic-output-schema.json')
      : null;
    if (outputSchemaPath)
      writeFileSync(
        outputSchemaPath,
        `${JSON.stringify(context.outputSchema, null, 2)}\n`,
        'utf8'
      );
    const trustedArgs = context.trustedContext
      ? [
          '-c',
          `developer_instructions=${tomlLiteral(context.trustedContext)}`,
        ]
      : [];
    const mcpArgs =
      role === 'producer' || context.attestation
        ? [
            '-c',
            `mcp_servers.token-optimizer.command=${tomlLiteral(process.execPath)}`,
            '-c',
            `mcp_servers.token-optimizer.args=[${tomlLiteral(join(ROOT, 'dist', 'server', 'index.js'))}]`,
            '-c',
            `mcp_servers.token-optimizer.env={${Object.entries(
              attestationEnvironment
            )
              .map(([key, value]) => `${key}=${tomlLiteral(value)}`)
              .join(',')}}`,
          ]
        : [];
    return run(
      invocation.command,
      [
        ...invocation.prefix,
        'exec',
        '--json',
        ...(context.guardEnforcement ? [] : ['--ignore-user-config']),
        '--ignore-rules',
        '--ephemeral',
        '--dangerously-bypass-approvals-and-sandbox',
        ...(context.guardEnforcement
          ? ['--dangerously-bypass-hook-trust']
          : []),
        '--model',
        clients[client].model,
        ...(outputSchemaPath ? ['--output-schema', outputSchemaPath] : []),
        ...trustedArgs,
        ...mcpArgs,
        prompt,
      ],
      { cwd: context.workspace, env: processEnvironment }
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
      '--dangerously-skip-permissions',
    ];
    if (role === 'producer' || context.attestation) {
      args.push(
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            'token-optimizer': {
              command: process.execPath,
              args: [join(ROOT, 'dist', 'server', 'index.js')],
              env: attestationEnvironment,
            },
          },
        }),
        '--allowedTools',
        context.attestation
          ? 'mcp__token-optimizer__context_receipt_verify'
          : 'mcp__token-optimizer__cognition_record'
      );
    }
    if (context.outputSchema)
      args.push('--json-schema', JSON.stringify(context.outputSchema));
    if (context.trustedContext)
      args.push('--append-system-prompt', context.trustedContext);
    if (context.guardEnforcement)
      args.push(
        '--settings',
        configureClaudeGuardSettings(context.workspace)
      );
    return run(invocation.command, args, {
      cwd: context.workspace,
      env: processEnvironment,
    });
  }
  const configDirectory = join(context.workspace, 'copilot-config');
  copyCopilotAuthentication(configDirectory);
  const disabledServerArgs = configuredCopilotServers().flatMap((name) => [
    '--disable-mcp-server',
    name,
  ]);
  const effectivePrompt = context.trustedContext
    ? `${context.trustedContext}\n\n${prompt}`
    : prompt;
  const args = [
    ...invocation.prefix,
    '--prompt',
    effectivePrompt,
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
  if (role === 'producer' || context.attestation) {
    args.push(
      '--additional-mcp-config',
      JSON.stringify({
        mcpServers: {
          'ucr-eval': {
            type: 'local',
            command: process.execPath,
            args: [join(ROOT, 'dist', 'server', 'index.js')],
            env: attestationEnvironment,
            tools: context.attestation
              ? ['context_receipt_verify']
              : ['cognition_record'],
          },
        },
      })
    );
  }
  return run(invocation.command, args, {
    cwd: context.workspace,
    env: processEnvironment,
  });
}

function finalResponse(client, stdout) {
  const normalize = (value) => {
    const text = String(value).trim();
    if (
      text.includes('<ucr-semantic-delta>') &&
      text.includes('</ucr-semantic-delta>')
    ) {
      return text;
    }
    const answers = text.match(/IMPLEMENTATION_CHOICE=[A-Z0-9-]+/g);
    return answers?.at(-1) || text;
  };
  if (client === 'copilot') return normalize(stdout);
  if (client === 'claude-code') {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.structured_output)
        return JSON.stringify(parsed.structured_output);
      return normalize(parsed.result || '');
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
const attestationSurface = auditToolSurface(
  'attestation',
  join(temporary, 'attestation-surface-audit')
);
const results = [];
const attemptsPath = join(
  dirname(options.output),
  'live-multimodel-handoff-attempts.jsonl'
);
mkdirSync(dirname(options.output), { recursive: true });
const graderSecret = randomBytes(32).toString('hex');

const fixtureBanner = '// Codex hook runtime.\n';

function fixtureSource(taskId, mode) {
  return [
    `export const taskId = '${taskId}';`,
    `export const mode = '${mode}';`,
    '',
  ].join('\n');
}

function prepareImplementationWorkspace(root, taskId) {
  const sourcePath = join(root, 'hooks-core', 'inject.mjs');
  const generatedPath = join(
    root,
    'integrations',
    'codex',
    'hooks',
    'lib',
    'inject.mjs'
  );
  const syncPath = join(root, 'scripts', 'sync-hooks.mjs');
  const verifyPath = join(root, 'scripts', 'verify-hooks.mjs');
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(generatedPath), { recursive: true });
  mkdirSync(dirname(syncPath), { recursive: true });
  const initialSource = fixtureSource(taskId, 'legacy');
  const syncScript = [
    "import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..');",
    "const sourcePath = join(root, 'hooks-core', 'inject.mjs');",
    "const generatedPath = join(root, 'integrations', 'codex', 'hooks', 'lib', 'inject.mjs');",
    "const source = readFileSync(sourcePath, 'utf8');",
    "const generatedBefore = readFileSync(generatedPath, 'utf8');",
    "const mode = (text) => /export const mode = ['\"]([^'\"]+)['\"]/.exec(text)?.[1] || null;",
    'if (process.env.UCR_FIXTURE_AUDIT_LOG) {',
    "  appendFileSync(process.env.UCR_FIXTURE_AUDIT_LOG, `${JSON.stringify({ operation: 'sync', sourceMode: mode(source), generatedModeBeforeSync: mode(generatedBefore) })}\\n`, 'utf8');",
    '}',
    'mkdirSync(dirname(generatedPath), { recursive: true });',
    `writeFileSync(generatedPath, ${JSON.stringify(fixtureBanner)} + source, 'utf8');`,
    '',
  ].join('\n');
  const verifyScript = [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "import { spawnSync } from 'node:child_process';",
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..');",
    "const sync = spawnSync(process.execPath, [join(root, 'scripts', 'sync-hooks.mjs')], { env: process.env, encoding: 'utf8' });",
    "const source = readFileSync(join(root, 'hooks-core', 'inject.mjs'), 'utf8');",
    "const generated = readFileSync(join(root, 'integrations', 'codex', 'hooks', 'lib', 'inject.mjs'), 'utf8');",
    `const passed = sync.status === 0 && source.includes("export const mode = 'hardened'") && generated === ${JSON.stringify(fixtureBanner)} + source;`,
    'if (process.env.UCR_FIXTURE_AUDIT_LOG) {',
    "  appendFileSync(process.env.UCR_FIXTURE_AUDIT_LOG, `${JSON.stringify({ operation: 'verify', passed })}\\n`, 'utf8');",
    '}',
    "process.stdout.write(passed ? 'verification passed\\n' : 'verification failed\\n');",
    'process.exitCode = passed ? 0 : 1;',
    '',
  ].join('\n');
  writeFileSync(sourcePath, initialSource, 'utf8');
  writeFileSync(generatedPath, `${fixtureBanner}${initialSource}`, 'utf8');
  writeFileSync(syncPath, syncScript, 'utf8');
  writeFileSync(verifyPath, verifyScript, 'utf8');
  return {
    root,
    sourcePath,
    generatedPath,
    syncPath,
    verifyPath,
    protectedHashes: {
      sync: sha256(syncScript),
      verify: sha256(verifyScript),
    },
  };
}

function readFixtureAudit(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function gradeImplementationWorkspace(fixture) {
  const startedAt = performance.now();
  const protectedFilesUnchanged =
    sha256(readFileSync(fixture.syncPath, 'utf8')) ===
      fixture.protectedHashes.sync &&
    sha256(readFileSync(fixture.verifyPath, 'utf8')) ===
      fixture.protectedHashes.verify;
  if (!protectedFilesUnchanged) {
    return {
      passed: false,
      protectedFilesUnchanged: false,
      reason: 'fixture sync or verifier was modified',
      latencyMs: performance.now() - startedAt,
    };
  }
  const verification = spawnSync(process.execPath, [fixture.verifyPath], {
    cwd: fixture.root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const source = readFileSync(fixture.sourcePath, 'utf8');
  const generated = readFileSync(fixture.generatedPath, 'utf8');
  const canonicalSourceChanged = source.includes(
    "export const mode = 'hardened'"
  );
  const generatedSynchronized = generated === `${fixtureBanner}${source}`;
  return {
    passed:
      verification.status === 0 &&
      canonicalSourceChanged &&
      generatedSynchronized,
    protectedFilesUnchanged,
    canonicalSourceChanged,
    generatedSynchronized,
    verifierExitCode: verification.status,
    verifierOutput: String(verification.stdout || '').trim(),
    sourceHash: sha256(source),
    generatedHash: sha256(generated),
    latencyMs: performance.now() - startedAt,
  };
}

function predecessorObservations({
  taskId,
  recoveryCode,
  staleCode,
  auditEvents,
  finalGrade,
}) {
  const staleIndex = auditEvents.findIndex(
    (event) =>
      event.operation === 'sync' &&
      event.sourceMode === 'legacy' &&
      event.generatedModeBeforeSync === 'hardened'
  );
  const failedIndex = auditEvents.findIndex(
    (event, index) =>
      index > staleIndex && event.operation === 'verify' && !event.passed
  );
  const correctionIndex = auditEvents.findIndex(
    (event, index) =>
      index > failedIndex &&
      event.operation === 'sync' &&
      event.sourceMode === 'hardened'
  );
  const passedIndex = auditEvents.findIndex(
    (event, index) =>
      index > correctionIndex && event.operation === 'verify' && event.passed
  );
  const staleAttemptObserved = staleIndex >= 0 && failedIndex > staleIndex;
  const correctionObserved =
    correctionIndex > failedIndex && passedIndex > correctionIndex;
  return {
    trigger: `continuing implementation task ${taskId}`,
    attemptedAction: `apply implementation choice ${staleCode}`,
    observedFailure: `regeneration verifier rejected ${staleCode} after overwriting the direct generated-hook edit`,
    rootCause:
      'client hook copies are generated from hooks-core and direct edits do not survive synchronization',
    correction: `apply verified implementation choice ${recoveryCode}`,
    verificationEvidence: `external audit observed failed regeneration followed by a passing end-state grade for ${recoveryCode}`,
    expectedOutcome: `task ${taskId} updates hooks-core, regenerates clients, and does not repeat ${staleCode}`,
    staleAttemptObserved,
    correctionObserved,
    correctedAttemptAccepted: correctionObserved && finalGrade.passed,
    auditHash: sha256(auditEvents),
    finalGrade,
  };
}

try {
  for (const [producerClient, consumerClient] of directions) {
    const nonce = randomBytes(8).toString('hex');
    const taskId = `multimodel-${producerClient}-${consumerClient}-${nonce}`;
    const recoveryCode = 'EDIT-HOOKS-CORE-THEN-SYNC';
    const staleCode = 'EDIT-GENERATED-CLIENT-HOOK';
    const projectId = `ucr-multimodel-${nonce}`;
    const ucrRoot = join(temporary, taskId, 'ucr');
    const workspace = (role, client) => {
      const path = join(temporary, taskId, `${role}-${client}`);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const predecessorWorkspace = workspace('predecessor', producerClient);
    const controlPredecessorWorkspace = workspace(
      'control-predecessor',
      producerClient
    );
    const predecessorAuditPath = join(
      temporary,
      taskId,
      'predecessor-audit.jsonl'
    );
    const controlPredecessorAuditPath = join(
      temporary,
      taskId,
      'control-predecessor-audit.jsonl'
    );
    const predecessorFixture = prepareImplementationWorkspace(
      predecessorWorkspace,
      taskId
    );
    const controlPredecessorFixture = prepareImplementationWorkspace(
      controlPredecessorWorkspace,
      taskId
    );
    const predecessorTaskPrompt = [
      `Complete implementation task ${taskId} in this repository.`,
      "The generated client hook currently exports mode='legacy'; the required end state is mode='hardened' and must survive regeneration.",
      'For this predecessor-mistake fixture, perform this exact sequence with your file and shell tools:',
      "1. Edit only integrations/codex/hooks/lib/inject.mjs to mode='hardened', then run node scripts/verify-hooks.mjs and observe the expected failure.",
      "2. Correct the mistake by editing hooks-core/inject.mjs to mode='hardened', then run node scripts/verify-hooks.mjs and observe success.",
      'Do not modify scripts/sync-hooks.mjs or scripts/verify-hooks.mjs.',
    ];
    const predecessorPrompt = [
      ...predecessorTaskPrompt,
      `3. After the verifier succeeds, finish with IMPLEMENTATION_CHOICE=${recoveryCode} and semantically harvest the verified correction yourself in this same final response.`,
      'The final response is incomplete unless it contains <ucr-semantic-delta> followed by exactly one minified JSON object and </ucr-semantic-delta>. Do not put a code fence inside the markers. The JSON must stay under 384 tokens.',
      'The JSON must contain non-empty strings trigger, attemptedAction, observedFailure, rootCause, correction, verificationEvidence, expectedOutcome; non-empty string arrays applicability, nonApplicability, invalidators; numeric confidence; confidenceLabel="verified"; scope; and guard.',
      'Use exactly one item in each array. Keep trigger, observedFailure, rootCause, verificationEvidence, expectedOutcome, and every array item at most 48 characters. Keep attemptedAction and correction at most 96 characters. Do not repeat evidence or explain the JSON.',
      `Use exact scope={"taskId":"${taskId}","projectId":"${projectId}","workspaceId":"workspace:${projectId}"}. attemptedAction must include ${staleCode}; correction must include ${recoveryCode}.`,
      'Use exact guard={"triggers":[{"field":"path","operator":"matches","value":"integrations.*codex.*hooks.*lib.*inject\\\\.mjs$"}],"intervention":{"type":"replace-parameters"},"replacementAction":{"path":"hooks-core/inject.mjs","then":"node scripts/verify-hooks.mjs"},"rollback":"disable this guard"}.',
    ].join('\n');
    const controlPredecessorPrompt = [
      ...predecessorTaskPrompt,
      `Finish with IMPLEMENTATION_CHOICE=${recoveryCode}.`,
    ].join('\n');
    console.log(
      `running ${producerClient}->${consumerClient} no-capture predecessor control...`
    );
    const controlPredecessor = await invoke(
      producerClient,
      'predecessor',
      controlPredecessorPrompt,
      {
        workspace: controlPredecessorWorkspace,
        environment: {
          UCR_FIXTURE_AUDIT_LOG: controlPredecessorAuditPath,
        },
      }
    );
    const controlPredecessorGrade = gradeImplementationWorkspace(
      controlPredecessorFixture
    );
    const controlPredecessorObservations = predecessorObservations({
      taskId,
      recoveryCode,
      staleCode,
      auditEvents: readFixtureAudit(controlPredecessorAuditPath),
      finalGrade: controlPredecessorGrade,
    });
    if (
      controlPredecessor.exitCode !== 0 ||
      !controlPredecessorObservations.staleAttemptObserved ||
      !controlPredecessorObservations.correctedAttemptAccepted
    ) {
      throw new Error(
        `${producerClient} did not complete the no-capture predecessor control`
      );
    }
    console.log(
      `running ${producerClient}->${consumerClient} stateful predecessor mistake and correction...`
    );
    const predecessor = await invoke(
      producerClient,
      'predecessor',
      predecessorPrompt,
      {
        workspace: predecessorWorkspace,
        environment: {
          UCR_FIXTURE_AUDIT_LOG: predecessorAuditPath,
        },
      }
    );
    const predecessorGrade = gradeImplementationWorkspace(predecessorFixture);
    const observations = predecessorObservations({
      taskId,
      recoveryCode,
      staleCode,
      auditEvents: readFixtureAudit(predecessorAuditPath),
      finalGrade: predecessorGrade,
    });
    if (
      predecessor.exitCode !== 0 ||
      !observations.staleAttemptObserved ||
      !observations.correctedAttemptAccepted
    ) {
      throw new Error(
        `${producerClient} did not complete the authenticated fail-then-correct predecessor fixture`
      );
    }
    const receipt = signGraderReceipt(
      {
        graderId: 'ucr-stateful-multimodel-implementation-v3',
        passed: true,
        artifactHash: sha256({ taskId, observations }),
        taskId,
        observations,
        issuedAt: new Date().toISOString(),
      },
      graderSecret
    );
    const baseEnvironment = {
      TOKEN_OPTIMIZER_TOOL_PROFILE: 'continuity',
      TOKEN_OPTIMIZER_UCR_DIR: ucrRoot,
      TOKEN_OPTIMIZER_PROJECT_ID: projectId,
      TOKEN_OPTIMIZER_WORKSPACE_ID: `workspace:${projectId}`,
      TOKEN_OPTIMIZER_TASK_ID: taskId,
      TOKEN_OPTIMIZER_GRADER_SECRET: graderSecret,
    };
    const controlWorkspace = workspace('control', consumerClient);
    const consumerWorkspace = workspace('consumer', consumerClient);
    const controlAuditPath = join(temporary, taskId, 'control-audit.jsonl');
    const consumerAuditPath = join(temporary, taskId, 'consumer-audit.jsonl');
    const controlFixture = prepareImplementationWorkspace(
      controlWorkspace,
      taskId
    );
    const consumerFixture = prepareImplementationWorkspace(
      consumerWorkspace,
      taskId
    );
    const controlPrompt = [
      `Complete implementation task ${taskId} in this repository.`,
      "In integrations/codex/hooks/lib/inject.mjs, change the Codex hook behavior from mode='legacy' to mode='hardened'.",
      'Inspect the repository, make the necessary edits, and run the verifier.',
      'Do not modify scripts/sync-hooks.mjs or scripts/verify-hooks.mjs.',
      'This blinded control has no cross-session task evidence.',
      'Finish by reporting IMPLEMENTATION_CHOICE=<the approach you used>.',
    ].join('\n');
    // The control and runtime receive byte-identical user prompts. The only
    // treatment is the host-authenticated, bounded pre-action capsule.
    const consumerPrompt = controlPrompt;

    console.log(
      `running ${producerClient}->${consumerClient} blinded control...`
    );
    const control = await invoke(consumerClient, 'baseline', controlPrompt, {
      workspace: controlWorkspace,
      environment: { UCR_FIXTURE_AUDIT_LOG: controlAuditPath },
    });
    console.log(
      `committing ${producerClient}->${consumerClient} in-turn semantic delta...`
    );
    const producerContext = {
      workspace: predecessorWorkspace,
      environment: {
        ...baseEnvironment,
        TOKEN_OPTIMIZER_CLIENT: producerClient,
        TOKEN_OPTIMIZER_AGENT_ID: `producer-${producerClient}`,
        TOKEN_OPTIMIZER_MODEL: clients[producerClient].model,
      },
    };
    const harvestController = new SemanticHarvestController({
      maximumDeltaTokens: 384,
      verifyEvidence: async ({ evidenceReceipts }) =>
        runCognitionSidecar(
          { operation: 'verify-evidence', evidenceReceipts },
          producerContext
        ),
      persist: async (request) =>
        runCognitionSidecar(request, producerContext),
    });
    const harvest = await harvestController.commitAuthoredDelta({
      kind: 'failure',
      raw: finalResponse(producerClient, predecessor.stdout),
      evidenceReceipts: [receipt],
      evidenceBindings: [
        { path: 'attemptedAction', includes: staleCode },
        { path: 'correction', includes: recoveryCode },
      ],
      taskId,
      sessionId: 'producer-session',
      scope: {
        taskId,
        projectId,
        workspaceId: `workspace:${projectId}`,
      },
    });
    const guardIndexPath = join(ucrRoot, 'active-guards.json');
    const guardIndex = existsSync(guardIndexPath)
      ? JSON.parse(readFileSync(guardIndexPath, 'utf8'))
      : null;
    const guardMaterialized = Boolean(
      guardIndex?.guards?.some(
        (guard) => guard.sourceObjectId === harvest.persisted.object?.id
      )
    );
    console.log(
      `running ${producerClient}->${consumerClient} mandatory preflight and consumer...`
    );
    const consumerContext = {
      workspace: consumerWorkspace,
      environment: {
        ...baseEnvironment,
        TOKEN_OPTIMIZER_CLIENT: consumerClient,
        TOKEN_OPTIMIZER_AGENT_ID: `consumer-${consumerClient}`,
        TOKEN_OPTIMIZER_MODEL: clients[consumerClient].model,
        UCR_FIXTURE_AUDIT_LOG: consumerAuditPath,
      },
    };
    const controller = new PreActionController({
      hardMaximumTokens: 160,
      injectionChannel:
        consumerClient === 'claude-code'
          ? 'claude-host-appended-system-prompt'
          : consumerClient === 'codex'
            ? 'codex-developer-instructions'
            : 'host-preaction-prompt-envelope',
      consumerMcpExposed: false,
      staticSchemaTokens: 0,
      exposedTools: [],
      retrieve: async (request) =>
        runContextPreflight(request, consumerContext),
    });
    const takeover = await controller.invoke(
      {
        query: `continuing implementation task ${taskId}`,
        taskId,
        sessionId: 'consumer-session',
        trigger: 'task',
        budget: 160,
        prompt: consumerPrompt,
      },
      ({ prompt, trustedContext }) =>
        invoke(consumerClient, 'consumer', prompt, {
          ...consumerContext,
          trustedContext,
          attestation: false,
          guardEnforcement: true,
        })
    );
    const consumer = takeover.result;
    const preAction = takeover.preAction;
    const events = new EventStore(ucrRoot).read().events;
    const activated = events.filter(
      (event) => event.type === 'finding.activated'
    );
    const deliveries = events.filter(
      (event) => event.type === 'context.delivered'
    );
    const controlAnswer = finalResponse(consumerClient, control.stdout);
    const consumerAnswer = finalResponse(consumerClient, consumer.stdout);
    const controlGrade = gradeImplementationWorkspace(controlFixture);
    const consumerGrade = gradeImplementationWorkspace(consumerFixture);
    const controlAuditEvents = readFixtureAudit(controlAuditPath);
    const consumerAuditEvents = readFixtureAudit(consumerAuditPath);
    const guardAuditEvents = readFixtureAudit(
      join(ucrRoot, 'guard-audit.jsonl')
    );
    const guardEnforced = guardAuditEvents.some(
      (event) =>
        event.taskId === taskId &&
        event.decision === 'deny' &&
        event.executed === false
    );
    const generatedOnlyAttempt = (auditEvents) =>
      auditEvents.some(
        (event) =>
          event.operation === 'sync' &&
          event.sourceMode === 'legacy' &&
          event.generatedModeBeforeSync === 'hardened'
      );
    const controlCorrect = controlGrade.passed;
    const controlAbstained =
      controlAnswer === 'IMPLEMENTATION_CHOICE=ABSTAIN';
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
        event.eventId === preAction.deliveryEventId &&
        event.actor.client === consumerClient &&
        event.payload?.action === 'deliver' &&
        event.payload?.objectIds?.length > 0
    );
    const attested = events.some(
      (event) =>
        event.type === 'verification.passed' &&
        event.actor.client === consumerClient &&
        event.payload?.operation === 'context-receipt-attestation' &&
        event.payload?.deliveryEventId === preAction.deliveryEventId
    );
    const attestationFailed = events.some(
      (event) =>
        event.type === 'verification.failed' &&
        event.actor.client === consumerClient &&
        event.payload?.operation === 'context-receipt-attestation' &&
        event.payload?.deliveryEventId === preAction.deliveryEventId
    );
    const consumerCorrect = consumerGrade.passed;
    const repeatedFailure = generatedOnlyAttempt(consumerAuditEvents);
    const controlPredecessorUsage = collectUsage(
      controlPredecessor.stdout,
      producerClient
    );
    const predecessorUsage = collectUsage(predecessor.stdout, producerClient);
    const controlConsumerUsage = collectUsage(control.stdout, consumerClient);
    const runtimeConsumerUsage = collectUsage(consumer.stdout, consumerClient);
    const costLedger = ({ runtime }) => {
      const ledger = new CognitiveCostLedger({
        runId: `${taskId}:${runtime ? 'runtime' : 'control'}`,
      });
      ledger.record({
        phase: 'schema',
        inputTokens: 0,
        accountingMethod: 'consumer-tools-list:tiktoken',
        detail: { exposedTools: 0 },
      });
      const producerUsage = runtime
        ? predecessorUsage
        : controlPredecessorUsage;
      ledger.record({
        phase: 'capture',
        inputTokens: producerUsage.inputTokens,
        outputTokens: producerUsage.outputTokens,
        latencyMs:
          (runtime ? predecessor.latencyMs : controlPredecessor.latencyMs) +
          (runtime ? harvest.receipt.hostLatencyMs : 0),
        modelCalls: 1,
        accountingMethod: producerUsage.tokenAccounting,
        detail: runtime
          ? {
              semanticDeltaTokens: harvest.receipt.deltaTokens,
              additionalModelCalls: harvest.receipt.additionalModelCalls,
            }
          : { semanticDeltaTokens: 0, additionalModelCalls: 0 },
      });
      ledger.record({
        phase: 'retrieval',
        latencyMs: runtime ? preAction.latencyMs : 0,
        toolCalls: runtime ? 1 : 0,
        accountingMethod: 'host-preaction-timer',
      });
      ledger.record({
        phase: 'injection',
        inputTokens: runtime ? preAction.injectionTokens : 0,
        accountingMethod: 'trusted-context:utf8-length-div-4',
        includedInTotal: false,
        detail: {
          alreadyIncludedInConsumerInput: true,
          capsuleTokens: runtime ? preAction.capsuleTokens : 0,
        },
      });
      const consumerUsage = runtime
        ? runtimeConsumerUsage
        : controlConsumerUsage;
      ledger.record({
        phase: 'consumer',
        inputTokens: consumerUsage.inputTokens,
        outputTokens: consumerUsage.outputTokens,
        latencyMs: runtime ? consumer.latencyMs : control.latencyMs,
        modelCalls: 1,
        accountingMethod: consumerUsage.tokenAccounting,
      });
      ledger.record({
        phase: 'validation',
        latencyMs: runtime
          ? predecessorGrade.latencyMs + consumerGrade.latencyMs
          : controlPredecessorGrade.latencyMs + controlGrade.latencyMs,
        toolCalls: 2,
        accountingMethod: 'independent-grader-timer',
      });
      return ledger.report();
    };
    const controlCostLedger = costLedger({ runtime: false });
    const runtimeCostLedger = costLedger({ runtime: true });
    const passed =
      control.exitCode === 0 &&
      controlPredecessor.exitCode === 0 &&
      controlPredecessorObservations.correctedAttemptAccepted &&
      predecessor.exitCode === 0 &&
      consumer.exitCode === 0 &&
      observations.staleAttemptObserved &&
      observations.correctedAttemptAccepted &&
      producerRecorded &&
      harvest.receipt.modelAuthored &&
      harvest.receipt.authoredDuringWorkTurn &&
      harvest.receipt.evidenceAuthenticatedBeforeActivation &&
      harvest.receipt.additionalModelCalls === 0 &&
      guardMaterialized &&
      delivered &&
      preAction.retrievalAttempted &&
      !preAction.consumerMcpExposed &&
      preAction.exposedTools.length === 0 &&
      preAction.staticSchemaTokens === 0 &&
      !attestationFailed &&
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
        mistakeExecuted: generatedOnlyAttempt(controlAuditEvents),
        outcomeGrade: controlGrade,
        usage: controlConsumerUsage,
        latencyMs: control.latencyMs,
        predecessorUsage: controlPredecessorUsage,
        predecessorLatencyMs: controlPredecessor.latencyMs,
        costLedger: controlCostLedger,
        pipelineUsage: {
          ...controlCostLedger.totals,
          tokenAccounting: 'phase-ledger:provider-native',
        },
      },
      producer: {
        exitCode: predecessor.exitCode,
        recorded: producerRecorded,
        modelAuthored: harvest.receipt.modelAuthored,
        authoredDuringWorkTurn: harvest.receipt.authoredDuringWorkTurn,
        evidenceAuthenticatedBeforeActivation:
          harvest.receipt.evidenceAuthenticatedBeforeActivation,
        additionalModelCalls: harvest.receipt.additionalModelCalls,
        guardMaterialized,
        predecessorMistakeObserved: observations.staleAttemptObserved,
        predecessorCorrectionVerified:
          observations.correctedAttemptAccepted,
        predecessorEvidence: observations,
        semanticHarvestReceipt: harvest.receipt,
        workUsage: predecessorUsage,
        harvestUsage: {
          inputTokens: 0,
          outputTokens: harvest.receipt.deltaTokens,
          totalTokens: harvest.receipt.deltaTokens,
          modelCalls: 0,
          tokenAccounting: 'model-output-delta:tiktoken-compatible-estimate',
        },
        usage: predecessorUsage,
        latencyMs: predecessor.latencyMs,
        harvestHostLatencyMs: harvest.receipt.hostLatencyMs,
      },
      runtime: {
        exitCode: consumer.exitCode,
        correct: consumerCorrect,
        delivered,
        selected: preAction.delivered,
        retrievalAttempted: preAction.retrievalAttempted,
        attested,
        attestationFailed,
        deliveryPhase: 'adapter-pre-action',
        nativeGuardWired: true,
        nativeGuardEnforced: guardEnforced,
        nativeGuardAuditEvents: guardAuditEvents.length,
        mistakeExecuted: repeatedFailure,
        outcomeGrade: consumerGrade,
        usage: {
          ...runtimeConsumerUsage,
          staticSchemaTokens: preAction.staticSchemaTokens,
          capsuleTokens: preAction.capsuleTokens,
          instructionTokens: preAction.injectionTokens,
        },
        latencyMs: consumer.latencyMs,
        preflightLatencyMs: preAction.latencyMs,
        firstSuccessorCost: {
          captureTokens: harvest.receipt.deltaTokens,
          additionalModelCalls: harvest.receipt.additionalModelCalls,
          hostCaptureLatencyMs: harvest.receipt.hostLatencyMs,
        },
        costLedger: runtimeCostLedger,
        pipelineUsage: {
          ...runtimeCostLedger.totals,
          tokenAccounting: 'phase-ledger:provider-native',
        },
        consumerMcpExposed: preAction.consumerMcpExposed,
        preActionReceipt: preAction,
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
          .replaceAll(recoveryCode, '[SAFE_CHOICE_REDACTED]')
          .replaceAll(staleCode, '[REJECTED_CHOICE_REDACTED]')
          .replaceAll(graderSecret, '[GRADER_SECRET_REDACTED]')
          .slice(-3000);
      console.error(
        `${row.direction} predecessor: ${redact(predecessor.stdout)}`
      );
      console.error(
        `${row.direction} predecessor stderr: ${redact(predecessor.stderr)}`
      );
      console.error(`${row.direction} consumer: ${redact(consumer.stdout)}`);
      console.error(
        `${row.direction} consumer stderr: ${redact(consumer.stderr)}`
      );
    }
  }

  const sourceTreeHash = sha256([
    readFileSync(join(ROOT, 'ucr', 'protocol.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'event-store.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'graph.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'compiler.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'checkpoint.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'retrieval.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'context-vm.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'pre-action.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'ucr', 'semantic-harvest.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'src', 'server', 'ucr-tools.ts'), 'utf8'),
    readFileSync(join(ROOT, 'src', 'server', 'tool-profile.ts'), 'utf8'),
    readFileSync(join(ROOT, 'src', 'validation', 'tool-schemas.ts'), 'utf8'),
    readFileSync(join(ROOT, 'scripts', 'ucr-context-preflight.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'scripts', 'ucr-cognition-sidecar.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
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
    attestationSurface,
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
      'mandatory adapter preflight is evaluated here; advisory-only clients require separate evidence and cannot claim guaranteed prevention',
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
