/**
 * Bounding a command's output instead of refusing the command.
 *
 * THE ASSERTIONS RUN THE REWRITTEN COMMANDS. A rewrite is a silent mutation of
 * somebody's command, so the only assertion worth making is that the rewritten
 * form still MEANS the same thing -- same stdout content at the tail, same exit
 * status, stderr still captured. Pattern-matching the generated string would
 * pass just as well for a rewrite that breaks every command it touches.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { boundedRewrite, boundNotice, DEFAULT_BOUND_BYTES } from '../../hooks-core/rewrite.mjs';

/** Runs a command through bash exactly as the client's Bash tool would. */
function run(command) {
  try {
    const stdout = execFileSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout, status: 0 };
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ''),
      status: typeof error.status === 'number' ? error.status : -1,
    };
  }
}

describe('the rewritten command still means what it meant', () => {
  it('keeps a successful command successful, and its output intact', () => {
    const original = run('echo hello');
    const { command } = boundedRewrite('echo hello');

    const bounded = run(command);

    expect(original.status).toBe(0);
    expect(bounded.status).toBe(0);
    expect(bounded.stdout.trim()).toBe('hello');
  });

  it('PRESERVES A NON-ZERO EXIT, which is the whole reason pipefail is there', () => {
    // Without `set -o pipefail` the pipeline reports tail's status -- always 0 --
    // and every failing test run would read as a passing one. That is far worse
    // than any wasted tokens: the model would simply stop debugging.
    const original = run('echo boom; exit 3');
    expect(original.status).toBe(3);

    const { command } = boundedRewrite('echo boom; exit 3');
    const bounded = run(command);

    expect(bounded.status).toBe(3);
    expect(bounded.stdout).toContain('boom');
  });

  it('captures stderr, where a failing build says what went wrong', () => {
    const { command } = boundedRewrite('echo to-stderr 1>&2; exit 1');

    const bounded = run(command);

    expect(bounded.stdout).toContain('to-stderr');
    expect(bounded.status).toBe(1);
  });

  it('keeps the TAIL, which is where a test run puts its verdict', () => {
    // 200 numbered lines: the bound must drop the beginning and keep the end.
    const { command } = boundedRewrite('seq 1 200', { maxBytes: 40 });

    const bounded = run(command);

    expect(bounded.stdout).toContain('200');
    expect(bounded.stdout).not.toContain('\n1\n');
    expect(Buffer.byteLength(bounded.stdout, 'utf8')).toBeLessThanOrEqual(40);
  });

  it('leaves output shorter than the bound completely untouched', () => {
    const { command } = boundedRewrite('echo short', { maxBytes: 8000 });

    expect(run(command).stdout.trim()).toBe('short');
  });

  it('bounds a compound command as one unit, not just its last part', () => {
    // `{ a; b; } | tail` and `a; b | tail` are different commands. The braces
    // are what make the bound apply to everything the call produces.
    const { command } = boundedRewrite('seq 1 100; echo LAST', { maxBytes: 30 });

    const bounded = run(command);

    expect(bounded.stdout).toContain('LAST');
    expect(Buffer.byteLength(bounded.stdout, 'utf8')).toBeLessThanOrEqual(30);
  });
});

describe('commands it refuses to touch', () => {
  // Each of these is a case where wrapping changes what the command MEANS.
  // Returning null leaves the call exactly as the author wrote it.
  it.each([
    ['a heredoc, whose body is data', "cat <<'EOF'\nhello\nEOF"],
    ['a backgrounded process it no longer owns', 'npm run dev &'],
    ['output already redirected to a file', 'npm test > out.log'],
    ['an author-supplied bound', 'npm test | head -n 20'],
    ['a streaming or interactive command', 'tail -f server.log'],
  ])('leaves %s alone', (_why, command) => {
    expect(boundedRewrite(command)).toBeNull();
  });

  it('still bounds a command containing && and ||, which are not backgrounding', () => {
    // The backgrounding guard must not swallow ordinary control operators.
    // Harmless operands on purpose: an earlier version used a real
    // `npm run build && npm test`, and the test DID run them and timed out.
    const rewritten = boundedRewrite('true && false || echo failed');

    expect(rewritten).not.toBeNull();
    expect(run(rewritten.command).stdout).toContain('failed');
  });

  it('does not bound an empty or non-string command', () => {
    expect(boundedRewrite('   ')).toBeNull();
    expect(boundedRewrite(undefined)).toBeNull();
  });
});

