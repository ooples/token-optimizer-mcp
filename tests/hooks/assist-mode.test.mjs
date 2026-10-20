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
const POST_TOOL = join(HERE, '..', '..', 'plugin', 'hooks', 'post-tool.mjs');

const ISOLATED_GRAPH = mkdtempSync(join(tmpdir(), 'assist-graph-'));
const ISOLATED_STATE = mkdtempSync(join(tmpdir(), 'assist-state-'));

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
      // Session state is per run, not per machine: the session ids restart at
      // 1 every run, so a shared state root handed one run the "already said"
      // flags an earlier run had saved.
      TOKEN_OPTIMIZER_STATE_DIR: ISOLATED_STATE,
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

    // `off` exits before any event handling. The one thing it may say is that it
    // is off (once a day, see install-health.mjs offModeNotice) -- never the
    // policy, the graph or anything else assist delivers.
    expect(off.stdout).not.toContain('Token optimization is active');
    if (off.stdout.trim()) expect(off.stdout).toContain('token-optimizer is OFF');
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
    // The hook actually ran and emitted its payload. Three absences alone are
    // also satisfied by a crashed hook returning '' -- which would suppress the
    // routing advisory for entirely the wrong reason, and look identical here.
    expect(out).toContain('Token optimization is active');
    expect(out).not.toContain('Prefer only the registered');
    expect(out).not.toContain('These are recommendations');
    expect(out).not.toContain('denied only when');
  });

  test('the graph guidance survives, deferred to the first sign of real work (#357, M5)', () => {
    // Guards against over-correction: suppressing the guidance would make
    // assist indistinguishable from off. It is no longer in SessionStart,
    // where every session paid for it, but the first post-tool event after an
    // edit delivers it -- once.
    const session = `assist-deferred-${++sessionSeq}`;
    const start = runHook(
      SESSION_START,
      { hook_event_name: 'SessionStart', cwd: workspace, session_id: session },
      'assist'
    ).stdout;
    expect(start).toContain('Token optimization is active');
    expect(start).not.toContain('Record what you work out');
    const edit = {
      hook_event_name: 'PostToolUse',
      cwd: workspace,
      session_id: session,
      tool_name: 'Edit',
      tool_input: { file_path: big, old_string: 'x', new_string: 'y' },
      tool_response: { success: true },
    };
    expect(runHook(POST_TOOL, edit, 'assist').stdout).toContain(
      'Record what you work out'
    );
    expect(runHook(POST_TOOL, edit, 'assist').stdout).not.toContain(
      'Record what you work out'
    );
  });

  test('an investigation that edits nothing gets it after GUIDANCE_AFTER_CALLS tool calls', () => {
    const session = `assist-calls-${++sessionSeq}`;
    const bash = {
      hook_event_name: 'PostToolUse',
      cwd: workspace,
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: { stdout: 'clean', exitCode: 0 },
    };
    const read = (n) =>
      runHook(
        ROUTER,
        {
          hook_event_name: 'PreToolUse',
          cwd: workspace,
          session_id: session,
          tool_name: 'Read',
          tool_input: { file_path: join(workspace, `f${n}.ts`) },
        },
        'assist'
      );
    for (let n = 0; n < 9; n++) read(n);
    expect(runHook(POST_TOOL, bash, 'assist').stdout).not.toContain(
      'Record what you work out'
    );
    read(9);
    expect(runHook(POST_TOOL, bash, 'assist').stdout).toContain(
      'Record what you work out'
    );
  }, 60_000);

  test('enforce still advertises routing, so this is scoped to assist', () => {
    const out = startUnder('enforce');
    expect(out).toContain('Prefer only the registered');
    expect(out).toContain('denied only when');
  });
});
