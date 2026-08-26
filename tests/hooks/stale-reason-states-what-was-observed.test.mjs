import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * The stale reason must state what was OBSERVED, not infer a cause.
 *
 * "file no longer readable" asserts a change of state -- it was readable, now it
 * is not -- and the most common way to reach this branch does not involve any
 * such change. Checking out a branch where the anchored file does not exist yet
 * produces it, and so does a worktree, a submodule that is not initialised, and
 * a clone that never had the file. Observed live in this repository: a finding
 * anchored to `src/utils/search-scope.ts` reported the file gone purely because
 * the current branch predated it.
 *
 * The file already holds itself to this standard elsewhere, in the note beside
 * the fallback text: "REASON-NEUTRAL. The earlier text asserted 'the anchor
 * changed', which is only one of the ways a finding reaches this branch ... In
 * those cases the sentence stated a cause that had not been established." The
 * same objection applies here, and this wording was simply missed.
 *
 * What is actually known is narrow and worth saying precisely: the anchor could
 * not be read from THIS checkout. That is honest whether the file was deleted,
 * never existed here, or lives on another branch -- and it points at the thing
 * the reader can check.
 */

const CORE = (name) =>
  pathToFileURL(join(process.cwd(), 'hooks-core', name)).href;

let checkAnchor;
let dir;

beforeAll(async () => {
  ({ checkAnchor } = await import(CORE('staleness.mjs')));
  dir = mkdtempSync(join(tmpdir(), 'stale-reason-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the reason given for an unreadable anchor', () => {
  const missing = () => ({
    kind: 'file',
    key: join(dir, 'src', 'not-on-this-branch.ts'),
    hash: 'deadbeefdeadbeef',
    snapshot: 'export const gone = 1;\n',
  });

  it('does not claim the file was deleted or stopped being readable', () => {
    const { reason } = checkAnchor(missing());

    expect(reason).not.toMatch(/no longer/i);
    expect(reason).not.toMatch(/deleted/i);
  });

  it('says the anchor could not be read from this checkout', () => {
    const { reason } = checkAnchor(missing());

    // Exact, not a /checkout/ match: this string IS the contract the renderer
    // prints, and a loose pattern would accept any replacement that happened to
    // contain the word -- including one that went back to asserting a cause.
    expect(reason).toBe('anchor not readable from this checkout');
  });

  it('still reports the anchor as stale, carrying its snapshot as evidence', () => {
    // The wording is the only thing changing. A finding whose anchor cannot be
    // read must still be served stale WITH the stored snapshot, because a claim
    // about a file that is not here is exactly the kind that must not be handed
    // over as though it were verified.
    const check = checkAnchor(missing());

    expect(check.fresh).toBe(false);
    expect(check.hasBefore).toBe(true);
    expect(check.before).toContain('export const gone');
  });

  it('leaves a genuinely changed file reporting a change', () => {
    // The neighbouring reason must not be collateral damage.
    const path = join(dir, 'src', 'present.ts');
    writeFileSync(path, 'export const value = 2;\n');

    const { reason } = checkAnchor({
      kind: 'file',
      key: path,
      hash: 'notthehashofthatfile',
      snapshot: 'export const value = 1;\n',
    });

    expect(reason).toMatch(/changed/i);
  });
});

describe('the reason given for a changed file names what changed it', () => {
  // `lastAction` -- the tool name that last touched a file -- has been stamped
  // on every file node by the structural harvest since #203 and read by
  // nothing. It belongs precisely in this sentence: "file changed" tells a
  // reader their finding may be wrong, "file changed (last touched by Edit)"
  // tells them a targeted edit did it, which is cheap to re-verify, and "by
  // Write" says the file was replaced wholesale, which usually is not.
  const changed = (extra = {}) => {
    const key = join(dir, 'src', 'changed.ts');
    writeFileSync(key, 'export const x = 2;\n');
    return { kind: 'file', key, hash: 'not-the-current-hash', snapshot: 'export const x = 1;\n', ...extra };
  };

  it('names the tool when the graph recorded one', () => {
    const { reason } = checkAnchor(changed({ lastAction: 'Edit' }));
    expect(reason).toBe('file changed (last touched by Edit)');
  });

  it('falls back to the bare reason when nothing was recorded', () => {
    // A node written before the field existed, or by a path that does not set
    // it. Inventing a tool name would be asserting a cause that was never
    // observed -- the exact error the rest of this file exists to prevent.
    const { reason } = checkAnchor(changed());
    expect(reason).toBe('file changed');
  });

  it('bounds the tool name, because it reaches injected text', () => {
    const { reason } = checkAnchor(changed({ lastAction: 'x'.repeat(400) }));
    expect(reason.length).toBeLessThan(90);
  });

  it('still reports the anchor as stale', () => {
    expect(checkAnchor(changed({ lastAction: 'Write' })).fresh).toBe(false);
  });
});
