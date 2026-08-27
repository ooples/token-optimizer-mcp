import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  beginHookInvocation,
  hookHealthSummary,
  readHookEvents,
  recordHookBootstrapFailure,
  writeHookEvent,
} from '../../hooks-core/observability.mjs';

const ROOT = process.cwd();
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
).version;

/**
 * A child environment WITHOUT the injected version.
 *
 * The generated entry files used to open with an unconditional
 * `process.env.TOKEN_OPTIMIZER_VERSION = '<version>'`, so a spawned hook
 * reported the package version whatever it inherited. That literal is applied
 * at publish time only now: a version committed into a generated file makes
 * "generated output == committed file" an invariant that cannot survive a
 * release commit, and the drift it guarantees has cost this project three
 * releases (v5.4.0, v5.4.1, v5.7.1 -- all tagged, none on npm).
 *
 * Unsetting it keeps the assertion below identical and makes it stronger: the
 * child now has to resolve its own version from the nearest manifest, which is
 * exactly what a marketplace plugin install does.
 */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.TOKEN_OPTIMIZER_VERSION;
  return env;
}

let workspace;
let previous;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'token-optimizer-observability-'));
  previous = {
    logDir: process.env.TOKEN_OPTIMIZER_LOG_DIR,
    maxBytes: process.env.TOKEN_OPTIMIZER_LOG_MAX_BYTES,
  };
  process.env.TOKEN_OPTIMIZER_LOG_DIR = join(workspace, 'logs');
  process.env.TOKEN_OPTIMIZER_VERSION = 'test-version';
});

afterEach(() => {
  if (previous.logDir === undefined) delete process.env.TOKEN_OPTIMIZER_LOG_DIR;
  else process.env.TOKEN_OPTIMIZER_LOG_DIR = previous.logDir;
  if (previous.maxBytes === undefined) delete process.env.TOKEN_OPTIMIZER_LOG_MAX_BYTES;
  else process.env.TOKEN_OPTIMIZER_LOG_MAX_BYTES = previous.maxBytes;
  delete process.env.TOKEN_OPTIMIZER_VERSION;
  rmSync(workspace, { recursive: true, force: true });
});

