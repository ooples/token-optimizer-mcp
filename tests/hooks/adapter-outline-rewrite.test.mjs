/**
 * Clients other than Claude Code get outlines too (issue #478).
 *
 * Outline substitution lived only in the Claude Code router, so the native
 * adapter -- Qwen Code, Codex and the rest -- never outlined anything. These
 * tests drive each client's PACKAGED pre-tool entry with that client's own tool
 * names and input keys, because the defect class here is a rewrite the client
 * rejects: Qwen and Codex validate `updatedInput` against the tool's schema, and
 * Codex applies it only with `permissionDecision: 'allow'`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let workspace;
let big;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'adapter-outline-'));
  big = join(workspace, 'rules.py');
  const out = [];
  for (let i = 0; i < 300; i++) {
    out.push(
      `def rule_${String(i).padStart(4, '0')}(amount, rate):`,
      '    """Applies a pricing rule and rounds the result."""',
      '    if amount < 0:',
      '        raise ValueError("amount must not be negative")',
      '    return round(amount * rate)',
      ''
    );
  }
  writeFileSync(big, out.join('\n'));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const entry = (client) => {
  const candidates = [
    join(ROOT, 'integrations', client, 'hooks', 'pre-tool.mjs'),
    join(ROOT, 'integrations', client, '.github', 'hooks', 'pre-tool.mjs'),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`no packaged pre-tool entry for ${client}`);
  return found;
};

/** One pre-tool call through the client's packaged entry; returns its hookSpecificOutput. */
const preTool = (client, toolName, toolInput, sessionId = randomUUID()) => {
  const result = spawnSync(process.execPath, [entry(client)], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd: workspace,
      tool_name: toolName,
      tool_input: toolInput,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, 'state'),
      TOKEN_OPTIMIZER_HOLDOUT: '0',
      TOKEN_OPTIMIZER_MODE: 'assist',
    },
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout).hookSpecificOutput || {} : {};
};

describe('Qwen Code', () => {
  test('read_file is rewritten in its own shape, with an explicit allow', () => {
    const out = preTool('qwen', 'read_file', { absolute_path: big });
    expect(out.permissionDecision).toBe('allow');
    // Exactly the keys Qwen sent: a whole-object replacement it validates.
    expect(Object.keys(out.updatedInput)).toEqual(['absolute_path']);
    expect(out.updatedInput.absolute_path).toMatch(/\.outline\.txt$/);
    expect(out.additionalContext).toContain('replaced this read with a structural outline');
  });

  test('the second read of the same file gets the file', () => {
    const session = randomUUID();
    expect(preTool('qwen', 'read_file', { absolute_path: big }, session).updatedInput).toBeDefined();
    expect(preTool('qwen', 'read_file', { absolute_path: big }, session).updatedInput).toBeUndefined();
  });

  test('a paged read is left alone', () => {
    const out = preTool('qwen', 'read_file', { absolute_path: big, offset: 10, limit: 20 });
    expect(out.updatedInput).toBeUndefined();
  });

  test('a shell dump is rewritten only where the shell can be named', () => {
    // run_shell_command does not say which shell it is. On Windows it may be cmd,
    // PowerShell or bash, and a command quoted for the wrong one is broken.
    const out = preTool('qwen', 'run_shell_command', { command: `cat ${big}`, description: 'show it' });
    if (process.platform === 'win32') {
      expect(out.updatedInput).toBeUndefined();
    } else {
      expect(out.permissionDecision).toBe('allow');
      expect(out.updatedInput.command).toMatch(/^cat '.*\.outline\.txt'$/);
      // The keys the client sent survive the replacement.
      expect(out.updatedInput.description).toBe('show it');
    }
  });
});

describe('Codex', () => {
  test('a PowerShell whole-file dump is rewritten, with an explicit allow', () => {
    const out = preTool('codex', 'PowerShell', { command: `Get-Content -Raw '${big}'` });
    expect(out.permissionDecision).toBe('allow');
    expect(Object.keys(out.updatedInput)).toEqual(['command']);
    expect(out.updatedInput.command).toMatch(/^Get-Content -LiteralPath '.*\.outline\.txt' -Encoding UTF8$/);
  });
});

describe('a client without a rewrite contract', () => {
  test('Gemini CLI is not sent a rewrite', () => {
    const out = preTool('gemini', 'read_file', { absolute_path: big });
    expect(out.updatedInput).toBeUndefined();
  });
});
