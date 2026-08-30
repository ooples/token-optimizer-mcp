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
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(
  HERE,
  '..',
  '..',
  'plugin',
  'hooks',
  'pretooluse-router.mjs'
);

/** An empty graph, so no stored finding can influence an enforcement decision. */
const ISOLATED_GRAPH = mkdtempSync(join(tmpdir(), 'enforcement-graph-'));

let workspace;
let big;
let small;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'to-hooks-'));
  big = join(workspace, 'big.ts');
  small = join(workspace, 'small.ts');
  writeFileSync(big, 'x'.repeat(80_000));
  // Comfortably under the LARGE threshold (25 KB) -- which is what these tests
  // are about -- but over the refusal floor, below which a refusal costs more
  // than the file it replaces and so is never issued at all.
  writeFileSync(small, 'x'.repeat(2_000));
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * Runs the router with a payload and returns the parsed decision.
 *
 * ISOLATED GRAPH. Without this the router consults whatever findings happen to
 * be in the developer's own project graph, so these assertions depended on
 * machine state: seeding a real finding whose trigger matched `| head` turned
 * this suite red without a line of production code changing. A suite about
 * ENFORCEMENT must not be able to fail because of what someone learned last
 * week.
 */
function run(payload, env = {}) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({
      session_id: payload.session_id || 's-default',
      ...payload,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      // These tests exercise enforcement, so they provide the same positive
      // runtime inventory evidence production now requires before redirecting.
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_write,smart_edit,smart_glob,smart_grep,wiki_write',
      TOKEN_OPTIMIZER_WIKI_DIR: ISOLATED_GRAPH,
      TOKEN_OPTIMIZER_SHARED_DIR: ISOLATED_GRAPH,
      ...env,
    },
  });
  if (!result.stdout.trim()) return { decision: 'allow' };
  const parsed = JSON.parse(result.stdout);
  const out = parsed.hookSpecificOutput || {};
  return {
    decision:
      out.permissionDecision || (out.additionalContext ? 'advise' : 'allow'),
    reason: out.permissionDecisionReason || out.additionalContext || '',
  };
}

const read = (path, extra = {}) => ({
  tool_name: 'Read',
  tool_input: { file_path: path },
  ...extra,
});

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
    const r = run({
      ...read(big, { session_id: 'paged-1' }),
      tool_input: { file_path: big, offset: 0, limit: 50 },
    });
    expect(r.decision).toBe('allow');
  });
});