describe('the bound announces itself', () => {
  it('names the limit and a way out, because a silent rewrite gets distrusted', () => {
    // The spike's model noticed an unannounced rewrite and reported the output
    // as suspect rather than using it. A model that distrusts its output
    // re-runs the command, spending the turn this mechanism exists to save.
    const notice = boundNotice(DEFAULT_BOUND_BYTES);

    expect(notice).toContain(String(DEFAULT_BOUND_BYTES));
    expect(notice).toMatch(/TOKEN_OPTIMIZER_BOUND_BYTES/);
  });
});


/* ------------------------------------------------------------------ *
 * The real router, end to end
 * ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(HERE, '..', '..', 'plugin', 'hooks', 'pretooluse-router.mjs');

/** An empty graph, so no stored finding can influence the decision. */
const GRAPH = mkdtempSync(join(tmpdir(), 'bounded-graph-'));

afterAll(() => {
  try {
    rmSync(GRAPH, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

/** Drives the shipped router exactly as the client does. */
function router(payload, env = {}) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({ session_id: 's-bound', cwd: process.cwd(), ...payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_write,smart_edit,smart_glob,smart_grep,wiki_write',
      TOKEN_OPTIMIZER_WIKI_DIR: GRAPH,
      TOKEN_OPTIMIZER_SHARED_DIR: GRAPH,
      ...env,
    },
  });
  // A silent allow emits nothing at all. Spelled out with the same shape as
  // the parsed path so a caller cannot tell them apart by accident.
  if (!result.stdout.trim()) {
    return { decision: 'allow', reason: '', context: '', updatedInput: null };
  }
  const out = JSON.parse(result.stdout).hookSpecificOutput || {};
  return {
    decision: out.permissionDecision || (out.additionalContext ? 'advise' : 'allow'),
    reason: out.permissionDecisionReason || '',
    context: out.additionalContext || '',
    updatedInput: out.updatedInput || null,
  };
}

describe('the shipped router bounds instead of refusing', () => {
  const SEARCH = { tool_name: 'Bash', tool_input: { command: 'grep -rn needle .' } };

  it('allows a recursive search WITH a rewritten command, where it used to deny', () => {
    // The whole point of the change: this exact call was a refusal, and a
    // refusal costs about one turn. Now it runs, bounded, for zero.
    const r = router(SEARCH, { TOKEN_OPTIMIZER_MODE: 'enforce' });

    expect(r.decision).toBe('allow');
    expect(r.updatedInput).not.toBeNull();
    expect(r.updatedInput.command).toContain('grep -rn needle .');
    expect(r.updatedInput.command).toContain('tail -c');
  });

  it('tells the model what it did, so the rewrite is not silent', () => {
    const r = router(SEARCH, { TOKEN_OPTIMIZER_MODE: 'enforce' });

    expect(r.context).toMatch(/bounded/i);
    expect(r.context).toContain('TOKEN_OPTIMIZER_BOUND_BYTES');
  });

  it('leaves the command alone in assist, which was already letting it through', () => {
    // Bounding here would be a NEW behaviour, not a cheaper spelling of an old
    // one -- assist's contract is that the call proceeds untouched.
    const r = router(SEARCH, { TOKEN_OPTIMIZER_MODE: 'assist' });

    expect(r.updatedInput).toBeNull();
    expect(r.decision).toBe('allow');
  });

  it('does not rewrite a command it cannot bound safely', () => {
    // A heredoc body is data; wrapping it in braces moves the terminator. The
    // router must fall back to its previous behaviour rather than mangle it.
    const r = router(
      {
        tool_name: 'Bash',
        tool_input: { command: "grep -rn needle . <<'EOF'\nbody\nEOF" },
      },
      { TOKEN_OPTIMIZER_MODE: 'enforce' }
    );

    expect(r.updatedInput).toBeNull();
  });
});
