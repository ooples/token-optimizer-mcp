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

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../../ucr/index.mjs';

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
      TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, 'wiki'),
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

describe('an outline never overrides a UCR guard', () => {
  // A guard's verdict is a refusal that must stand. Before this check the
  // rewrite came first and ALLOWED the call: measured on the previous commit, a
  // guarded read was allowed and outlined in both the router and Qwen.
  const guard = () => {
    const ucrRoot = join(workspace, 'ucr');
    mkdirSync(ucrRoot, { recursive: true });
    const body = {
      schemaVersion: 'ucr.active-guards/1',
      guards: [
        {
          id: 'guard:rules',
          state: 'active',
          triggers: [{ field: 'path', operator: 'matches', value: 'rules\\.py$' }],
          intervention: { type: 'replace-parameters' },
          replacementAction: { path: 'other.py' },
          rollback: 'disable this guard',
          failureBehavior: 'advise',
          evidence: ['receipt:verified'],
          scope: { taskId: 't', projectId: 'p', workspaceId: 'w' },
          sourceObjectId: 'failure:one',
        },
      ],
      eventDigest: 'events',
    };
    writeFileSync(join(ucrRoot, 'active-guards.json'), `${canonicalJson({ ...body, indexHash: sha256(body) })}\n`);
    return {
      TOKEN_OPTIMIZER_UCR_DIR: ucrRoot,
      TOKEN_OPTIMIZER_TASK_ID: 't',
      TOKEN_OPTIMIZER_PROJECT_ID: 'p',
      TOKEN_OPTIMIZER_WORKSPACE_ID: 'w',
    };
  };
  const call = (entryPath, toolName, toolInput, env) => {
    const result = spawnSync(process.execPath, [entryPath], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: randomUUID(), cwd: workspace, tool_name: toolName, tool_input: toolInput }),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_STATE_DIR: join(workspace, 'state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, 'wiki'),
        TOKEN_OPTIMIZER_HOLDOUT: '0',
        TOKEN_OPTIMIZER_MODE: 'enforce',
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read,smart_grep',
        ...env,
      },
    });
    expect(result.status).toBe(0);
    return result.stdout.trim() ? JSON.parse(result.stdout.trim()).hookSpecificOutput || {} : {};
  };

  test('the Claude Code router refuses a guarded read rather than outlining it', () => {
    const router = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');
    const out = call(router, 'Read', { file_path: big }, guard());
    expect(out.permissionDecision).toBe('deny');
    expect(out.updatedInput).toBeUndefined();
    // The control: with no guard the same read is outlined.
    expect(call(router, 'Read', { file_path: big }, {}).updatedInput?.file_path).toMatch(/\.outline\.txt$/);
  });

  test('the adapter refuses a guarded read rather than outlining it', () => {
    const out = call(entry('qwen'), 'read_file', { absolute_path: big }, guard());
    expect(out.permissionDecision).toBe('deny');
    expect(out.updatedInput).toBeUndefined();
  });
});

describe('the once-per-file rule holds under parallel calls', () => {
  test('eight simultaneous reads of one file in one session serve one outline', async () => {
    // Checking for the record and writing it later let two parallel calls both
    // serve an outline -- 3 runs in 5 on the previous commit. Creating the record
    // exclusively makes it the claim, so exactly one call can win.
    const router = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');
    const session = randomUUID();
    const outlined = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, [router], {
              env: {
                ...process.env,
                TOKEN_OPTIMIZER_STATE_DIR: join(workspace, 'state'),
                TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, 'wiki'),
                TOKEN_OPTIMIZER_HOLDOUT: '0',
                TOKEN_OPTIMIZER_MODE: 'assist',
              },
            });
            let stdout = '';
            child.stdout.on('data', (chunk) => {
              stdout += chunk;
            });
            child.on('close', () => resolve(/outline\.txt/.test(stdout)));
            child.stdin.end(
              JSON.stringify({ session_id: session, cwd: workspace, tool_name: 'Read', tool_input: { file_path: big } })
            );
          })
      )
    );
    expect(outlined.filter(Boolean)).toHaveLength(1);
  });
});

describe('a client without a rewrite contract', () => {
  test('Gemini CLI is not sent a rewrite', () => {
    const out = preTool('gemini', 'read_file', { absolute_path: big });
    expect(out.updatedInput).toBeUndefined();
  });
});
