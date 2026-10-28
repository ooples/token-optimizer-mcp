/**
 * Hooks follow `<runtime>/current` mid-session, gated on the state schema
 * (hooks-core/runtime-switch.mjs). Every case builds a fake runtime directory;
 * nothing here touches the machine's real ~/.token-optimizer.
 */
import { afterAll, afterEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RESTART_NOTE,
  STATE_SCHEMA,
  applyResolution,
  hotUpdateEnabled,
  importForHook,
  ownVersion,
  resolveHook,
  sessionRecord,
} from '../../hooks-core/runtime-switch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = mkdtempSync(join(tmpdir(), 'runtime-switch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  delete globalThis.__tokenOptimizerStdin;
  delete globalThis.__tokenOptimizerPure;
  delete globalThis.__tokenOptimizerDecorate;
  delete globalThis.__tokenOptimizerRuntime;
});

let n = 0;
/** A fresh world: a state dir, a runtime dir, and "this copy" at version 1.0.0. */
function world() {
  const base = join(root, `w${++n}`);
  const self = join(base, 'self', 'plugin', 'hooks');
  mkdirSync(join(self, 'lib'), { recursive: true });
  writeFileSync(join(base, 'self', 'package.json'), JSON.stringify({ name: '@ooples/token-optimizer-mcp', version: '1.0.0' }));
  writeFileSync(join(self, 'lib', 'adapter.mjs'), "export const marker = 'self';\nexport async function run() {}\n");
  writeFileSync(join(self, 'impl.mjs'), '');
  const env = {
    TOKEN_OPTIMIZER_STATE_DIR: join(base, 'state'),
    TOKEN_OPTIMIZER_RUNTIME: join(base, 'runtime'),
    JEST_WORKER_ID: '1',
  };
  mkdirSync(env.TOKEN_OPTIMIZER_STATE_DIR, { recursive: true });
  return { base, self, env };
}

/** Installs version `version` with the given schema-module source; returns its hooks dir. */
function install(w, version, { schema = STATE_SCHEMA, migrations = '{}', switchSource = null, files = {} } = {}) {
  const hooks = join(w.env.TOKEN_OPTIMIZER_RUNTIME, 'versions', version, 'node_modules', '@ooples', 'token-optimizer-mcp', 'plugin', 'hooks');
  mkdirSync(join(hooks, 'lib'), { recursive: true });
  const all = {
    'lib/runtime-switch.mjs': switchSource ?? `export const STATE_SCHEMA = ${schema};\nexport const MIGRATIONS = ${migrations};\n`,
    'lib/adapter.mjs': `export const marker = '${version}';\nexport async function run() {}\n`,
    'lib/policy.mjs': '',
    'lib/output-compact.mjs': `export const marker = '${version}';\nexport function compactToolResponse() { return '${version}'; }\n`,
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(hooks, name)), { recursive: true });
    writeFileSync(join(hooks, name), text);
  }
  return hooks;
}

let tick = 1_800_000_000;
/** Points current at `version`, with an mtime no earlier pointer had. */
function point(w, version) {
  const pointer = join(w.env.TOKEN_OPTIMIZER_RUNTIME, 'current');
  mkdirSync(dirname(pointer), { recursive: true });
  writeFileSync(pointer, version);
  tick += 10;
  utimesSync(pointer, tick, tick);
}

/** One hook call: the payload handed over as the entry's stdin. */
async function call(w, event, { session = 'sess-1', tool = null } = {}) {
  globalThis.__tokenOptimizerStdin = {
    raw: JSON.stringify({ session_id: session, ...(tool ? { tool_use_id: tool } : {}) }),
    status: 'received',
    bytes: 1,
  };
  try {
    return await resolveHook({ hooksDir: w.self, entryRel: 'plugin/hooks', event, env: w.env });
  } finally {
    delete globalThis.__tokenOptimizerStdin;
  }
}

describe('same schema', () => {
  test('every hook switches to current, and the session record keeps its baseline', async () => {
    const w = world();
    await call(w, 'session-start');
    expect(sessionRecord('sess-1', w.env)).toMatchObject({ version: '1.0.0', schema: STATE_SCHEMA });
    const v2 = install(w, '2.0.0');
    point(w, '2.0.0');
    const choice = await call(w, 'pre-tool', { tool: 'toolu_a' });
    expect(choice).toMatchObject({ mode: 'current', version: '2.0.0', hooksDir: v2, note: null });
    expect((await call(w, 'stop')).mode).toBe('current');
  });

  test('the same version as this copy is this copy, with no import from elsewhere', async () => {
    const w = world();
    install(w, '1.0.0');
    point(w, '1.0.0');
    expect((await call(w, 'pre-tool')).mode).toBe('self');
  });
});

