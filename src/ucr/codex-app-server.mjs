import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createModelAttestation } from './model-attestation.mjs';
import { parseStructuredModelJson } from './live-study-driver.mjs';
import { sha256 } from './protocol.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function isolatedCodexEnvironment(environment) {
  const root = mkdtempSync(join(tmpdir(), 'ucr-codex-home-'));
  const sourceHome =
    environment?.CODEX_HOME ||
    (environment?.USERPROFILE
      ? join(environment.USERPROFILE, '.codex')
      : null);
  const sourceAuth = sourceHome ? join(sourceHome, 'auth.json') : null;
  const targetAuth = join(root, 'auth.json');
  if (sourceAuth && existsSync(sourceAuth)) {
    copyFileSync(sourceAuth, targetAuth);
    chmodSync(targetAuth, 0o600);
  }
  return {
    root,
    targetAuth,
    environment: { ...environment, CODEX_HOME: root },
  };
}

function confinedPath(root, requested) {
  if (typeof requested !== 'string' || !requested.trim())
    throw new Error('path must be a non-empty string');
  if (isAbsolute(requested)) throw new Error('absolute paths are not allowed');
  const target = resolve(root, requested);
  const relation = relative(resolve(root), target);
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error('path escapes the isolated workspace');
  return target;
}

function workspaceFiles(root, current = root, output = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (output.length >= 200) break;
    const path = join(current, entry.name);
    const name = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      output.push({ path: name, type: 'symlink' });
    } else if (entry.isDirectory()) {
      workspaceFiles(root, path, output);
    } else if (entry.isFile()) {
      output.push({ path: name, type: 'file', bytes: statSync(path).size });
    }
  }
  return output;
}

export function codexStudyDynamicTools(allowWrite) {
  return [
    {
      type: 'function',
      name: 'list_workspace',
      description:
        'List files in the isolated evaluation workspace. Returns relative paths and byte sizes.',
      inputSchema: { type: 'object', additionalProperties: false },
    },
    {
      type: 'function',
      name: 'read_file',
      description:
        'Read one UTF-8 file from the isolated evaluation workspace using a relative path.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 } },
      },
    },
    ...(allowWrite
      ? [
          {
            type: 'function',
            name: 'write_result',
            description:
              'Write the final result.json. This is the only allowed workspace mutation.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['answer', 'receipts'],
              properties: {
                answer: { type: 'string' },
                receipts: {
                  type: 'array',
                  maxItems: 100,
                  items: { type: 'string' },
                },
              },
            },
          },
        ]
      : []),
  ];
}

export function executeCodexStudyDynamicTool(
  { tool, arguments: input },
  root,
  allowWrite
) {
  const args = input && typeof input === 'object' ? input : {};
  if (tool === 'list_workspace') return { files: workspaceFiles(root) };
  if (tool === 'read_file') {
    const target = confinedPath(root, args.path);
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const relation = relative(realRoot, realTarget);
    if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
      throw new Error('resolved file escapes the isolated workspace');
    const bytes = statSync(realTarget).size;
    if (bytes > 1024 * 1024) throw new Error('file exceeds 1 MiB read limit');
    return { path: args.path, content: readFileSync(realTarget, 'utf8') };
  }
  if (tool === 'write_result' && allowWrite) {
    if (
      typeof args.answer !== 'string' ||
      !Array.isArray(args.receipts) ||
      args.receipts.some((receipt) => typeof receipt !== 'string')
    )
      throw new Error('write_result requires answer and string receipts');
    writeFileSync(
      join(root, 'result.json'),
      `${JSON.stringify({ answer: args.answer, receipts: args.receipts }, null, 2)}\n`,
      'utf8'
    );
    return { written: 'result.json' };
  }
  throw new Error(`unsupported study tool ${tool}`);
}

function rpcError(message, details = '') {
  const error = new Error(`${message}${details ? `: ${details}` : ''}`);
  error.name = 'CodexAppServerError';
  return error;
}

