/**
 * A decision that arrives half-written is a decision that never arrives.
 *
 * The hook wrote its JSON with `process.stdout.write()` and then called
 * `process.exit(0)`. When stdout is a pipe -- which it always is here, because
 * the client reads our answer -- Node's write is asynchronous and `exit`
 * terminates without draining it. The host then gets half a JSON document,
 * fails to parse it, and drops the whole decision: `updatedInput` never
 * arrives and the command runs unbounded.
 *
 * This is a POSIX hazard specifically. On Windows the write completes inline,
 * so this file passes either way there; it discriminates on the Linux CI
 * shards, which is where it is worth having.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTER = fileURLToPath(
  new URL('../../plugin/hooks/pretooluse-router.mjs', import.meta.url)
);

let GRAPH;

beforeAll(() => {
  GRAPH = mkdtempSync(join(tmpdir(), 'flush-'));
});

afterAll(() => {
  rmSync(GRAPH, { recursive: true, force: true });
});

/**
 * The bound applies only to a REPEAT now, and this suite is about whether a long
 * rewrite survives the write-then-exit -- not about when a rewrite happens. So
 * it seeds the state the compactor's pipe stage would have written, exactly as
 * the router's compactorFor() keys it.
 */
function markSeen(command, session) {
  const key = createHash('sha256')
    .update(`${session}\u0000${command}`)
    .digest('hex')
    .slice(0, 32);
  const path = join(tmpdir(), 'token-optimizer-compact', `${key}.seen`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'previous run output\n');
}

function router(command, session) {
  markSeen(command, session);

  return spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({
      session_id: session,
      cwd: process.cwd(),
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: 'enforce',
      TOKEN_OPTIMIZER_WIKI_DIR: GRAPH,
      TOKEN_OPTIMIZER_SHARED_DIR: GRAPH,
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_grep,smart_glob,smart_write,smart_edit',
    },
  });
}

describe('the hook flushes its answer before it exits', () => {
  it('delivers a long rewrite as complete, parseable JSON every time', () => {
    // The longest answers are the rewrites, so they are the most exposed. A
    // single run can get lucky; the repetition is the point.
    const needle = 'x'.repeat(2000);
    const outcomes = [];

    for (let i = 0; i < 40; i += 1) {
      const result = router(`grep -rn ${needle} .`, `flush-${i}`);

      let complete = false;
      try {
        complete = Boolean(
          JSON.parse(result.stdout).hookSpecificOutput?.updatedInput
        );
      } catch {
        complete = false;
      }
      outcomes.push(complete);
    }

    expect(outcomes.filter(Boolean)).toHaveLength(40);
  });
});
