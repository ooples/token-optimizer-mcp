/**
 * What a subagent actually does, routed through the packaged Claude Code entry.
 *
 * Every regression here was measured on the transcripts of 42 workflow subagents
 * from one long session (issue #473): 2,071 file reads went through the shell
 * and 9 through `Read`, the recursive-search advisory was injected 798 times and
 * followed 17 times, and a paged `Read` was answered with an outline it could not
 * page through. Each test pins the behaviour that was missing, through the
 * shipped entry point rather than the module, because a module-level fix that
 * the router never calls is the defect class this project keeps relearning.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  wholeFileDump,
  isRecursiveSearch,
  adviseOnce,
} from '../../hooks-core/decide.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PRIOR_HOLDOUT = process.env.TOKEN_OPTIMIZER_HOLDOUT;
process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
afterAll(() => {
  if (PRIOR_HOLDOUT === undefined) delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
  else process.env.TOKEN_OPTIMIZER_HOLDOUT = PRIOR_HOLDOUT;
});

let workspace;
let big;

/** A file large enough and regular enough to be worth outlining. */
const module_ = (count) => {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      `def rule_${String(i).padStart(4, '0')}(amount, rate):`,
      '    """Applies a pricing rule and rounds the result."""',
      '    if amount < 0:',
      '        raise ValueError("amount must not be negative")',
      '    return round(amount * rate)',
      ''
    );
  }
  return out.join('\n');
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'subagent-'));
  big = join(workspace, 'rules.py');
  writeFileSync(big, module_(300));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** Runs the packaged entry on one call and returns its hook output. */
const route = (sessionId, toolName, toolInput) => {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')],
    {
      input: JSON.stringify({
        session_id: sessionId,
        cwd: workspace,
        tool_name: toolName,
        tool_input: toolInput,
      }),
      encoding: 'utf8',
      env: { ...process.env, TOKEN_OPTIMIZER_MCP_CAPABILITIES: '' },
    }
  );
  if (!result.stdout.trim()) return {};
  return JSON.parse(result.stdout.trim()).hookSpecificOutput || {};
};

describe('a paged Read is never outlined', () => {
  test('offset and limit pass through to the real file', () => {
    const out = route(`paged-${randomUUID()}`, 'Read', {
      file_path: big,
      offset: 100,
      limit: 20,
    });
    // Rewriting the path would apply the offset to the outline instead.
    expect(out.updatedInput?.file_path).toBeUndefined();
  });

  test('a paged read does not use up the one outline a file gets', () => {
    const session = `paged-${randomUUID()}`;
    route(session, 'Read', { file_path: big, offset: 1, limit: 10 });
    const whole = route(session, 'Read', { file_path: big });
    expect(whole.updatedInput?.file_path).toMatch(/\.outline\.txt$/);
  });
});

describe('a whole-file shell dump is outlined like a Read', () => {
  test('cat of a large source file prints its outline instead', () => {
    const out = route(`shell-${randomUUID()}`, 'Bash', {
      command: `cat ${big.replace(/\\/g, '/')}`,
    });
    const command = out.updatedInput?.command;
    expect(command).toMatch(/^cat '.*\.outline\.txt'$/);
    const target = command.slice(5, -1);
    expect(statSync(target).size).toBeLessThan(statSync(big).size);
    expect(readFileSync(target, 'utf8')).toContain('rule_0000');
    expect(out.additionalContext).toContain('structural outline');
  });

  test('PowerShell gets a PowerShell command with a literal path', () => {
    const out = route(`shell-${randomUUID()}`, 'PowerShell', {
      command: `Get-Content -Raw '${big}'`,
    });
    expect(out.updatedInput?.command).toMatch(/^Get-Content -LiteralPath '.*\.outline\.txt' -Encoding UTF8$/);
  });

  test('the second whole dump of a file gets the file', () => {
    const session = `shell-${randomUUID()}`;
    const command = `cat ${big.replace(/\\/g, '/')}`;
    expect(route(session, 'Bash', { command }).updatedInput?.command).toBeTruthy();
    expect(route(session, 'Bash', { command }).updatedInput).toBeUndefined();
  });

  test('the once-per-file record is shared with Read', () => {
    const session = `shell-${randomUUID()}`;
    route(session, 'Bash', { command: `cat ${big.replace(/\\/g, '/')}` });
    expect(route(session, 'Read', { file_path: big }).updatedInput).toBeUndefined();
  });

  test.each([
    ['a pipeline', (f) => `cat ${f} | head -20`],
    ['a chain', (f) => `cat ${f} && echo done`],
    ['a line range', (f) => `sed -n '10,40p' ${f}`],
    ['numbered lines', (f) => `cat -n ${f}`],
    ['a bounded Get-Content', (f) => `Get-Content -TotalCount 40 ${f}`],
    ['a redirect', (f) => `cat ${f} > copy.py`],
    ['two files', (f) => `cat ${f} ${f}`],
    ['the POSIX type builtin', (f) => `type ${f}`],
  ])('%s is left alone', (_, build) => {
    const out = route(`shell-${randomUUID()}`, 'Bash', {
      command: build(big.replace(/\\/g, '/')),
    });
    expect(out.updatedInput).toBeUndefined();
  });
});

