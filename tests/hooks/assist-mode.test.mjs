/**
 * `assist` is the posture the product was missing: refusals off, graph on.
 *
 * Before this there was no way to run the knowledge graph without routing.
 * `TOKEN_OPTIMIZER_MODE=off` exits the hook process outright -- adapter.mjs runs
 * `if (mode() === MODE_OFF) process.exit(0)` before any event handling, and
 * stop-harvest.mjs returns early on the same check -- so it takes retrieval,
 * injection and harvest with it. The experiment arms cannot express it either:
 * they are strictly cumulative, and every arm carrying retrieval also carries
 * routing.
 *
 * That mattered because a benchmark measured the enforcing default at 1.687x
 * vanilla Claude Code while `off` measured 0.904 -- but `off` is the product
 * almost entirely disabled, so 0.904 was never the number a sane default could
 * ship on. `assist` is the configuration that question actually needs.
 *
 * The load-bearing test here is the last one: it distinguishes `assist` from
 * `off` by what the SESSION-START hook still does, which is the half `off`
 * silently destroys. A test that only checked "a read is allowed" would pass
 * identically for both and prove nothing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mode, MODE_ASSIST, MODE_ENFORCE, MODE_OFF } from '../../hooks-core/policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(HERE, '..', '..', 'plugin', 'hooks', 'pretooluse-router.mjs');
const SESSION_START = join(HERE, '..', '..', 'plugin', 'hooks', 'session-start.mjs');

const ISOLATED_GRAPH = mkdtempSync(join(tmpdir(), 'assist-graph-'));

let workspace;
let big;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'assist-mode-'));
  big = join(workspace, 'big.ts');
  writeFileSync(big, 'x'.repeat(80_000));
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

// A UNIQUE SESSION PER CALL. Loop breaking and re-read detection are keyed on
// the session, so reusing one id let an earlier assist run mark the target and
// the later enforce run was allowed through by loop breaking -- the control
// test failed for state left by its neighbours rather than for the mode.
let sessionSeq = 0;

function runHook(script, payload, modeValue) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: `assist-${++sessionSeq}`, ...payload }),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: modeValue,
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_write,smart_edit,smart_glob,smart_grep,wiki_write',
      TOKEN_OPTIMIZER_WIKI_DIR: ISOLATED_GRAPH,
      TOKEN_OPTIMIZER_SHARED_DIR: ISOLATED_GRAPH,
    },
  });
}

const decisionOf = (result) => {
  if (!result.stdout.trim()) return 'allow';
  const out = JSON.parse(result.stdout).hookSpecificOutput || {};
  return out.permissionDecision || (out.additionalContext ? 'advise' : 'allow');
};

// A FUNCTION, NOT A CONSTANT. `big` is assigned in beforeAll, so a module-scope
// object captured `file_path: undefined` -- the router could not stat it and
// allowed every call. The assist tests then PASSED VACUOUSLY, because `allow` is
// exactly what an undefined path produces, and only the enforce control caught
// it by expecting a deny that could never happen.
const bigRead = () => ({ tool_name: 'Read', tool_input: { file_path: big } });

describe('mode resolution', () => {
  const withMode = (value, fn) => {
    const prev = process.env.TOKEN_OPTIMIZER_MODE;
    process.env.TOKEN_OPTIMIZER_MODE = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.TOKEN_OPTIMIZER_MODE;
      else process.env.TOKEN_OPTIMIZER_MODE = prev;
    }
  };

  test('assist is reachable by exact opt-in', () => {
    expect(withMode('assist', mode)).toBe(MODE_ASSIST);
    expect(withMode('ASSIST', mode)).toBe(MODE_ASSIST);
  });

  test('the other postures are unchanged', () => {
    expect(withMode('enforce', mode)).toBe(MODE_ENFORCE);
    expect(withMode('off', mode)).toBe(MODE_OFF);
  });
});

describe('assist does not refuse', () => {
  test('a large read is allowed', () => {
    expect(decisionOf(runHook(ROUTER, bigRead(), 'assist'))).toBe('allow');
  });

  test('and it does not merely downgrade to an advisory', () => {
    // `advise` already exists and costs context on every matched call. assist is
    // quieter than that: no refusal AND no routing advisory.
    const r = runHook(ROUTER, bigRead(), 'assist');
    expect(r.stdout.trim()).toBe('');
  });

  test('enforce still refuses, so this is a new posture not a global disable', () => {
    expect(decisionOf(runHook(ROUTER, bigRead(), 'enforce'))).toBe('deny');
  });
});

describe('assist keeps the parts off destroys', () => {
  test('session-start still runs under assist but not under off', () => {
    const payload = { hook_event_name: 'SessionStart', cwd: workspace };

    const assist = runHook(SESSION_START, payload, 'assist');
    const off = runHook(SESSION_START, payload, 'off');

    // `off` exits before any event handling, so it can never emit context.
    expect(off.stdout.trim()).toBe('');
    // assist must not: the graph, injection and harvest are the point of it.
    expect(assist.stdout.trim().length).toBeGreaterThan(0);
  });
});

describe('assist does not advertise routing it will not perform', () => {
  const startUnder = (modeValue) =>
    runHook(SESSION_START, { hook_event_name: 'SessionStart', cwd: workspace }, modeValue)
      .stdout;

  test('the routing advisory is suppressed', () => {
    // The routing list and its "these are recommendations" tail cost context in
    // every session, and under assist they describe a mechanism that is off --
    // which is the per-session overhead assist exists to remove.
    const out = startUnder('assist');
    expect(out).not.toContain('Prefer only the registered');
    expect(out).not.toContain('These are recommendations');
    expect(out).not.toContain('denied only when');
  });

  test('but the graph guidance survives, which is the point of assist', () => {
    // Guards against over-correction: suppressing the whole payload would make
    // assist indistinguishable from off.
    expect(startUnder('assist')).toContain('Record what you work out');
  });

  test('enforce still advertises routing, so this is scoped to assist', () => {
    const out = startUnder('enforce');
    expect(out).toContain('Prefer only the registered');
    expect(out).toContain('denied only when');
  });
});