describe('cross-client hook observability', () => {
  test('writes one correlated, privacy-safe completion event', () => {
    const invocation = beginHookInvocation('codex', 'post-tool');
    invocation.bind(
      {
        session_id: 'session-1',
        turn_id: 'turn-1',
        tool_use_id: 'tool-1',
        tool_name: 'apply_patch',
        cwd: workspace,
        tool_input: { command: 'secret source content that must not be logged' },
      },
      { tool_name: 'apply_patch' },
      321
    );
    invocation.noteOutput({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'private response text',
      },
    });
    invocation.succeed('captured');

    const events = readHookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 2,
      service: 'token-optimizer',
      serviceVersion: 'test-version',
      event: 'hook.completed',
      outcome: 'success',
      reason: 'captured',
      client: 'codex',
      hookEvent: 'post-tool',
      toolName: 'apply_patch',
      rawToolName: 'apply_patch',
      codeModeEnvelope: false,
      payloadBytes: 321,
      severityText: 'INFO',
      severityNumber: 9,
      body: 'hook.completed',
      outputShape: [
        'hookSpecificOutput',
        'hookSpecificOutput.additionalContext',
        'hookSpecificOutput.hookEventName',
      ],
    });
    expect(events[0].cwdHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].sessionIdHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].turnIdHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].toolUseIdHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(events[0].spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].resource).toMatchObject({
      'service.name': 'token-optimizer',
      'service.version': 'test-version',
      'process.runtime.name': 'node',
    });
    expect(JSON.stringify(events[0])).not.toContain('secret source content');
    expect(JSON.stringify(events[0])).not.toContain('private response text');
    expect(JSON.stringify(events[0])).not.toContain('session-1');
    expect(events[0]).not.toHaveProperty('tool_input');
  });

  test('records bootstrap failures with secrets and home paths redacted', () => {
    recordHookBootstrapFailure(
      'gemini',
      'pre-tool',
      new Error(`${homedir()} password=hunter2 ghp_12345678901234567890`)
    );

    const [event] = readHookEvents();
    expect(event.outcome).toBe('failure');
    expect(event.reason).toBe('bootstrap_import_failure');
    expect(event.error.message).toContain('<home>');
    expect(event.error.message).not.toContain('hunter2');
    expect(event.error.message).not.toContain('ghp_12345678901234567890');
  });

  test('rotates bounded JSONL files and aggregates health by client', () => {
    process.env.TOKEN_OPTIMIZER_LOG_MAX_BYTES = '1';
    writeHookEvent({ client: 'codex', outcome: 'success', durationMs: 10 });
    writeHookEvent({ client: 'codex', outcome: 'failure', durationMs: 20 });
    writeHookEvent({ client: 'claude-code', outcome: 'timeout', durationMs: 30 });

    const files = readdirSync(process.env.TOKEN_OPTIMIZER_LOG_DIR).filter((name) =>
      name.endsWith('.jsonl')
    );
    expect(files.length).toBeGreaterThan(1);
    const health = hookHealthSummary();
    expect(health.total).toBe(3);
    expect(health.failures).toBe(1);
    expect(health.timeouts).toBe(1);
    expect(health.byClient.codex).toMatchObject({ total: 2, failures: 1 });
    expect(health.byClient['claude-code']).toMatchObject({ total: 1, timeouts: 1 });
    expect(health).not.toHaveProperty('logDirectory');
    expect(hookHealthSummary({ includeLogDirectory: true }).logDirectory).toBe(
      process.env.TOKEN_OPTIMIZER_LOG_DIR
    );
  });

  test('reports an unpaired lifecycle start as an abandoned failure', () => {
    writeHookEvent({
      event: 'hook.started',
      timestamp: new Date(Date.now() - 20_000).toISOString(),
      invocationId: 'abandoned-probe',
      client: 'codex',
      hookEvent: 'pre-tool',
    });

    expect(readHookEvents()).toHaveLength(0);
    const health = hookHealthSummary();
    expect(health).toMatchObject({
      total: 1,
      failures: 1,
      abandoned: 1,
      healthStatus: 'failing',
    });
    expect(health.recentFailures[0]).toMatchObject({
      reason: 'process_terminated_before_completion',
    });
  });

  test('separates an intentional policy block from a hook failure', () => {
    const invocation = beginHookInvocation('codex', 'pre-tool');
    invocation.block('policy_denied');

    expect(hookHealthSummary()).toMatchObject({
      total: 1,
      failures: 0,
      blocked: 1,
      successRate: 1,
      healthStatus: 'healthy',
    });
  });

  test('fails open before the host timeout when stdin never closes', async () => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [join(ROOT, 'integrations', 'codex', 'plugin', 'hooks', 'pre-tool.mjs')],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_LOG_DIR: join(workspace, 'timeout-logs'),
          TOKEN_OPTIMIZER_HOOK_DEADLINE_MS: '3000',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, elapsed: Date.now() - started }));
    });
    expect(result.code).toBe(0);
    // NO WALL-CLOCK BOUND. This used to assert `result.elapsed < 2500`: a
    // wall-clock measurement of a spawned Node process, taken inside a suite that
    // runs its files in parallel workers, against a budget whose slack over the
    // 1,500 ms stdin wait is process startup. That is the identified source of
    // this suite's intermittent failure, and it was never the thing under test.
    //
    // The gate that actually proves "fails open BEFORE the host timeout" is the
    // RECORDED REASON below, and it is not a clock reading. `stdin_timeout` can
    // only be written by the 1,500 ms stdin wait; had the child instead run past
    // the 3,000 ms deadline configured above, `finish` would have stamped
    // `internal_deadline_exceeded` and this test would fail no matter how the
    // machine was loaded. Ordering is asserted by which mechanism won, not by how
    // long the winner took.

    const file = readdirSync(join(workspace, 'timeout-logs')).find((name) =>
      name.endsWith('.jsonl')
    );
    const event = readFileSync(join(workspace, 'timeout-logs', file), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .find((row) => row.event === 'hook.completed');
    expect(event.outcome).toBe('timeout');
    expect(event.reason).toBe('stdin_timeout');
    expect(event.inputStatus).toBe('timeout');
  });

  test('covers Claude Code custom hooks with the same bounded schema', async () => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs')],
      {
        cwd: workspace,
        env: childEnv({ TOKEN_OPTIMIZER_LOG_DIR: join(workspace, 'claude-logs') }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    expect(result.code).toBe(0);

    const [event] = readEventsFrom(join(workspace, 'claude-logs'));
    expect(event).toMatchObject({
      schemaVersion: 2,
      serviceVersion: PACKAGE_VERSION,
      client: 'claude-code',
      hookEvent: 'pre-tool',
      outcome: 'timeout',
      reason: 'stdin_timeout',
      inputStatus: 'timeout',
    });
  });

  test('every generated CLI adapter emits the same successful diagnostic schema', async () => {
    const adapters = [
      ['codex', ['integrations', 'codex', 'plugin', 'hooks', 'pre-tool.mjs']],
      ['gemini', ['integrations', 'gemini', 'hooks', 'pre-tool.mjs']],
      ['qwen', ['integrations', 'qwen', 'hooks', 'pre-tool.mjs']],
      ['opencode', ['integrations', 'opencode', 'hooks', 'pre-tool.mjs']],
      ['copilot', ['integrations', 'copilot', '.github', 'hooks', 'pre-tool.mjs']],
      ['cline', ['integrations', 'cline', 'hooks', 'token-optimizer', 'pre-tool.mjs']],
      ['cursor', ['integrations', 'cursor', 'hooks', 'pre-tool.mjs']],
      ['windsurf', ['integrations', 'windsurf', 'hooks', 'pre-tool.mjs']],
      ['kilo', ['integrations', 'kilo', 'hooks', 'pre-tool.mjs']],
    ];

    const results = await Promise.all(
      adapters.map(async ([client, entryParts]) => {
        const logDirectory = join(workspace, `${client}-logs`);
        const child = spawn(process.execPath, [join(ROOT, ...entryParts)], {
          cwd: workspace,
          env: childEnv({ TOKEN_OPTIMIZER_LOG_DIR: logDirectory }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end(
          JSON.stringify({
            session_id: `${client}-session`,
            turn_id: `${client}-turn`,
            tool_use_id: `${client}-tool-use`,
            cwd: workspace,
            tool_name: 'Read',
            tool_input: { file_path: join(workspace, 'probe.txt') },
          })
        );

        const exitCode = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
        return { client, exitCode, event: readEventsFrom(logDirectory)[0] };
      })
    );

    expect(results.map(({ client }) => client)).toEqual(adapters.map(([client]) => client));
    for (const { client, exitCode, event } of results) {
      expect(exitCode).toBe(0);
      expect(event).toMatchObject({
      schemaVersion: 2,
        service: 'token-optimizer',
        serviceVersion: PACKAGE_VERSION,
        client,
        hookEvent: 'pre-tool',
        outcome: 'success',
        inputStatus: 'ok',
      });
      expect(event.sessionIdHash).toMatch(/^[a-f0-9]{16}$/);
      expect(event.traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(event.spanId).toMatch(/^[a-f0-9]{16}$/);
    }
  });

  test('records a successful Stop payload as consumed instead of pending', async () => {
    const logDirectory = join(workspace, 'stop-logs');
    const child = spawn(
      process.execPath,
      [join(ROOT, 'integrations', 'codex', 'plugin', 'hooks', 'stop.mjs')],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_LOG_DIR: logDirectory,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    child.stdin.end(
      JSON.stringify({
        session_id: 'stop-session',
        turn_id: 'stop-turn',
        cwd: workspace,
        stop_hook_active: false,
      })
    );

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code }));
    });
    expect(result.code).toBe(0);

    const [event] = readEventsFrom(logDirectory);
    expect(event).toMatchObject({
      client: 'codex',
      hookEvent: 'stop',
      outcome: 'success',
      inputStatus: 'ok',
    });
    expect(event.sessionIdHash).toMatch(/^[a-f0-9]{16}$/);
    expect(event.turnIdHash).toMatch(/^[a-f0-9]{16}$/);
  });

  test('diagnostics export is summary-first and event rows are bounded opt-in', () => {
    writeHookEvent({ client: 'codex', outcome: 'success', durationMs: 10 });
    writeHookEvent({ client: 'gemini', outcome: 'success', durationMs: 20 });

    const summaryRun = spawnSync(process.execPath, [join(ROOT, 'scripts', 'export-diagnostics.mjs')], {
      cwd: workspace,
      env: process.env,
      encoding: 'utf8',
    });
    expect(summaryRun.status).toBe(0);
    const summary = JSON.parse(summaryRun.stdout);
    expect(summary.scope).toEqual({ windowHours: 24, eventPayloadIncluded: false });
    expect(summary.summary.total).toBe(2);
    expect(summary).not.toHaveProperty('events');

    const eventRun = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'export-diagnostics.mjs'), '--include-events', '--limit', '1'],
      { cwd: workspace, env: process.env, encoding: 'utf8' }
    );
    expect(eventRun.status).toBe(0);
    const eventReport = JSON.parse(eventRun.stdout);
    expect(eventReport.scope).toEqual({
      windowHours: 24,
      eventPayloadIncluded: true,
      eventLimit: 1,
    });
    expect(eventReport.summary.total).toBe(2);
    expect(eventReport.events).toHaveLength(1);
  });
});

function readEventsFrom(directory) {
  const file = readdirSync(directory).find((name) => name.endsWith('.jsonl'));
  return readFileSync(join(directory, file), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event !== 'hook.started');
}
