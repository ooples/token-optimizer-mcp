#!/usr/bin/env node
/** Live Codex comparison. Uses installed binaries, isolated task directories,
 * rotated arm order, independent answer checks, and Codex's reported usage.
 * Run after npm run build. No API key or persistent client configuration edits.
 * CODEX_BIN may name the Codex executable (or its npm bin/codex.js entrypoint).
 * CODEX_BENCH_MODEL defaults to the model in the user's config.toml.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@iarna/toml';
import { readEvidence, outerEnvelopeTruncated } from './codex-output.mjs';
import { fixture as developmentFixture } from './codex-fixtures.mjs';
import {
  workflow as developmentWorkflow,
  workflowTasks,
  validateWorkflow as validateDevelopmentWorkflow,
} from './codex-workflows.mjs';
import {
  heldoutFixture,
  heldoutWorkflow,
  validateHeldoutWorkflow,
} from './heldout-cases.mjs';

import { adversarialFixture, adversarialTasks } from './adversarial-cases.mjs';
import { provenance } from './codex-provenance.mjs';
import { mcpRefreshEvidence } from './codex-mcp-evidence.mjs';
import { monitorHostMemory, memoryPolicy } from './host-memory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const caseSuite = process.env.CASE_SUITE || 'development';
if (!['development', 'heldout-v1', 'adversarial-v1'].includes(caseSuite))
  throw Error('Unknown CASE_SUITE');
const fixture =
  caseSuite === 'adversarial-v1'
    ? adversarialFixture
    : caseSuite === 'heldout-v1'
      ? heldoutFixture
      : developmentFixture;
const workflow =
  caseSuite !== 'development' ? heldoutWorkflow : developmentWorkflow;
const validateWorkflow =
  caseSuite !== 'development'
    ? validateHeldoutWorkflow
    : validateDevelopmentWorkflow;
const arms = (process.env.ARMS || 'control,proxy,headroom').split(',');
const reps = Number(process.env.REPS || arms.length);
const seedOffset = Number(process.env.SEED_OFFSET || 0);
if (!Number.isInteger(seedOffset) || seedOffset < 0)
  throw Error('Invalid SEED_OFFSET');

const tasks = (process.env.TASKS || 'logs,json,code').split(',');
const readMode = process.env.READ_MODE || 'natural';
const truncatedRead = ['truncated', 'outer-truncated'].includes(readMode);
const mcpDiscovery = process.env.MCP_DISCOVERY || 'bounded';
if (!['bounded', 'legacy'].includes(mcpDiscovery))
  throw Error('Invalid MCP_DISCOVERY');
if (
  !['natural', 'truncated', 'outer-truncated', 'mcp', 'mixed'].includes(
    readMode
  ) ||
  (readMode !== 'natural' && tasks.some((t) => t !== 'refresh')) ||
  (readMode === 'mcp' &&
    arms.some((a) => !['mcp', 'full', 'full-files'].includes(a)))
)
  throw Error(
    'Invalid READ_MODE: truncated/mcp/mixed require refresh; mcp requires MCP-enabled arms'
  );

if (
  !Number.isInteger(reps) ||
  reps < 1 ||
  arms.some(
    (a) =>
      !['control', 'proxy', 'headroom', 'mcp', 'full', 'full-files'].includes(a)
  )
)
  throw Error('Invalid REPS or ARMS');
if (new Set(arms).size !== arms.length || new Set(tasks).size !== tasks.length)
  throw Error('Duplicate arms or tasks');
if (
  tasks.some(
    (t) =>
      ![
        'logs',
        'json',
        'code',
        ...(caseSuite === 'adversarial-v1' ? adversarialTasks : []),
        ...workflowTasks,
      ].includes(t)
  )
)
  throw Error('Unknown task');
const out = process.env.OUT
  ? resolve(process.env.OUT)
  : await mkdtemp(join(tmpdir(), 'codex-ab-'));
await mkdir(out, { recursive: true });
// Each invocation gets a new directory, even with OUT, so existing evidence is retained.
const campaign = await mkdtemp(join(out, 'run-'));
let config = {};
try {
  config = parse(
    await readFile(
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
      'utf8'
    )
  );
} catch {}
const model = process.env.CODEX_BENCH_MODEL || config.model;
if (!model) throw Error('Set CODEX_BENCH_MODEL or configure a Codex model');
const codex =
  process.env.CODEX_BIN ||
  (process.platform === 'win32'
    ? join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')
    : 'codex');
const active = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function launch(command, args, cwd, env, prefix) {
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  active.add(child);
  child.stdin.end();
  const stdout = createWriteStream(prefix + '.stdout');
  const stderr = createWriteStream(prefix + '.stderr');
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const done = new Promise((resolveDone) => {
    child.once('error', (error) => {
      active.delete(child);
      stderr.end(String(error));
      resolveDone({ code: null, error: String(error) });
    });
    child.once('close', (code) => {
      active.delete(child);
      resolveDone({ code });
    });
  });
  return { child, done };
}
async function stop(child) {
  if (!active.has(child)) return;
  if (process.platform === 'win32') {
    await new Promise((r) => {
      const killer = spawn(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      );
      killer.once('error', r);
      killer.once('close', r);
    });
  } else child.kill('SIGTERM');
}
async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
async function ready(port, child) {
  for (let i = 0; i < 720; i++) {
    if (!active.has(child)) throw Error('Proxy exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      return;
    } catch {}
    await delay(250);
  }
  throw Error('Proxy readiness timed out');
}
// Workloads and answer keys are shared with the independent report validator.
function usage(events) {
  const turns = events.filter((e) => e.type === 'turn.completed' && e.usage);
  if (!turns.length) return null;
  return turns.reduce(
    (a, e) => ({
      input: a.input + e.usage.input_tokens,
      cached: a.cached + (e.usage.cached_input_tokens || 0),
      output: a.output + e.usage.output_tokens,
    }),
    { input: 0, cached: 0, output: 0 }
  );
}
async function jsonl(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const proxyBin = process.env.PROXY_BIN || join(root, 'dist/proxy/cli.js');
await writeFile(
  join(campaign, 'provenance.json'),
  JSON.stringify(
    await provenance(root, codex, process.env.PYTHON || 'python', proxyBin),
    null,
    2
  )
);

const results = [];
console.log(
  JSON.stringify({
    campaign,
    model,
    arms,
    reps,
    tasks,
    balanced: reps % arms.length === 0,
  })
);
await writeFile(
  join(campaign, 'manifest.json'),
  JSON.stringify(
    {
      model,
      arms,
      reps,
      tasks,
      balanced: reps % arms.length === 0,
      seedOffset,
      readMode,
      mcpDiscovery,
      caseSuite,
      hostMemoryPolicy: process.platform === 'win32' ? memoryPolicy : null,
      started: new Date().toISOString(),
    },
    null,
    2
  )
);
const memoryMonitor = await monitorHostMemory(campaign);
try {
  for (const task of tasks)
    for (let rep = 0; rep < reps; rep++)
      for (let position = 0; position < arms.length; position++) {
        const arm = arms[(position + rep) % arms.length];
        await memoryMonitor.assertReady({ task, rep: rep + 1, arm });
        const artifacts = join(campaign, `${task}-${rep + 1}-${arm}`);
        const work = join(artifacts, 'workspace');
        await mkdir(work, { recursive: true });
        const natural = workflowTasks.includes(task);
        const seed = seedOffset + rep + 1;
        const f = natural ? workflow(task, seed) : fixture(task, seed);
        for (const [name, content] of Object.entries(
          natural ? f.files : { [f.name]: f.content }
        )) {
          await mkdir(dirname(join(work, name)), { recursive: true });
          await writeFile(join(work, name), content);
        }
        await writeFile(
          join(work, 'AGENTS.md'),
          'Only work in this benchmark directory. Do not search parent directories or use external services.\n'
        );
        const children = [];
        const started = Date.now();
        let row = {
          task,
          arm,
          rep: rep + 1,
          position: position + 1,
          kind: natural
            ? truncatedRead
              ? 'workflow-truncated-read'
              : 'workflow'
            : 'controlled-read',
          artifactLayout: 2,
          seed,
          verdict: 'ERROR',
        };
        try {
          const proxyPort = await port();
          let upstream = 'https://chatgpt.com';
          const env = { ...process.env };
          for (const key of Object.keys(env))
            if (key.startsWith('TOKEN_OPTIMIZER_PROXY_')) delete env[key];
          if (arm === 'headroom') {
            const headroomPort = await port();
            const hr = launch(
              process.env.PYTHON || 'python',
              [
                '-m',
                'headroom.cli',
                'proxy',
                '--port',
                String(headroomPort),
                '--openai-api-url',
                'https://chatgpt.com',
              ],
              work,
              env,
              join(artifacts, 'headroom')
            );
            children.push(hr.child);
            await ready(headroomPort, hr.child);
            upstream = `http://127.0.0.1:${headroomPort}`;
          }
          env.TOKEN_OPTIMIZER_PROXY = '1';
          env.TOKEN_OPTIMIZER_PROXY_NULL = [
            'proxy',
            'full',
            'full-files',
          ].includes(arm)
            ? '0'
            : '1';
          env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = join(
            artifacts,
            'ledger.jsonl'
          );
          // Capture synthetic benchmark traffic to reject client-side truncation.
          env.TOKEN_OPTIMIZER_PROXY_CAPTURE = artifacts;
          const proxy = launch(
            process.execPath,
            [
              '--report-on-fatalerror',
              '--report-exclude-env',
              '--report-exclude-network',
              '--report-directory',
              artifacts,
              proxyBin,
              '--port',
              String(proxyPort),
              '--upstream',
              upstream,
            ],
            work,
            env,
            join(artifacts, 'proxy')
          );
          children.push(proxy.child);
          await ready(proxyPort, proxy.child);
          const url = `http://127.0.0.1:${proxyPort}/backend-api/codex`;
          const args = [
            'exec',
            '--ignore-user-config',
            '--ephemeral',
            '--skip-git-repo-check',
            '--json',
            '-C',
            work,
            '-m',
            model,
            '-c',
            'approval_policy="never"',
            '-s',
            'danger-full-access',
            '-c',
            `openai_base_url=${JSON.stringify(url)}`,
            '-c',
            'model_provider="bench"',
            '-c',
            'model_providers.bench.name="Local benchmark"',
            '-c',
            `model_providers.bench.base_url=${JSON.stringify(url)}`,
            '-c',
            'model_providers.bench.wire_api="responses"',
            '-c',
            'model_providers.bench.requires_openai_auth=true',
            '-c',
            'model_providers.bench.supports_websockets=false',
            '-c',
            'model_providers.bench.request_max_retries=0',
            '-c',
            'model_providers.bench.stream_max_retries=0',
            natural
              ? (readMode === 'outer-truncated'
                  ? 'First read routes.json through functions.exec with // @exec: {"max_output_tokens": 2000} as the first line of its code. Inside it call tools.exec_command with max_output_tokens: 18000 to print the entire file, and print the returned object with text(result). This deliberately truncates the enclosing serialized shell result. Do not filter or parse this first read. Use subsequent tools as needed to complete the task. '
                  : readMode === 'truncated'
                    ? 'First read routes.json using one shell command, setting the tool output budget to 2000 tokens. Do not filter or parse this first read. This intentionally tests a truncated initial view; use subsequent tools to complete the task. '
                    : readMode === 'mcp'
                      ? 'This is an MCP cache diagnostic. Use token_optimizer smart_read on the absolute path of routes.json before recording before.json. After running node refresh.mjs, use smart_read on that same absolute path again before writing answer.json. Keep default caching and diffMode enabled. You may use any other tools needed, including expand to recover a preview. '
                      : readMode === 'mixed'
                        ? 'First use one shell command to print AGENTS.md followed by the complete routes.json. Set exec_command max_output_tokens to 18000 AND, when using functions.exec, put // @exec: {"max_output_tokens": 24000} on its first line so the enclosing tool also returns the complete output. Do not filter, parse, or summarize that first read. Then complete the task using any tools needed. '
                        : '') + f.prompt
              : `First read the complete ${f.name} using one shell command. Set exec_command max_output_tokens to 18000 AND, when using functions.exec, put // @exec: {"max_output_tokens": 24000} on its first line so the enclosing tool also returns the complete output. Do not filter, search, summarize, or parse the file in that first command. Then, using the returned content, ${f.question} Do not modify the source fixture. Finish after writing the answer.`,
          ];
          const command = codex.endsWith('.js') ? process.execPath : codex;
          if (['mcp', 'full', 'full-files'].includes(arm)) {
            args.splice(
              args.length - 1,
              0,
              '-c',
              'mcp_servers.token_optimizer.command="node"',
              '-c',
              `mcp_servers.token_optimizer.args=${JSON.stringify([join(root, 'dist/server/index.js')])}`,
              '-c',
              'mcp_servers.token_optimizer.startup_timeout_sec=60',
              '-c',
              'mcp_servers.token_optimizer.tool_timeout_sec=60',
              '-c',
              `mcp_servers.token_optimizer.env.TOKEN_OPTIMIZER_TOOL_PROFILE="${arm === 'full-files' ? 'files' : 'core'}"`,
              '-c',
              'mcp_servers.token_optimizer.env.TOKEN_OPTIMIZER_EXPERIMENT_ARM="full"'
            );
            args[args.length - 1] +=
              ' Use token_optimizer smart_read for large or repeated reads, smart_glob for discovery, and smart_edit for edits when useful. Tool calls and retrieval costs are part of this task.';
            if (mcpDiscovery === 'bounded')
              args[args.length - 1] +=
                ' Keep tool discovery bounded: in code mode retrieve only the exact needed schema, e.g. ALL_TOOLS.filter(t => t.name.endsWith("__smart_read")). If a name is unknown, list names without descriptions first. Broad matches for mcp, optimizer, or search can dump unrelated schemas.';
          }
          if (codex.endsWith('.js')) args.unshift(codex);
          const agentStarted = Date.now();
          const agent = launch(
            command,
            args,
            work,
            { ...env, OPENAI_BASE_URL: url },
            join(artifacts, 'agent')
          );
          children.push(agent.child);
          const timer = setTimeout(
            () => void stop(agent.child),
            natural ? 300000 : 180000
          );
          const status = await agent.done;
          row.agentSeconds = Number(
            ((Date.now() - agentStarted) / 1000).toFixed(1)
          );
          clearTimeout(timer);
          await delay(300); // allow aborted SSE usage and file streams to settle
          const events = await jsonl(join(artifacts, 'agent.stdout'));
          const ledger = (await jsonl(join(artifacts, 'ledger.jsonl'))).filter(
            (r) => r.path?.endsWith('/responses')
          );
          let answer;
          try {
            answer = JSON.parse(
              (await readFile(join(work, 'answer.json'), 'utf8')).replace(
                /^\uFEFF/,
                ''
              )
            );
          } catch {}
          const validation = natural
            ? await validateWorkflow(task, work, seed).catch((error) => ({
                passed: false,
                failures: [String(error)],
              }))
            : null;
          const correct = natural
            ? validation.passed
            : answer &&
              Object.entries(f.expected).every(([k, v]) => answer[k] === v);
          const unchanged =
            natural ||
            (await readFile(join(work, f.name), 'utf8')) === f.content;
          const read =
            natural && !truncatedRead
              ? { notApplicable: true }
              : readEvidence(
                  await jsonl(join(artifacts, 'requests.jsonl')),
                  natural ? f.files['routes.json'] : f.content
                );
          if (readMode === 'outer-truncated')
            read.outerTruncated = outerEnvelopeTruncated(
              await jsonl(join(artifacts, 'requests.jsonl'))
            );
          row = {
            ...row,
            read,
            validation,
            verdict:
              (!natural && (!read.complete || read.truncated)) ||
              (natural && truncatedRead && !read.truncated) ||
              (natural &&
                readMode === 'outer-truncated' &&
                !read.outerTruncated)
                ? 'INVALID_READ'
                : status.code === 0 && correct && unchanged
                  ? 'PASS'
                  : 'FAIL',
            exit: status.code,
            clientErrors: [
              ...new Set(
                events
                  .filter((e) => e.type === 'error' || e.type === 'turn.failed')
                  .map((e) => e.message || e.error?.message)
                  .filter(Boolean)
              ),
            ],
            completedTools: events
              .filter(
                (e) =>
                  e.type === 'item.completed' &&
                  [
                    'mcp_tool_call',
                    'command_execution',
                    'file_change',
                  ].includes(e.item?.type)
              )
              .map((e) => ({
                type: e.item.type,
                tool: e.item.tool,
                server: e.item.server,
                status: e.item.status,
              })),
            usage: usage(events),
            requests: ledger.length,
            compressedRequests: ledger.filter((r) => r.compressed).length,
            beforeBytes: ledger.reduce((n, r) => n + r.beforeBytes, 0),
            afterBytes: ledger.reduce((n, r) => n + r.afterBytes, 0),
            ledgerUsage: ledger.map((r) => ({
              status: r.status,
              usage: r.usage,
            })),
            answer,
          };
          if (readMode === 'mcp') {
            row.mcpEvidence = mcpRefreshEvidence(
              events,
              join(work, 'routes.json')
            );
            if (!row.mcpEvidence.passed) row.verdict = 'INVALID_MCP';
          }
        } catch (error) {
          row.error = String(error);
        } finally {
          for (const child of children.reverse()) await stop(child);
        }
        row.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
        results.push(row);
        await writeFile(
          join(campaign, 'results.json'),
          JSON.stringify(results, null, 2)
        );
        console.log(JSON.stringify(row));
      }
} finally {
  for (const child of [...active]) await stop(child);
  await memoryMonitor.stop();
}
console.log('Evidence: ' + campaign);
