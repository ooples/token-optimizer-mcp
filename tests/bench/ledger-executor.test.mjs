/**
 * The executor, tested without docker or an API key.
 *
 * The payloads here are real: captured from `claude -p --output-format json`
 * running in the benchmark image, including the unauthenticated one that would
 * have been recorded as a free success.
 */

import { describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readOutcome,
  dockerArgs,
  writeArmSettings,
  dockerExecutor,
  applyScaffold,
} from '../../bench/ledger/executor.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { singleShotExtract } from '../../bench/ledger/tasks/index.mjs';

/** Captured verbatim from an unauthenticated run in the image. */
const UNAUTHENTICATED = JSON.stringify({
  is_error: true,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0,
  subtype: 'success',
  result: 'Not logged in · Please run /login',
  type: 'result',
  duration_ms: 155,
});

/** Shape of a real successful run, with the fields the ledger reads. */
const SUCCEEDED = JSON.stringify({
  is_error: false,
  num_turns: 7,
  total_cost_usd: 0.064097,
  subtype: 'success',
  result: 'done',
  type: 'result',
});

describe('reading the agent\'s own JSON', () => {
  test('a successful run yields cost and turns', () => {
    const out = readOutcome({ code: 0, stdout: SUCCEEDED, stderr: '', timedOut: false });
    expect(out.status).toBe('ok');
    expect(out.usd).toBeCloseTo(0.064097, 6);
    expect(out.turns).toBe(7);
    expect(out.detail).toBeNull();
  });

  test('the token breakdown is captured, including server tool use', () => {
    // COST ALONE CANNOT SAY WHERE THE MONEY WENT. Diagnosing the leader needed
    // exactly this: their output tokens are 0.722 of control while cache_read
    // is 0.784 -- and output bills at $15/M against cache_read's $0.30/M, so
    // the smaller cut is worth more. Web search is billed separately and sits
    // in NO token column; it was 76% of one task's cost and invisible to every
    // token-based model of it.
    const rich = JSON.stringify({
      is_error: false,
      num_turns: 9,
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 12,
        output_tokens: 3400,
        cache_creation_input_tokens: 18000,
        cache_read_input_tokens: 210000,
        server_tool_use: { web_search_requests: 7, web_fetch_requests: 2 },
      },
    });
    const out = readOutcome({ code: 0, stdout: rich, stderr: '', timedOut: false });
    expect(out.tokens).toEqual({
      input: 12,
      output: 3400,
      cache_creation: 18000,
      cache_read: 210000,
      web_search: 7,
      web_fetch: 2,
    });
  });

  test('a run with no usage still carries every column', () => {
    // So a report can sum without guarding each field.
    for (const r of [
      { code: null, stdout: '', stderr: '', timedOut: true },
      { code: 1, stdout: 'not json', stderr: '', timedOut: false },
    ]) {
      expect(Object.keys(readOutcome(r).tokens).sort()).toEqual(
        ['cache_creation', 'cache_read', 'input', 'output', 'web_fetch', 'web_search']
      );
    }
  });

  test('subtype "success" with is_error true is a FAILURE', () => {
    // THE TRAP THIS FILE EXISTS FOR. Keying on `subtype` would record an
    // unauthenticated run as a successful run costing $0 -- an infinitely
    // efficient optimizer, silently, for every run in a campaign whose
    // short-lived credentials had expired.
    const out = readOutcome({ code: 0, stdout: UNAUTHENTICATED, stderr: '', timedOut: false });
    expect(out.status).toBe('failed');
    expect(out.detail).toMatch(/Not logged in/);
  });

  test('a failed run still reports what it spent', () => {
    // The ledger charges failures, so a run that burned four turns before dying
    // must carry that cost into its row.
    const burned = JSON.stringify({ is_error: true, num_turns: 4, total_cost_usd: 0.21, result: 'gave up' });
    const out = readOutcome({ code: 0, stdout: burned, stderr: '', timedOut: false });
    expect(out.status).toBe('failed');
    expect(out.usd).toBeCloseTo(0.21, 6);
    expect(out.turns).toBe(4);
  });

  test('a timeout is its own status, not a failure', () => {
    const out = readOutcome({ code: null, stdout: '', stderr: '', timedOut: true });
    expect(out.status).toBe('timeout');
  });

  test('unparseable output is an error naming what arrived', () => {
    const out = readOutcome({ code: 1, stdout: 'Usage: claude ...', stderr: 'bad flag', timedOut: false });
    expect(out.status).toBe('error');
    expect(out.detail).toMatch(/unparseable/);
  });

  test('a zero exit code does not by itself mean success', () => {
    // The CLI exits 0 while reporting is_error true, so the exit code is not
    // the signal either.
    expect(readOutcome({ code: 0, stdout: UNAUTHENTICATED, stderr: '', timedOut: false }).status)
      .toBe('failed');
  });
});

