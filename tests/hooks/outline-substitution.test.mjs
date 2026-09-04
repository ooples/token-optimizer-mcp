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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { substitutionFor } from '../../hooks-core/substitute.mjs';

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
