/**
 * Behavioural tests for the enforcing hooks.
 *
 * These drive the REAL hook executable over stdin and read its stdout, rather
 * than importing the decision function and asserting on it. That distinction
 * matters: the failure this redesign fixes was never a wrong decision, it was a
 * correct decision wired up so weakly that nothing acted on it. A test that
 * bypasses the wiring would have passed against the old advisor too.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(HERE, '..', '..', 'plugin', 'hooks', 'pretooluse-router.mjs');

let workspace;
let big;
let small;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'to-hooks-'));
  big = join(workspace, 'big.ts');
  small = join(workspace, 'small.ts');
  writeFileSync(big, 'x'.repeat(80_000));
  writeFileSync(small, 'x'.repeat(200));
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

/** Runs the router with a payload and returns the parsed decision. */
function run(payload, env = {}) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({ session_id: payload.session_id || 's-default', ...payload }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (!result.stdout.trim()) return { decision: 'allow' };
  const parsed = JSON.parse(result.stdout);
  const out = parsed.hookSpecificOutput || {};
  return {
    decision: out.permissionDecision || (out.additionalContext ? 'advise' : 'allow'),
    reason: out.permissionDecisionReason || out.additionalContext || '',
  };
}

const read = (path, extra = {}) => ({ tool_name: 'Read', tool_input: { file_path: path }, ...extra });

describe('enforcement is the default', () => {
  test('a large read is denied and names its replacement', () => {
    const r = run(read(big, { session_id: 'large-1' }));
    expect(r.decision).toBe('deny');
    // A refusal that does not name the tool AND its argument gets met with a
    // retry of the same call, which is the old advisor's failure mode.
    expect(r.reason).toContain('smart_read');
    expect(r.reason).toContain(big);
  });

  test('a small first read is untouched', () => {
    expect(run(read(small, { session_id: 'small-1' })).decision).toBe('allow');
  });

  test('a paged read is untouched -- it is already bounded', () => {
    const r = run({ ...read(big, { session_id: 'paged-1' }), tool_input: { file_path: big, offset: 0, limit: 50 } });
    expect(r.decision).toBe('allow');
  });
});

describe('re-read detection -- the case size-gating never caught', () => {
  test('a SMALL file is denied on second read', () => {
    const session = 'reread-' + Date.now();
    expect(run(read(small, { session_id: session })).decision).toBe('allow');
    const second = run(read(small, { session_id: session }));
    expect(second.decision).toBe('deny');
    expect(second.reason).toMatch(/already read/i);
  });
});

describe('loop breaking bounds every failure mode', () => {
  test('the second denial of the same target degrades to an advisory', () => {
    const session = 'loop-' + Date.now();
    expect(run(read(big, { session_id: session })).decision).toBe('deny');
    // Without this, an agent that cannot reach the MCP server is wedged
    // permanently on that file. With it, the cost is one turn.
    expect(run(read(big, { session_id: session })).decision).toBe('advise');
  });
});

describe('the shell bypass is closed', () => {
  test('cat of a large file is denied', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: `cat ${big}` }, session_id: 'bash-1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('a pipeline with no file operand is untouched', () => {
    // `git log | head -30` must not be mistaken for a file dump.
    const r = run({ tool_name: 'Bash', tool_input: { command: 'git log --oneline | head -30' }, session_id: 'bash-2' });
    expect(r.decision).toBe('allow');
  });

  test('cat of a SMALL file is untouched', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: `cat ${small}` }, session_id: 'bash-3' });
    expect(r.decision).toBe('allow');
  });
});

describe('the escape hatch works', () => {
  test('MODE=off allows what enforce denies', () => {
    const r = run(read(big, { session_id: 'off-1' }), { TOKEN_OPTIMIZER_MODE: 'off' });
    expect(r.decision).toBe('allow');
  });

  test('MODE=advise never denies', () => {
    const r = run(read(big, { session_id: 'advise-1' }), { TOKEN_OPTIMIZER_MODE: 'advise' });
    expect(r.decision).toBe('advise');
  });
});

describe('fail-open', () => {
  test('malformed input allows the call', () => {
    const result = spawnSync(process.execPath, [ROUTER], { input: 'not json', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('a missing file allows the call', () => {
    expect(run(read(join(workspace, 'nope.ts'), { session_id: 'missing-1' })).decision).toBe('allow');
  });

  test('a binary path is never size-gated', () => {
    const png = join(workspace, 'shot.png');
    writeFileSync(png, Buffer.alloc(80_000));
    expect(run(read(png, { session_id: 'bin-1' })).decision).toBe('allow');
  });
});
