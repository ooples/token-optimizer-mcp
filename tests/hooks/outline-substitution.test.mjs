/**
 * One outline per file per session.
 *
 * THE REGRESSION THIS EXISTS TO PREVENT is not a crash or a wrong answer -- it
 * is a loop that costs money and looks like normal operation. `substitutionFor`
 * accepted an `alreadyRead` flag, echoed it back in its result, and consulted it
 * nowhere; no caller ever passed it. So a file could be replaced by an outline
 * of itself on EVERY read of it.
 *
 * That is the mechanism's worst case rather than a rounding error. When the
 * model needs the file's bodies -- rewriting every function, say -- an outline
 * of its signatures cannot answer, so it reads again, receives another outline,
 * and repeats until the size floor rises with the turn count. Measured on the
 * whole-file-transform task, `assist` cost 1.356 of our own text-only arm: a
 * 35.6% penalty from the very mechanism that won 7.4% and 7.5% on the two tasks
 * where an outline does answer.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { substitutionFor, floorBytes } from '../../hooks-core/substitute.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// THE HOLDOUT IS PINNED TO THE DELIVERED ARM, DELIBERATELY.
//
// `substitutionFor` takes part in the stratified holdout, so a file whose
// hash lands in the withheld arm correctly returns null and the model gets the
// real file. These tests are about WHEN a substitution is offered a second
// time, not about measurement, and the workspace is a fresh mkdtemp path on
// every run -- so without this the suite is a coin flip that would fail once
// and pass on the retry, which is the worst way for a test to behave.
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
  workspace = mkdtempSync(join(tmpdir(), 'outline-'));
  big = join(workspace, 'rules.py');
  writeFileSync(big, module_(300));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('the size floor over a long session (issue #478)', () => {
  // Pricing assumed every session ends at turn 16, so from there on the floor sat
  // at ~116 KB and ordinary source files were never outlined -- in exactly the long
  // agent sessions where a re-read costs the most. Measured on 53 real sessions,
  // the median calls still to come stayed at 115-125 from call 1 to call 100.
  test('a short session is priced exactly as before, through turn 8', () => {
    // 33000 tokens / remaining turns * 3.6 bytes per token, as the formula always was.
    expect(floorBytes(0)).toBe(Math.round((33_000 / 16) * 3.6));
    expect(floorBytes(4)).toBe(Math.round((33_000 / 12) * 3.6));
    expect(floorBytes(8)).toBe(Math.round((33_000 / 8) * 3.6));
  });

  test('the floor never rises past where elapsed equals remaining', () => {
    // The old estimate reached 118,800 bytes at turn 16 and stayed there.
    for (const turn of [9, 16, 50, 300, 5000]) {
      expect(floorBytes(turn)).toBeLessThanOrEqual(floorBytes(8));
    }
    expect(floorBytes(16)).toBeLessThan(33_000 * 3.6);
  });

  test('deep into a session it settles at the absolute floor', () => {
    expect(floorBytes(300)).toBe(4_000);
  });

  test('a ~50 KB source file is still outlined on its first read at call 300', () => {
    // The live failure: a 64 KB file dumped whole at this point in a session went
    // through untouched. Whether a subagent's count included its siblings' calls
    // no longer matters, because a larger count can only lower the floor.
    const size = statSync(big).size;
    expect(size).toBeGreaterThan(floorBytes(300));
    expect(size).toBeLessThan(33_000 * 3.6);
    expect(substitutionFor(big, { turnsSoFar: 300 })).not.toBeNull();
  });

  test('a negative position is treated as the start of a session', () => {
    expect(floorBytes(-5)).toBe(floorBytes(0));
  });
});

describe('the decision itself', () => {
  test('a large outlineable file is outlined on the first read', () => {
    const first = substitutionFor(big, { turnsSoFar: 0 });
    expect(first).not.toBeNull();
    expect(first.outline.length).toBeGreaterThan(0);
  });

  test('the same file is NOT outlined again once it has been', () => {
    // The whole fix. Asking twice is the signal: the hook cannot know at read
    // time whether the model wants a symbol's location or its contents, and it
    // does not need to -- a second request for a file we already outlined is
    // the model saying the outline did not answer.
    expect(substitutionFor(big, { turnsSoFar: 0, alreadyRead: false })).not.toBeNull();
    expect(substitutionFor(big, { turnsSoFar: 0, alreadyRead: true })).toBeNull();
  });

  test('the guard is per file, not a session-wide off switch', () => {
    // Outlining one file must not stop another being outlined; the mechanism
    // wins on the tasks where it answers, and this must not cost those.
    const other = join(workspace, 'other.py');
    writeFileSync(other, module_(300));
    expect(substitutionFor(big, { alreadyRead: true })).toBeNull();
    expect(substitutionFor(other, { alreadyRead: false })).not.toBeNull();
  });
});

describe('the router supplies the signal', () => {
  /** Runs the packaged Claude Code entry and returns its rewrite, if any. */
  const read = (sessionId) => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')],
      {
        input: JSON.stringify({
          session_id: sessionId,
          cwd: workspace,
          tool_name: 'Read',
          tool_input: { file_path: big },
        }),
        encoding: 'utf8',
        env: { ...process.env, TOKEN_OPTIMIZER_MCP_CAPABILITIES: '' },
      }
    );
    if (!result.stdout.trim()) return null;
    const out = JSON.parse(result.stdout.trim()).hookSpecificOutput || {};
    // No `updatedInput` means the hook did not rewrite the call, so the model
    // reads the path it asked for. That absence IS "served the real file".
    return out.updatedInput?.file_path ?? null;
  };

  test('the second read of a file gets the file, not another outline', () => {
    // END TO END, because the dead parameter lived in the WIRING: the core
    // accepted `alreadyRead` and no caller passed it, so a test of the core
    // alone would have passed throughout the regression.
    const session = `outline-${randomUUID()}`;
    const first = read(session);
    const second = read(session);

    // The first read IS rewritten, to a path that is not the file itself.
    expect(first).not.toBeNull();
    expect(first).not.toBe(big);
    expect(first).toMatch(/\.outline\.txt$/);
    // The second is not rewritten at all, so the model reads the real file.
    expect(second).toBeNull();
  });

  test('a different session still gets its own first outline', () => {
    // The record is per session; a new session has learned nothing yet.
    read(`outline-${randomUUID()}`);
    const fresh = read(`outline-${randomUUID()}`);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(big);
  });
});