describe('the container invocation', () => {
  const base = {
    image: 'thol-rig:local',
    workspace: '/host/ws',
    stateDir: '/host/state',
    armDir: '/host/arm',
    credentials: '/host/creds.json',
    prompt: 'fix the bug',
    model: 'claude-opus-5',
  };

  test('HOME is the mounted state directory, which is the cold/warm mechanism', () => {
    const args = dockerArgs(base);
    expect(args).toContain('-e');
    expect(args).toContain('HOME=/state');
    expect(args.join(' ')).toContain('/host/state:/state');
  });

  test('the workspace is mounted writable and is the working directory', () => {
    const args = dockerArgs(base);
    expect(args.join(' ')).toContain('/host/ws:/work');
    expect(args[args.indexOf('-w') + 1]).toBe('/work');
  });

  test('credentials are mounted read-only', () => {
    // The CLI rewrites the file when refreshing a token; a writable mount would
    // let a container corrupt the host's live credentials.
    expect(dockerArgs(base).join(' ')).toContain('/host/creds.json:/auth/credentials.json:ro');
  });

  test('the prompt never appears in the shell script at all', () => {
    // CAUGHT ON A REAL RUN, NOT REASONED ABOUT. The prompt used to be
    // interpolated via JSON.stringify, which escapes quotes and backslashes but
    // NOT backticks -- so a prompt containing inline code became command
    // substitution inside the double-quoted shell string. sh ran `timeout_ms`,
    // got nothing, and the agent received "the value of the  key", answered
    // sensibly asking which key was meant, exited 0 and scored 0. The run
    // looked exactly like the ARM failing the task.
    const withBackticks = 'write the value of the `timeout_ms` key into ANSWER.txt';
    const args = dockerArgs({ ...base, prompt: withBackticks });
    const script = args.at(-1);

    expect(script).not.toContain('timeout_ms');
    expect(script).toContain('"$LEDGER_PROMPT"');
    // It travels as an environment value, which docker passes without shell
    // interpretation.
    expect(args).toContain(`LEDGER_PROMPT=${withBackticks}`);
  });

  test('shell metacharacters in a prompt cannot reach the shell', () => {
    const nasty = 'fix "the" bug; rm -rf /; $(whoami); `id`';
    const args = dockerArgs({ ...base, prompt: nasty });
    expect(args.at(-1)).not.toContain('whoami');
    expect(args.at(-1)).not.toContain('rm -rf');
    expect(args).toContain(`LEDGER_PROMPT=${nasty}`);
  });

  test('the arm settings file is what selects the arm', () => {
    expect(dockerArgs(base).at(-1)).toContain('--settings /arm/settings.json');
  });

  test('arm environment reaches the container', () => {
    const args = dockerArgs({ ...base, env: { TOKEN_OPTIMIZER_MODE: 'assist' } });
    expect(args.join(' ')).toContain('TOKEN_OPTIMIZER_MODE=assist');
  });
});