describe('re-read detection -- the case size-gating never caught', () => {
  test('a SMALL file is denied on second read', () => {
    const session = 'reread-' + Date.now();
    expect(run(read(small, { session_id: session })).decision).toBe('allow');
    const second = run(read(small, { session_id: session }));
    expect(second.decision).toBe('deny');
    // The refusal now CARRIES THE ANSWER rather than redirecting: because the
    // first, allowed read indexes the file, the second one can be told the file
    // is unchanged and that it already has the contents -- which costs zero
    // turns, where "call smart_read instead" costs one. Asserting the property
    // rather than the old wording.
    expect(second.reason).toMatch(
      /unchanged since you last read it|already read/i
    );
    expect(second.reason).toMatch(/nothing to re-read|smart_read/i);
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
    const r = run({
      tool_name: 'Bash',
      tool_input: { command: `cat ${big}` },
      session_id: 'bash-1',
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('a pipeline with no file operand is untouched', () => {
    // `git log | head -30` must not be mistaken for a file dump.
    const r = run({
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline | head -30' },
      session_id: 'bash-2',
    });
    expect(r.decision).toBe('allow');
  });

  // WINDOWS ONLY, and skipped rather than deleted elsewhere. The `/c/Users/...`
  // spelling is what Git Bash hands a Bash tool call ON WINDOWS; on Linux that
  // is simply a path that does not exist, so the test could only ever fail
  // there -- which is exactly what it did in CI while passing locally. The
  // platform-independent half of the same guarantee is asserted below.
  const onWindows = process.platform === 'win32' ? test : test.skip;

  onWindows('a Git-Bash/MSYS path is resolved, not silently skipped', () => {
    // A Bash tool call carries `/c/Users/...`, which Node cannot stat -- so the
    // size check found nothing and EVERY shell dump was allowed through on the
    // platform this runs on most. The Read tool passes `C:\Users\...`, which is
    // why the same file was refused one way and allowed the other. Found by
    // pointing the optimizer at a real repository.
    const drive = big[0];
    const msys = `/${drive.toLowerCase()}${big.slice(2).replace(/\\/g, '/')}`;
    const r = run({
      tool_name: 'Bash',
      tool_input: { command: `cat ${msys}` },
      session_id: 'msys-1',
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('the two spellings of one path are one identity, on every platform', () => {
    // The half of the MSYS guarantee that is testable everywhere: whatever the
    // host, a path written two ways must not become two different nodes.
    expect(canonicalPath('/c/Users/me/auth.ts')).toBe(
      canonicalPath('C:\\Users\\me\\auth.ts')
    );
    expect(canonicalPath('C:/Users/me/auth.ts')).toBe(
      canonicalPath('C:\\Users\\me\\auth.ts')
    );
  });

  test('cat of a SMALL file is untouched', () => {
    const r = run({
      tool_name: 'Bash',
      tool_input: { command: `cat ${small}` },
      session_id: 'bash-3',
    });
    expect(r.decision).toBe('allow');
  });
});

describe('the escape hatch works', () => {
  test('MODE=off allows what enforce denies', () => {
    const r = run(read(big, { session_id: 'off-1' }), {
      TOKEN_OPTIMIZER_MODE: 'off',
    });
    expect(r.decision).toBe('allow');
  });

  test('MODE=advise never denies', () => {
    const r = run(read(big, { session_id: 'advise-1' }), {
      TOKEN_OPTIMIZER_MODE: 'advise',
    });
    expect(r.decision).toBe('advise');
  });
});

describe('fail-open', () => {
  test('malformed input allows the call', () => {
    const result = spawnSync(process.execPath, [ROUTER], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('a missing file allows the call', () => {
    expect(
      run(read(join(workspace, 'nope.ts'), { session_id: 'missing-1' }))
        .decision
    ).toBe('allow');
  });

  test('a binary path is never size-gated', () => {
    const png = join(workspace, 'shot.png');
    writeFileSync(png, Buffer.alloc(80_000));
    expect(run(read(png, { session_id: 'bin-1' })).decision).toBe('allow');
  });
});

/**
 * Enforcement is only ever worth issuing when the tokens it refuses have not
 * been spent yet. That is true of Read, Grep and Glob, whose output does not
 * exist until the tool runs -- and false of Write, whose `content` the model
 * has ALREADY emitted in the very call being refused.
 *
 * Refusing a Write therefore cannot save the content: it has been paid for.
 * What it does instead is force the model to emit an identical copy through
 * smart_write, so the refusal costs exactly one extra copy of the file, every
 * time, with certainty. The cache entry it was buying is obtainable for free
 * from disk once the write lands, because the bytes are then a local file.
 *
 * This was observed live: a 39 KB Write was denied, and satisfying the refusal
 * required re-sending all 39 KB from context -- a strict loss on a tool whose
 * entire purpose is to reduce context spend.
 */
describe('a refusal must not cost more than the call it replaces', () => {
  test('a large Write is allowed -- its content is already in context', () => {
    const r = run({
      session_id: 'write-net-loss-1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(workspace, 'generated.ts'),
        content: 'x'.repeat(80_000),
      },
    });
    expect(r.decision).toBe('allow');
  });

  test('the refusal reason never asks for a Write to be re-sent', () => {
    const r = run({
      session_id: 'write-net-loss-2',
      tool_name: 'Write',
      tool_input: {
        file_path: join(workspace, 'generated2.ts'),
        content: 'y'.repeat(80_000),
      },
    });
    // An allowed call may carry no reason at all, which is the strongest form
    // of passing -- hence the `|| ''` rather than asserting a reason exists.
    expect(r.reason || '').not.toContain('smart_write');
  });

  test('a large Read is still denied -- those tokens are genuinely unspent', () => {
    // Guards the fix against over-correction: the asymmetry is the point, so a
    // change that silently disabled enforcement everywhere must fail here.
    expect(run(read(big, { session_id: 'write-net-loss-3' })).decision).toBe(
      'deny'
    );
  });
});