describe('schema change with a migration', () => {
  const MIGRATE = '{ 1: { to: 2, migrateSessionState: (s) => ({ ...s, migrated: true }) } }';

  test('migrates every state file of the session atomically, keeps backups, then switches', async () => {
    const w = world();
    await call(w, 'session-start');
    const state = w.env.TOKEN_OPTIMIZER_STATE_DIR;
    writeFileSync(join(state, 'sess-1.json'), JSON.stringify({ edits: 3 }));
    writeFileSync(join(state, 'sess-1-abcdef123456.json'), JSON.stringify({ edits: 1 }));
    writeFileSync(join(state, 'other.json'), JSON.stringify({ edits: 9 }));
    install(w, '3.0.0', { schema: 2, migrations: MIGRATE });
    point(w, '3.0.0');

    const choice = await call(w, 'pre-tool');
    expect(choice).toMatchObject({ mode: 'current', version: '3.0.0' });
    expect(JSON.parse(readFileSync(join(state, 'sess-1.json'), 'utf8'))).toEqual({ edits: 3, migrated: true });
    expect(JSON.parse(readFileSync(join(state, 'sess-1-abcdef123456.json'), 'utf8'))).toEqual({ edits: 1, migrated: true });
    expect(JSON.parse(readFileSync(join(state, 'sess-1.json.schema1.bak'), 'utf8'))).toEqual({ edits: 3 });
    expect(JSON.parse(readFileSync(join(state, 'other.json'), 'utf8'))).toEqual({ edits: 9 });
    expect(sessionRecord('sess-1', w.env)).toMatchObject({ schema: 2, migratedFrom: 1 });
    expect(readdirSync(state).some((f) => f.endsWith('.migrate.lock'))).toBe(false);
    // Migrated once: the next call is a plain same-schema switch.
    expect((await call(w, 'pre-tool')).mode).toBe('current');
    expect(JSON.parse(readFileSync(join(state, 'sess-1.json'), 'utf8'))).toEqual({ edits: 3, migrated: true });
  });

  test('a migration that fails part-way restores every file and pins the session', async () => {
    const w = world();
    await call(w, 'session-start');
    const state = w.env.TOKEN_OPTIMIZER_STATE_DIR;
    // sess-1-abcdef123456.json sorts before sess-1.json, so the agent file is
    // migrated (and rewritten) before the main file throws: rollback must undo it.
    writeFileSync(join(state, 'sess-1-abcdef123456.json'), JSON.stringify({ edits: 1 }));
    writeFileSync(join(state, 'sess-1.json'), JSON.stringify({ boom: true }));
    install(w, '3.1.0', {
      schema: 2,
      migrations: "{ 1: { to: 2, migrateSessionState: (s) => { if (s.boom) throw new Error('x'); return { ...s, migrated: true }; } } }",
    });
    point(w, '3.1.0');
    const choice = await call(w, 'pre-tool');
    expect(choice.mode).toBe('pinned');
    expect(JSON.parse(readFileSync(join(state, 'sess-1-abcdef123456.json'), 'utf8'))).toEqual({ edits: 1 });
    expect(JSON.parse(readFileSync(join(state, 'sess-1.json'), 'utf8'))).toEqual({ boom: true });
    expect(sessionRecord('sess-1', w.env).schema).toBe(STATE_SCHEMA);
  });
});

describe('schema change without a migration', () => {
  test('stateful hooks stay on this copy, pure modules come from current, and the note is shown once', async () => {
    const w = world();
    await call(w, 'session-start');
    const v4 = install(w, '4.0.0', { schema: 2 });
    point(w, '4.0.0');

    const first = await call(w, 'post-tool', { tool: 'toolu_b' });
    expect(first).toMatchObject({ mode: 'pinned', hooksDir: w.self, pure: v4, note: RESTART_NOTE });
    expect(await applyResolution(first)).toBe(w.self);
    expect(globalThis.__tokenOptimizerPure.compactToolResponse()).toBe('4.0.0');
    expect(globalThis.__tokenOptimizerDecorate({ a: 1 })).toEqual({ a: 1, systemMessage: RESTART_NOTE });
    expect(globalThis.__tokenOptimizerDecorate({ a: 1 })).toEqual({ a: 1 });

    const second = await call(w, 'post-tool', { tool: 'toolu_c' });
    expect(second).toMatchObject({ mode: 'pinned', note: null });
  });
});