describe('outlines in the default install: assist, with the optimizer tools present (issue #478)', () => {
  // Every other test here declares NO optimizer tools, so no read ever earns a
  // verdict. With the tools present -- the normal plugin install -- a large read
  // does earn one, and the verdict path outlined only when refusals were on. In
  // the default assist mode the files the outline exists for were never outlined.
  const withTools = (sessionId, toolName, toolInput) => {
    const result = spawnSync(process.execPath, [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')], {
      input: JSON.stringify({ session_id: sessionId, cwd: workspace, tool_name: toolName, tool_input: toolInput }),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_STATE_DIR: join(workspace, 'state'),
        TOKEN_OPTIMIZER_MODE: 'assist',
        TOKEN_OPTIMIZER_MCP_CAPABILITIES:
          'mcp__plugin_token-optimizer_token-optimizer__smart_read,mcp__plugin_token-optimizer_token-optimizer__smart_grep',
      },
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return result.stdout.trim() ? JSON.parse(result.stdout.trim()).hookSpecificOutput || {} : {};
  };

  test('a whole-file Read is outlined, and the second Read gets the file', () => {
    const session = `tools-${randomUUID()}`;
    expect(withTools(session, 'Read', { file_path: big }).updatedInput?.file_path).toMatch(/\.outline\.txt$/);
    expect(withTools(session, 'Read', { file_path: big }).updatedInput?.file_path).toBeUndefined();
  });

  test('the call count that prices an outline is per agent', () => {
    // It used to count marker files whose names began with the session id, but
    // those names are hashes, so it was always 0 -- and had it worked, a
    // subagent would have inherited its parent's and siblings' calls.
    const session = `count-${randomUUID()}`;
    const stateDir = join(workspace, 'count-state');
    const small = join(workspace, 'small.txt');
    writeFileSync(small, 'x\n');
    const call = (transcript) =>
      spawnSync(process.execPath, [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')], {
        input: JSON.stringify({ session_id: session, transcript_path: transcript, cwd: workspace, tool_name: 'Read', tool_input: { file_path: small } }),
        encoding: 'utf8',
        env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: stateDir },
      });
    const parent = join(workspace, `${session}.jsonl`);
    const child = join(workspace, session, 'subagents', 'agent-a1.jsonl');
    call(parent);
    call(parent);
    call(parent);
    call(child);
    const counts = readdirSync(stateDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(stateDir, name), 'utf8')).toolCalls)
      .sort();
    expect(counts).toEqual([1, 3]);
  });

  test('a whole-file shell dump is outlined, and the second dump gets the file', () => {
    const session = `tools-${randomUUID()}`;
    const command = `Get-Content -Raw '${big}'`;
    expect(withTools(session, 'PowerShell', { command }).updatedInput?.command).toMatch(/\.outline\.txt'/);
    expect(withTools(session, 'PowerShell', { command }).updatedInput?.command).toBeUndefined();
  });
});