/**
 * The substitution has to survive a verdict, or it never fires for a real file.
 *
 * `outlineSubstitution` was reachable only from the router's allowed path, and
 * a Read large enough to be worth outlining is precisely a Read that earns a
 * verdict -- so with the MCP server registered, every file the mechanism was
 * built for took the refusal path instead and the outline was never consulted.
 *
 * Measured on a 156 KB Python file with smart_read registered: the router
 * answered `deny` with no `updatedInput`, while `substitutionFor` on that same
 * path offered an 8,379-character outline -- 5.2% of the file. The cheaper
 * answer existed and was skipped, and a refusal costs about one extra turn.
 * Across the 16 THOL tasks with complete data that is the whole deficit:
 * enforce ran 20.0 turns against control's 14.4 for a median 1.724x cost, with
 * the extra turns tracking MCP redirects at 0.90 turns per redirected call.
 */
describe('a refused read is answered, not just refused', () => {
  const INSTALLED = 'smart_read,smart_write,smart_edit,smart_glob,smart_grep';

  /** Runs the packaged entry with the server registered and returns the decision. */
  const read = (mode, { file = big, capabilities = INSTALLED } = {}) => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'plugin/hooks/pretooluse-router.mjs')],
      {
        input: JSON.stringify({
          session_id: `refused-${randomUUID()}`,
          cwd: workspace,
          tool_name: 'Read',
          tool_input: { file_path: file },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_MODE: mode,
          TOKEN_OPTIMIZER_MCP_CAPABILITIES: capabilities,
        },
      }
    );
    // A crash must not read as a silent allow: without this an exception in
    // the router satisfies every 'was not denied' assertion below.
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    const stdout = (result.stdout || '').trim();
    if (!stdout) return { decision: 'allow', updatedInput: null, context: '' };
    const out = JSON.parse(stdout).hookSpecificOutput || {};
    return {
      decision: out.permissionDecision || 'allow',
      updatedInput: out.updatedInput || null,
      context: `${out.additionalContext || ''}${out.permissionDecisionReason || ''}`,
    };
  };

  test('enforce rewrites the read instead of spending a turn refusing it', () => {
    const result = read('enforce');
    // The whole point: the call goes through, so there is no retry to pay for.
    expect(result.decision).not.toBe('deny');
    expect(result.updatedInput?.file_path).toBeTruthy();
    expect(result.updatedInput.file_path).not.toBe(big);
    // And what it is pointed at is smaller than what was asked for, or the
    // substitution saved nothing.
    expect(statSync(result.updatedInput.file_path).size).toBeLessThan(
      statSync(big).size
    );
  });

  test('the rewrite is announced, naming the file it replaced', () => {
    // An unannounced rewrite is the documented failure mode of
    // allowWithRewrite: the spike's model distrusted the mismatched output and
    // re-ran the command, spending the exact turn this exists to save.
    //
    // Asserted on the sentence ONLY `outlineNotice` emits. A first version
    // looked for 'outline' and the file's name, and both appear in the
    // verdict's refusal reason too -- so it passed against the unfixed router,
    // announcing a rewrite that had not happened.
    const result = read('enforce');
    expect(result.updatedInput?.file_path).toBeTruthy();
    expect(result.context).toContain('replaced this read with a structural outline');
    expect(result.context).toContain(big);
  });

  test("the verdict's own reason still rides along", () => {
    // Rewriting instead of refusing must not cost what the refusal would have
    // carried -- the same rule the Bash bound above it follows. The verdict's
    // own summary of the file arrives alongside the substitution.
    //
    // It does NOT carry the `Call smart_read with path=...` line, and that is
    // correct rather than a gap: that sentence is appended by the refusal
    // renderer, and telling the model to re-fetch through another tool a call
    // that has just been answered is the redirect noise assist exists to drop.
    const result = read('enforce');
    expect(result.context).toContain('Structure and what is known about it');
    expect(result.context).toContain('read the original with offset and limit');
    expect(result.context).not.toContain('Call smart_read with path');
  });

  test('assist answers the read with the outline too (issue #478)', () => {
    // This used to assert the opposite: the outline was gated on
    // refusalsEnabled(), as new behaviour to measure before shipping. Run live
    // in the normal install (tools present, assist) that gate meant a file
    // too small to earn a verdict WAS outlined -- through the allowed path --
    // while every file large enough to earn one was not, so the default mode
    // never outlined the files the mechanism exists for. Shipping it ungated
    // was a deliberate decision; the once-per-file rule, which gives the
    // second read the file, is what bounds its cost.
    const result = read('assist');
    expect(result.decision).not.toBe('deny');
    expect(result.updatedInput?.file_path).toMatch(/\.outline\.txt$/);
    expect(result.context).toContain('replaced this read with a structural outline');
  });

  test('under assist, a file with no outline to offer is still not refused', () => {
    // The gate that remains: assist never refuses. Ungating the outline must
    // not have made a refusal reachable there.
    const opaque = join(workspace, 'notes.md');
    writeFileSync(opaque, '# Heading\n\nProse that is long enough to matter.\n\n'.repeat(4000));
    const result = read('assist', { file: opaque });
    expect(result.decision).not.toBe('deny');
    expect(result.updatedInput).toBeNull();
  });

  test('a read with no outline to offer is still refused', () => {
    // THE GUARD MUST NOT TURN EVERY REFUSAL INTO AN ALLOW. A file the outliner
    // cannot describe has no cheaper answer, so the redirect has to stand.
    //
    // Markdown, not a binary: `.md` is outside OUTLINEABLE so no substitution
    // is offered, while still being large text that earns a verdict. A 400 KB
    // `.bin` was the first fixture here and it proved nothing -- the router
    // allows it outright, so the test passed without ever reaching the guard.
    const opaque = join(workspace, 'notes.md');
    writeFileSync(opaque, '# Heading\n\nProse that is long enough to matter.\n\n'.repeat(4000));
    const result = read('enforce', { file: opaque });
    expect(result.decision).toBe('deny');
    expect(result.updatedInput).toBeNull();
    // And the refusal still names the tool that makes the next call cheaper.
    expect(result.context).toContain('smart_read');
  });
});