describe('one version per tool call', () => {
  test('an update between pre-tool and post-tool does not split a call', async () => {
    const w = world();
    await call(w, 'session-start');
    const v5 = install(w, '5.0.0');
    const v6 = install(w, '6.0.0');
    point(w, '5.0.0');
    expect((await call(w, 'pre-tool', { tool: 'toolu_d' })).hooksDir).toBe(v5);
    point(w, '6.0.0');
    expect((await call(w, 'post-tool', { tool: 'toolu_d' })).hooksDir).toBe(v5);
    // The record is consumed; a later call of its own resolves afresh.
    expect((await call(w, 'post-tool', { tool: 'toolu_d' })).hooksDir).toBe(v6);
    expect((await call(w, 'post-tool', { tool: 'toolu_e' })).hooksDir).toBe(v6);
  });
});

describe('fails safe', () => {
  test.each([
    ['no pointer', (w) => w],
    ['a pointer to a version that is not installed', (w) => point(w, '9.9.9')],
    ['a pointer that is not a version, even one naming a complete install', (w) => {
      // `versions/../outside` is a complete runtime; a traversal must not reach it.
      install(w, '../outside');
      point(w, '../outside');
    }],
    ['a half-installed version (no adapter)', (w) => {
      install(w, '7.1.0', { files: { 'lib/adapter.mjs': null } });
      point(w, '7.1.0');
    }],
    ['a runtime-switch that throws on import', (w) => {
      install(w, '7.2.0', { switchSource: "throw new Error('corrupt');\n" });
      point(w, '7.2.0');
    }],
    ['a runtime-switch with no schema', (w) => {
      install(w, '7.3.0', { switchSource: 'export const NOTHING = 1;\n' });
      point(w, '7.3.0');
    }],
  ])('%s: this copy runs the hook', async (_name, arrange) => {
    const w = world();
    arrange(w);
    expect(await call(w, 'pre-tool')).toMatchObject({ mode: 'self', hooksDir: w.self });
  });

  test('a module missing from the chosen runtime falls back to this copy\'s module', async () => {
    const w = world();
    install(w, '7.4.0');
    point(w, '7.4.0');
    expect((await call(w, 'pre-tool')).mode).toBe('current');
    rmSync(join(w.env.TOKEN_OPTIMIZER_RUNTIME, 'versions', '7.4.0', 'node_modules', '@ooples', 'token-optimizer-mcp', 'plugin', 'hooks', 'lib', 'adapter.mjs'));
    // The pointer cache still names 7.4.0 as complete; the import is what fails.
    globalThis.__tokenOptimizerStdin = { raw: JSON.stringify({ session_id: 's' }), status: 'received', bytes: 1 };
    const adapter = await importForHook({ here: pathToFileURL(join(w.self, 'entry.mjs')).href, entryRel: 'plugin/hooks', event: 'pre-tool', module: 'lib/adapter.mjs', env: w.env });
    expect(adapter.marker).toBe('self');
  });

  test('switching off by env, or under jest without a named runtime, never follows current', async () => {
    const w = world();
    install(w, '7.5.0');
    point(w, '7.5.0');
    expect((await call({ ...w, env: { ...w.env, TOKEN_OPTIMIZER_HOT_UPDATE: '0' } }, 'pre-tool')).mode).toBe('self');
    const { TOKEN_OPTIMIZER_RUNTIME: _named, ...unnamed } = w.env;
    expect((await call({ ...w, env: unnamed }, 'pre-tool')).mode).toBe('self');
  });

  test('hotUpdateEnabled: off by env or under jest without a named runtime, on otherwise', () => {
    expect(hotUpdateEnabled({})).toBe(true);
    expect(hotUpdateEnabled({ TOKEN_OPTIMIZER_HOT_UPDATE: '0' })).toBe(false);
    expect(hotUpdateEnabled({ JEST_WORKER_ID: '1' })).toBe(false);
    expect(hotUpdateEnabled({ JEST_WORKER_ID: '1', TOKEN_OPTIMIZER_RUNTIME: '/r' })).toBe(true);
  });
});

describe('the payload is read once', () => {
  test("policy's readPayloadResult takes the resolver's handed-on stdin", async () => {
    const { readPayloadResult } = await import('../../hooks-core/policy.mjs');
    globalThis.__tokenOptimizerStdin = { raw: '{"session_id":"handed"}', status: 'received', bytes: 23 };
    await expect(readPayloadResult({ timeoutMs: 50 })).resolves.toEqual({ payload: { session_id: 'handed' }, status: 'ok', bytes: 23 });
    globalThis.__tokenOptimizerStdin = { raw: null, status: 'timeout', bytes: 0 };
    await expect(readPayloadResult({ timeoutMs: 50 })).resolves.toEqual({ payload: null, status: 'timeout', bytes: 0 });
  });
});