describe('the subagent briefing rides on every exit', () => {
  // The router marks a subagent briefed before it knows which exit it will
  // take, so an emitter that drops the preceding context loses the briefing for
  // good. advise() did: enforce() uses it in advise mode and on a repeated
  // denial. Each emitter is driven in its own process because each one exits.
  test.each([
    ['allow', 'p.allow()'],
    ['allowWithContext', "p.allowWithContext('REASON')"],
    ['allowWithRewrite', "p.allowWithRewrite({ command: 'x' }, 'REASON')"],
    ['deny', "p.deny('REASON')"],
    ['advise', "p.advise('REASON')"],
  ])('%s', (_, call) => {
    const policy = pathToFileURL(join(ROOT, 'hooks-core', 'policy.mjs')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(policy)}).then((p) => { p.precedeWith('BRIEFING'); ${call}; })`],
      { encoding: 'utf8' }
    );
    expect(result.stdout).toContain('BRIEFING');
  });
});

describe('wholeFileDump', () => {
  test('recognises exactly one plain dump of one file', () => {
    expect(wholeFileDump(`cat ${big}`, workspace)?.path).toBeTruthy();
    expect(wholeFileDump(`type ${big}`, workspace)?.path).toBeTruthy();
    expect(wholeFileDump(`Get-Content -LiteralPath '${big}'`, workspace)?.path).toBeTruthy();
    expect(wholeFileDump('cat missing-file.py', workspace)).toBeNull();
    expect(wholeFileDump(`cat ${big} *.py`, workspace)).toBeNull();
    expect(wholeFileDump(`cat $(echo ${big})`, workspace)).toBeNull();
  });
});

describe('recursive-search classification', () => {
  test.each([
    ["Select-String -Path a.cs -Pattern 'x'", false],
    ['Select-String -Pattern Scatter -Path src\\Layer.cs', false],
    ['Get-ChildItem -Recurse -Filter *.cs | Select-String foo', true],
    ['gci src -Recurse | sls foo', true],
    ['ls -r | grep foo', false],
    ['git grep -n foo', true],
    ['grep -rn foo src', true],
    ['grep -n foo a.cs', false],
    ['findstr /s foo *.cs', true],
    ['findstr foo a.cs', false],
  ])('%s -> %s', (command, expected) => {
    expect(isRecursiveSearch(command)).toBe(expected);
  });
});

describe('advisories are said once', () => {
  test('a search advisory is delivered once per session, whatever the pattern', () => {
    const state = {};
    expect(adviseOnce(state, { key: 'bash:search:grep -rn foo' })).toBe(true);
    expect(adviseOnce(state, { key: 'bash:search:grep -rn bar' })).toBe(false);
    expect(adviseOnce(state, { key: 'grep:foo:' })).toBe(true);
    expect(adviseOnce(state, { key: 'grep:bar:' })).toBe(false);
  });

  test('a per-file advisory is still delivered once for each file', () => {
    const state = {};
    expect(adviseOnce(state, { key: 'bash:/a.py' })).toBe(true);
    expect(adviseOnce(state, { key: 'bash:/b.py' })).toBe(true);
    expect(adviseOnce(state, { key: 'bash:/a.py' })).toBe(false);
  });

  test('"once" holds across hook processes, not just within one', () => {
    // Every hook call is a new process, so the record must survive saveState
    // and loadState. It did not: routingAdvised was missing from both, and an
    // in-process test like the two above passed while the advisory repeated on
    // every real call. Two separate processes are the only honest check.
    const session = `twice-${randomUUID()}`;
    const stateDir = join(workspace, 'state');
    const post = (command) => {
      const result = spawnSync(process.execPath, [join(ROOT, 'plugin/hooks/post-tool.mjs')], {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: session,
          transcript_path: join(workspace, `${session}.jsonl`),
          cwd: workspace,
          tool_name: 'Bash',
          tool_input: { command },
          tool_response: { stdout: 'x', stderr: '' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_STATE_DIR: stateDir,
          TOKEN_OPTIMIZER_LOG_DIR: join(workspace, 'logs'),
          TOKEN_OPTIMIZER_MCP_CAPABILITIES:
            'mcp__plugin_token-optimizer_token-optimizer__smart_grep',
        },
      });
      // A process that crashed prints nothing, which would read as "not
      // advised" and pass the second assertion for the wrong reason.
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: expect.any(String),
      });
      const out = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
      return String(out.hookSpecificOutput?.additionalContext ?? '');
    };
    // The positive control: the first search IS advised, so the second
    // being silent means the record was kept, not that nothing ever fires.
    expect(post('grep -rn foo .')).toMatch(/Recursive shell searches/);
    expect(post('grep -rn bar src')).not.toMatch(/Recursive shell searches/);
  });
});