/** Execute one isolated Codex turn and retain only bounded provider telemetry. */
export async function invokeCodexAppServer({
  command,
  prefix = [],
  cwd,
  env,
  timeoutMs,
  prompt,
  model,
  outputSchema = null,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  const startedAtMs = Date.now();
  const allowWrite = outputSchema == null;
  const isolated = isolatedCodexEnvironment(env);
  const child = spawn(
    command,
    [...prefix, 'app-server', '--listen', 'stdio://'],
    {
      cwd,
      env: isolated.environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];
  const stderr = [];
  let stdoutBuffer = '';
  let outputBytes = 0;
  let nextId = 1;
  let finished = false;
  let processClosed = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const fail = (error) => {
    if (finished) return;
    finished = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const waiter of notificationWaiters) waiter.reject(error);
    notificationWaiters.length = 0;
  };
  const send = (message) => {
    if (finished || child.stdin.destroyed)
      throw rpcError('Codex app-server stdin closed');
    child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(String(id), { resolve, reject, method });
      send({ jsonrpc: '2.0', id, method, params });
    });
  const notify = (method, params = {}) =>
    send({ jsonrpc: '2.0', method, params });
  const waitForNotification = (method, predicate = () => true) => {
    const existing = notifications.find(
      (notification) =>
        notification.method === method && predicate(notification.params)
    );
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) =>
      notificationWaiters.push({ method, predicate, resolve, reject })
    );
  };
  const receive = (message) => {
    if (message?.id != null && (message.result !== undefined || message.error)) {
      const waiter = pending.get(String(message.id));
      if (!waiter) return;
      pending.delete(String(message.id));
      if (message.error)
        waiter.reject(
          rpcError(
            `Codex app-server ${waiter.method} failed`,
            message.error.message || JSON.stringify(message.error)
          )
        );
      else waiter.resolve(message.result);
      return;
    }
    if (message?.id != null && message?.method) {
      if (message.method === 'item/tool/call') {
        try {
          const result = executeCodexStudyDynamicTool(
            message.params || {},
            cwd,
            allowWrite
          );
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              success: true,
              contentItems: [
                { type: 'inputText', text: JSON.stringify(result) },
              ],
            },
          });
        } catch (error) {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: String(error?.message || error),
                },
              ],
            },
          });
        }
        return;
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `study client does not implement ${message.method}`,
        },
      });
      return;
    }
    if (!message?.method) return;
    notifications.push(message);
    for (let index = notificationWaiters.length - 1; index >= 0; index--) {
      const waiter = notificationWaiters[index];
      if (waiter.method !== message.method || !waiter.predicate(message.params))
        continue;
      notificationWaiters.splice(index, 1);
      waiter.resolve(message.params);
    }
  };
  const collect = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      fail(rpcError('Codex app-server output exceeded bounded limit'));
      child.kill();
      return;
    }
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        receive(JSON.parse(line));
      } catch {
        fail(rpcError('Codex app-server emitted invalid JSONL'));
        child.kill();
        return;
      }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      fail(rpcError('Codex app-server output exceeded bounded limit'));
      child.kill();
      return;
    }
    stderr.push(chunk);
  });
  child.once('error', (error) => fail(error));
  child.once('close', (exitCode, signal) => {
    processClosed = true;
    resolveClosed();
    if (!finished)
      fail(
        rpcError(
          'Codex app-server exited before turn completion',
          `exit=${exitCode} signal=${signal}`
        )
      );
  });
  const timer = setTimeout(() => {
    fail(rpcError('Codex app-server invocation timed out'));
    child.kill();
  }, timeoutMs);

  try {
    await request('initialize', {
      clientInfo: {
        name: 'ucr-study-driver',
        title: 'UCR Study Driver',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: true },
    });
    notify('initialized');
    const catalog = await request('model/list', {
      includeHidden: true,
      limit: 100,
    });
    const catalogEntry = catalog?.data?.find(
      (entry) => entry?.model === model || entry?.id === model
    );
    if (!catalogEntry)
      throw rpcError(`frozen Codex model ${model} is absent from model/list`);
    const threadStart = await request('thread/start', {
      allowProviderModelFallback: false,
      approvalPolicy: 'never',
      config: { mcp_servers: {} },
      cwd,
      dynamicTools: codexStudyDynamicTools(allowWrite),
      environments: [],
      ephemeral: true,
      model,
      modelProvider: 'openai',
      sandbox: 'danger-full-access',
      serviceName: 'ucr-study-driver',
    });
    if (threadStart?.model !== model)
      throw rpcError(
        `Codex selected ${threadStart?.model || 'no model'} instead of ${model}`
      );
    if (threadStart?.modelProvider !== 'openai')
      throw rpcError(
        `Codex selected unexpected provider ${threadStart?.modelProvider}`
      );
    const threadId = threadStart?.thread?.id;
    if (!threadId) throw rpcError('Codex thread/start omitted thread id');
    const turnStart = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      model,
      ...(outputSchema ? { outputSchema } : {}),
    });
    const turnId = turnStart?.turn?.id;
    if (!turnId) throw rpcError('Codex turn/start omitted turn id');
    const completed = await waitForNotification(
      'turn/completed',
      (params) => params?.threadId === threadId && params?.turn?.id === turnId
    );
    const matching = notifications.filter(
      (notification) =>
        notification.params?.threadId === threadId &&
        (!notification.params?.turnId || notification.params.turnId === turnId)
    );
    const messages = matching
      .filter(
        (notification) =>
          notification.method === 'item/completed' &&
          notification.params?.item?.type === 'agentMessage'
      )
      .map((notification) => notification.params.item.text);
    const usageNotification = matching
      .filter(
        (notification) => notification.method === 'thread/tokenUsage/updated'
      )
      .at(-1);
    const usage = usageNotification?.params?.tokenUsage?.last || {};
    const reroutes = matching
      .filter((notification) => notification.method === 'model/rerouted')
      .map((notification) => notification.params);
    const finalText = messages.at(-1) || null;
    const providerTelemetry = {
      catalogEntry,
      cliVersion: threadStart.thread.cliVersion,
      model: threadStart.model,
      modelProvider: threadStart.modelProvider,
      activePermissionProfile: threadStart.activePermissionProfile,
      approvalPolicy: threadStart.approvalPolicy,
      sandbox: threadStart.sandbox,
      threadId,
      turnId,
      turnStatus: completed?.turn?.status,
      instructionSources: threadStart.instructionSources,
      reroutes,
    };
    const endedAtMs = Date.now();
    finished = true;
    child.stdin.end();
    return {
      exitCode: completed?.turn?.status === 'completed' ? 0 : 1,
      signal: null,
      timedOut: false,
      overflow: false,
      startedAtMs,
      endedAtMs,
      stdout: '',
      stderr: Buffer.concat(stderr).toString('utf8'),
      client: 'codex',
      finalText,
      structuredOutput: parseStructuredModelJson(finalText),
      providerRequestId: threadId,
      model: threadStart.model,
      usage: {
        inputTokens: Number.isFinite(usage.inputTokens)
          ? usage.inputTokens
          : null,
        cachedInputTokens: Number.isFinite(usage.cachedInputTokens)
          ? usage.cachedInputTokens
          : null,
        cacheCreationInputTokens: Number.isFinite(usage.cacheWriteInputTokens)
          ? usage.cacheWriteInputTokens
          : null,
        effectiveInputTokens: Number.isFinite(usage.inputTokens)
          ? usage.inputTokens
          : null,
        outputTokens: Number.isFinite(usage.outputTokens)
          ? usage.outputTokens
          : null,
        totalTokens: Number.isFinite(usage.totalTokens)
          ? usage.totalTokens
          : null,
        costUsd: null,
      },
      actionAudit: matching
        .filter(
          (notification) =>
            notification.method === 'item/completed' &&
            /commandExecution|fileChange|mcpToolCall|dynamicToolCall/.test(
              notification.params?.item?.type || ''
            )
        )
        .map((notification) => ({
          type: notification.params.item.type,
          server: notification.params.item.server || null,
          tool: notification.params.item.tool || null,
          eventHash: sha256(notification.params.item),
        })),
      outputHash: sha256(providerTelemetry),
      modelAttestation: createModelAttestation({
        client: 'codex',
        provider: threadStart.modelProvider,
        requestedModel: model,
        effectiveModel: threadStart.model,
        source: 'codex-app-server/thread-start',
        providerRequestId: threadId,
        reroutes,
        evidence: providerTelemetry,
      }),
      executionPolicy: {
        activePermissionProfile: threadStart.activePermissionProfile,
        approvalPolicy: threadStart.approvalPolicy,
        sandbox: threadStart.sandbox,
      },
      cliVersion: threadStart.thread.cliVersion,
    };
  } finally {
    clearTimeout(timer);
    rmSync(isolated.targetAuth, { force: true });
    if (!finished) {
      finished = true;
      child.stdin.end();
    }
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (!processClosed) {
      child.kill();
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    rmSync(isolated.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