describe('deadline and cost', () => {
  test('a current that hangs on import is abandoned within the resolve budget', async () => {
    const w = world();
    install(w, '8.0.0', { switchSource: 'await new Promise((r) => setTimeout(r, 20000));\nexport const STATE_SCHEMA = 1;\n' });
    point(w, '8.0.0');
    const started = Date.now();
    const choice = await call({ ...w, env: { ...w.env, TOKEN_OPTIMIZER_RESOLVE_BUDGET_MS: '150' } }, 'pre-tool');
    expect(choice.mode).toBe('self');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('the hook deadline counts the time the resolver already spent', () => {
    // beginHookInvocation's deadline is measured from the entry's start, so a
    // hook that spent 1000ms resolving gets 500ms of a 1500ms deadline.
    const script = join(root, 'deadline-probe.mjs');
    writeFileSync(
      script,
      `globalThis.__tokenOptimizerHookStartedAt = Date.now() - 1000;\n` +
        `const { beginHookInvocation } = await import(${JSON.stringify(new URL('../../hooks-core/observability.mjs', import.meta.url).href)});\n` +
        `beginHookInvocation('claude-code', 'pre-tool', { deadlineMs: 1500 });\n` +
        `setTimeout(() => {}, 5000);\n`
    );
    const started = Date.now();
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, TOKEN_OPTIMIZER_LOG_DIR: join(root, 'logs') },
    });
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(1300);
  });

  test('resolution is cached by the pointer\'s mtime and size, not re-read per call', async () => {
    const w = world();
    const a = install(w, '8.1.a');
    install(w, '8.1.b');
    point(w, '8.1.a');
    expect((await call(w, 'pre-tool')).hooksDir).toBe(a);
    const pointer = join(w.env.TOKEN_OPTIMIZER_RUNTIME, 'current');
    const { mtime } = statSync(pointer);
    writeFileSync(pointer, '8.1.b');
    utimesSync(pointer, mtime, mtime);
    expect((await call(w, 'pre-tool')).hooksDir).toBe(a);
  });
});

describe('every entry point goes through the resolver', () => {
  const entries = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== 'lib' && e.name !== 'impl' && e.name !== 'node_modules') walk(p);
      else if (/^(pre-tool|post-tool|session-start|stop)\.mjs$/.test(e.name)) entries.push(p);
    }
  };
  walk(join(ROOT, 'integrations'));
  for (const name of ['post-tool', 'stop', 'pretooluse-router', 'precompact-optimize', 'agent-scope'])
    entries.push(join(ROOT, 'plugin', 'hooks', `${name}.mjs`));

  test('found the generated and plugin entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(37 + 3);
  });

  test.each(entries.map((p) => [relative(ROOT, p).replace(/\\/g, '/')]))('%s', (rel) => {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    expect(source).toContain("import('./lib/runtime-switch.mjs')");
    expect(source).toContain('importForHook(');
    // The directory it names is its own, so a switch lands on the same client's hooks.
    expect(source).toContain(`entryRel: '${dirname(rel)}'`);
  });

  test("Claude Code's SessionStart records the session's baseline", () => {
    const source = readFileSync(join(ROOT, 'plugin', 'hooks', 'session-start.mjs'), 'utf8');
    expect(source).toMatch(/resolveHook\(\{[\s\S]*?event: 'session-start'/);
  });

  test('the plugin post-tool entry, spawned, runs current\'s adapter with the payload handed on', () => {
    const w = world();
    const out = join(w.base, 'ran.json');
    const version = ownVersion(join(ROOT, 'plugin', 'hooks'), {});
    install(w, '99.0.0', {
      files: {
        'lib/adapter.mjs':
          `import { writeFileSync } from 'node:fs';\n` +
          `export async function run(client, event) {\n` +
          `  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ client, event, raw: globalThis.__tokenOptimizerStdin?.raw ?? null }));\n` +
          `}\n`,
      },
    });
    point(w, '99.0.0');
    writeFileSync(join(w.env.TOKEN_OPTIMIZER_STATE_DIR, 'sess-e2e.runtime.json'), JSON.stringify({ version, schema: STATE_SCHEMA }));
    const payload = JSON.stringify({ session_id: 'sess-e2e', tool_use_id: 'toolu_e2e', tool_name: 'Bash' });
    const r = spawnSync(process.execPath, [join(ROOT, 'plugin', 'hooks', 'post-tool.mjs')], {
      input: payload,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...w.env, TOKEN_OPTIMIZER_VERSION: '' },
    });
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ client: 'claude-code', event: 'post-tool', raw: payload });
  });
});
