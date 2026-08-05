/**
 * "Seen this session" must mean READ this session, and must not outlive the
 * context it describes.
 *
 * `refusalPayload` refuses a Read with "UNCHANGED since you last read it this
 * session. Nothing to re-read -- use what you already have." That sentence is a
 * claim about what the CALLER holds, and it was licensed by `state.seen`, which was
 * wrong in two ways.
 *
 * 1. A WRITE MARKED A FILE AS READ. `remember`'s own docstring says it "records a
 *    successful (allowed) read", but its condition admitted Write. Observed live:
 *    a test file authored earlier in the session via Write was, on its FIRST EVER
 *    Read, refused with "you already read it" -- and the harness then refused the
 *    following Write with "File has not been read yet", because from its side no
 *    read had happened. A deadlock, escapable only by retrying the Read.
 *
 * 2. COMPACTION EMPTIES THE CONTEXT AND `seen` SURVIVED IT. A long session is
 *    summarized; the file contents go with it. `state.seen` still said seen, so the
 *    hook kept withholding content the model demonstrably no longer had. The graph
 *    snapshot is durable, but "you already have it" is not a statement about the
 *    graph.
 *
 * Both are about honesty rather than savings: a refusal that carries a diff is
 * useful, and a refusal that carries nothing on a false premise is a lie that costs
 * a turn.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { remember } from '../../hooks-core/decide.mjs';
import { loadState, saveState } from '../../hooks-core/policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('remember records reads, not writes', () => {
  const state = () => ({ seen: {} });

  it('records a Read', () => {
    const s = state();
    remember({ tool_name: 'Read', tool_input: { file_path: '/tmp/a.ts' } }, s);

    expect(s.seen['/tmp/a.ts']).toBe(true);
  });

  it('does NOT record a Write, because writing a file is not reading it', () => {
    // The deadlock: this marked the path seen, the next Read was refused as
    // "unchanged since you last read it", and the harness refused the Write after
    // it for never having been read.
    const s = state();
    remember({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.ts' } }, s);

    expect(s.seen['/tmp/a.ts']).toBeUndefined();
  });

  it('does NOT record an Edit either', () => {
    const s = state();
    remember({ tool_name: 'Edit', tool_input: { file_path: '/tmp/a.ts' } }, s);

    expect(s.seen['/tmp/a.ts']).toBeUndefined();
  });

  it('ignores a call with no file_path', () => {
    const s = state();
    remember({ tool_name: 'Bash', tool_input: { command: 'ls' } }, s);

    expect(Object.keys(s.seen)).toEqual([]);
  });
});

describe('compaction ends the claim that the caller still holds a file', () => {
  let home;
  let originalHome;
  let originalUserProfile;

  // UNIQUE PER RUN, because `saveState` merges `seen` rather than replacing it, so a
  // fixed id accumulates every previous run's paths and the arrange step cannot
  // establish a known starting point. The first version of this test used a fixed id
  // and failed with two temp paths from two different runs.
  let sessionId;

  beforeEach(() => {
    sessionId = `seen-compaction-${process.pid}-${Date.now()}`;

    // Redirected so the test never touches the developer's real state store.
    home = mkdtempSync(join(tmpdir(), 'seen-state-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Windows may hold a handle briefly.
    }
  });

  it('clears seen when the PreCompact hook runs', () => {
    const file = join(home, 'held.ts');
    writeFileSync(file, 'export const a = 1;\n');

    const before = loadState(sessionId);
    before.seen = { [file]: true };
    saveState(sessionId, before);
    expect(Object.keys(loadState(sessionId).seen)).toHaveLength(1);

    const hook = join(ROOT, 'plugin', 'hooks', 'precompact-optimize.mjs');
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id: sessionId, cwd: ROOT, hook_event_name: 'PreCompact' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // The hook must not fall over; it runs on every compaction.
    expect(result.status).toBe(0);

    // Compaction is the moment the caller stops holding those files.
    expect(Object.keys(loadState(sessionId).seen ?? {})).toEqual([]);
  });

  it('leaves a session that was never compacted alone', () => {
    const other = `seen-untouched-${process.pid}-${Date.now()}`;
    const s = loadState(other);
    s.seen = { '/tmp/x.ts': true };
    saveState(other, s);

    expect(Object.keys(loadState(other).seen)).toEqual(['/tmp/x.ts']);
  });

  it('the precompact hook exists where the test drives it from', () => {
    // Guards against the hook being renamed and this suite silently testing nothing.
    expect(existsSync(join(ROOT, 'plugin', 'hooks', 'precompact-optimize.mjs'))).toBe(true);
  });
});