describe('the executor end to end, with a fake docker', () => {
  const arms = {
    control: { settings: {}, env: {} },
    candidate: { settings: { hooks: { PreToolUse: [] } }, env: { TOKEN_OPTIMIZER_MODE: 'assist' } },
  };

  const fakeSpawn = (payload) => async () => ({ code: 0, stdout: payload, stderr: '', timedOut: false });

  test('sets up the workspace on the host so the verifier can read it', async () => {
    const execute = dockerExecutor({
      image: 'img', credentials: '/creds', arms, spawnFn: fakeSpawn(SUCCEEDED),
    });
    const out = await execute({ task: singleShotExtract, arm: 'control', track: 'cold', rep: 1 });
    try {
      expect(out.status).toBe('ok');
      expect(out.usd).toBeCloseTo(0.064097, 6);
      // The fixture the task's setup() wrote must be on disk, on the host.
      expect(existsSync(join(out.workspace, 'config/service.toml'))).toBe(true);
      expect(readFileSync(join(out.workspace, 'config/service.toml'), 'utf8')).toContain('timeout_ms');
    } finally {
      rmSync(out.workspace, { recursive: true, force: true });
    }
  });

  test('a workspace is returned even on failure, so partial work still scores', async () => {
    const execute = dockerExecutor({
      image: 'img', credentials: '/creds', arms, spawnFn: fakeSpawn(UNAUTHENTICATED),
    });
    const out = await execute({ task: singleShotExtract, arm: 'control', track: 'cold', rep: 1 });
    try {
      expect(out.status).toBe('failed');
      expect(out.workspace).toBeTruthy();
    } finally {
      rmSync(out.workspace, { recursive: true, force: true });
    }
  });

  test('a broken fixture is a harness fault, not a failed run', async () => {
    // Scoring it as a failed run would charge the arm for OUR bug and quietly
    // depress its number across the campaign.
    const broken = { ...singleShotExtract, setup: () => { throw new Error('fixture broken'); } };
    const execute = dockerExecutor({
      image: 'img', credentials: '/creds', arms, spawnFn: fakeSpawn(SUCCEEDED),
    });
    const out = await execute({ task: broken, arm: 'control', track: 'cold', rep: 1 });
    expect(out.status).toBe('setup-error');
    expect(out.workspace).toBeNull();
  });

  test('a broken fixture does not leak the directory it already created', async () => {
    // This is the ONE exit that returns `workspace: null`, so nobody downstream
    // holds a reference and the release that every other path relies on cannot
    // fire. A fixture usually breaks for every rep, which turns one bug into
    // hundreds of abandoned trees.
    const root = mkdtempSync(join(tmpdir(), 'leak-check-'));
    try {
      const broken = { ...singleShotExtract, setup: () => { throw new Error('fixture broken'); } };
      const execute = dockerExecutor({
        image: 'img', credentials: '/creds', arms, workRoot: root,
        spawnFn: fakeSpawn(SUCCEEDED),
      });
      await execute({ task: broken, arm: 'control', track: 'cold', rep: 1 });
      const left = readdirSync(root).filter((n) => n.startsWith('ledger-ws-'));
      expect(left).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown arm fails loudly rather than running a default', async () => {
    const execute = dockerExecutor({ image: 'img', credentials: '/creds', arms, spawnFn: fakeSpawn(SUCCEEDED) });
    await expect(
      execute({ task: singleShotExtract, arm: 'nope', track: 'cold', rep: 1 })
    ).rejects.toThrow(/unknown arm/);
  });

  test('a warm sequence reuses the state directory it is given', async () => {
    const seen = [];
    const spy = async (_cmd, args) => {
      seen.push(args.join(' '));
      return { code: 0, stdout: SUCCEEDED, stderr: '', timedOut: false };
    };
    const execute = dockerExecutor({ image: 'img', credentials: '/creds', arms, spawnFn: spy });
    const shared = mkdtempSync(join(tmpdir(), 'ledger-warm-'));
    try {
      const a = await execute({ task: singleShotExtract, arm: 'control', track: 'warm', rep: 1, stateDir: shared });
      const b = await execute({ task: singleShotExtract, arm: 'control', track: 'warm', rep: 1, stateDir: shared });
      for (const line of seen) expect(line).toContain(`${shared}:/state`);
      rmSync(a.workspace, { recursive: true, force: true });
      rmSync(b.workspace, { recursive: true, force: true });
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test('missing image or credentials is refused at construction', () => {
    expect(() => dockerExecutor({ credentials: '/c', arms })).toThrow(/image/);
    expect(() => dockerExecutor({ image: 'i', arms })).toThrow(/credentials/);
  });
});

describe('arm settings', () => {
  test('are written as plain settings JSON an operator could reproduce', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-arm-'));
    try {
      const path = writeArmSettings(dir, { settings: { hooks: { SessionStart: ['x'] } } });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hooks: { SessionStart: ['x'] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an arm scaffold', () => {
  const mk = () => {
    const root = mkdtempSync(join(tmpdir(), 'scaffold-'));
    const src = join(root, 'src');
    const ws = join(root, 'ws');
    mkdirSync(join(src, '.claude', 'hooks'), { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(src, 'CLAUDE.md'), 'competitor rules\n');
    writeFileSync(join(src, '.claude', 'hooks', 'guard.sh'), 'echo hi\n');
    return { root, src, ws };
  };

  test('nested files land in the workspace, dotfiles included', () => {
    const { root, src, ws } = mk();
    try {
      writeFileSync(join(ws, 'app.py'), 'print(1)\n');
      expect(applyScaffold(src, ws)).toBe(2);
      expect(readFileSync(join(ws, 'CLAUDE.md'), 'utf8')).toBe('competitor rules\n');
      // The dotted directory is the whole point: the competitor's hooks are
      // invoked as `bash .claude/hooks/...` relative to the project.
      expect(existsSync(join(ws, '.claude', 'hooks', 'guard.sh'))).toBe(true);
      // The fixture is untouched.
      expect(readFileSync(join(ws, 'app.py'), 'utf8')).toBe('print(1)\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('it refuses to overwrite a file the task created', () => {
    // The scaffold is applied AFTER task.setup, so without this an arm could
    // score well by replacing the defect it was asked to find.
    const { root, src, ws } = mk();
    try {
      writeFileSync(join(ws, 'CLAUDE.md'), 'the fixture owns this file\n');
      expect(() => applyScaffold(src, ws)).toThrow(/would overwrite 1 file/);
      // And it refused before copying anything.
      expect(existsSync(join(ws, '.claude', 'hooks', 'guard.sh'))).toBe(false);
      expect(readFileSync(join(ws, 'CLAUDE.md'), 'utf8')).toBe('the fixture owns this file\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing or empty scaffold fails loudly rather than doing nothing', () => {
    const { root, ws } = mk();
    try {
      expect(() => applyScaffold(join(root, 'nope'), ws)).toThrow(/not a directory/);
      const empty = join(root, 'empty');
      mkdirSync(empty, { recursive: true });
      expect(() => applyScaffold(empty, ws)).toThrow(/empty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
