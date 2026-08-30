/**
 * The zero-turn refusal has to actually fire in production.
 *
 * THE DEFECT THIS COVERS. `refusalPayload` answers a re-read INSIDE the refusal
 * -- "unchanged since you last read it", or the diff -- so the model needs no
 * second call. That is the difference between a refusal costing nothing and a
 * refusal costing a turn.
 *
 * It needs `anchor.snapshot` to do it. `indexFile` writes snapshots correctly,
 * but `load()` defaults to `snapshots: false` and NOTHING in the codebase ever
 * passed true, so a loaded node never carried one and `refusalPayload` returned
 * null for every real file. `hooks-core/staleness.mjs` says so in its own
 * comment: the zero-turn refusal "never fired outside tests that hand-wrote the
 * snapshot themselves".
 *
 * WHY IT MATTERS AT THIS SIZE. A campaign measured the enforcing arm at 1.575x
 * the turns of the same build with refusals off, and turns explain ~80% of its
 * cost gap. Every refusal that redirects instead of answering is one of those
 * turns.
 *
 * These tests drive the REAL hook over stdin. A unit test of `refusalPayload`
 * would have passed throughout the entire period the feature was dead, because
 * the tests that existed hand-wrote the snapshot the production path never had.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(HERE, '..', '..', 'plugin', 'hooks', 'pretooluse-router.mjs');

let workspace;
let graph;
let file;

// Over the refusal floor (1 KB) so a refusal is issued at all, and under the
// large-read threshold (25 KB) so the FIRST read is allowed -- which is what
// indexes the file and makes the second read the interesting one.
const BODY = 'export const value = 1;\n'.repeat(90);

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'zero-turn-'));
  graph = mkdtempSync(join(tmpdir(), 'zero-turn-graph-'));
  file = join(workspace, 'mod.ts');
  writeFileSync(file, BODY);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(graph, { recursive: true, force: true });
});

function read(sessionId) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({
      session_id: sessionId,
      tool_name: 'Read',
      tool_input: { file_path: file },
      cwd: workspace,
    }),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: 'enforce',
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read,smart_grep,smart_glob',
      TOKEN_OPTIMIZER_WIKI_DIR: graph,
      TOKEN_OPTIMIZER_SHARED_DIR: graph,
    },
  });
  if (!result.stdout.trim()) return { decision: 'allow', reason: '' };
  const out = JSON.parse(result.stdout).hookSpecificOutput || {};
  return {
    decision: out.permissionDecision || (out.additionalContext ? 'advise' : 'allow'),
    reason: out.permissionDecisionReason || out.additionalContext || '',
  };
}

describe('a re-read is answered inside the refusal', () => {
  test('the second read is told the file is unchanged, not sent elsewhere', () => {
    const session = 'unchanged-' + Date.now();

    expect(read(session).decision).toBe('allow');

    const second = read(session);
    expect(second.decision).toBe('deny');

    // THE PROPERTY THAT MATTERS: the answer is IN the refusal, so the model
    // needs no further call. Asserting the content rather than the wording.
    expect(second.reason).toMatch(/unchanged since you last read it/i);
    expect(second.reason).toMatch(/nothing to re-read/i);
  });

  test('a changed file gets the diff, not a redirect', () => {
    const session = 'changed-' + Date.now();

    expect(read(session).decision).toBe('allow');
    writeFileSync(file, BODY.replace('value = 1', 'value = 4242'));

    const second = read(session);
    expect(second.decision).toBe('deny');
    // The changed line itself, which is what makes the second call unnecessary.
    expect(second.reason).toContain('4242');
    // And it must be a diff rather than the file.
    expect(second.reason.length).toBeLessThan(BODY.length / 2);
  });
});

describe('the refusal does not answer what it cannot know', () => {
  test('a DIFFERENT session gets no unchanged-claim', () => {
    // Session B never read this file, so "you already have it" would be false
    // and would withhold content it has never seen.
    const first = 'sess-a-' + Date.now();
    expect(read(first).decision).toBe('allow');
    expect(read(first).decision).toBe('deny');

    const other = read('sess-b-' + Date.now());
    expect(other.reason).not.toMatch(/unchanged since you last read it/i);
  });
});
