/**
 * #538: reading a file never writes a store inside the directory it came from.
 *
 * The reported case: Codex reads a file inside an installed plugin whose bundle
 * root holds a `.git` marker. The post-tool hook took that directory as the
 * project root and wrote `.token-optimizer/wiki/{graph,snapshots,metrics}.jsonl`
 * into it, changing the bundle's fingerprint, so Codex demanded the plugin's
 * hooks be reviewed again after every read.
 *
 * Reproduced here as the reporter did, with the shipped hook entries, an
 * isolated home, a minimal "installed plugin" with an empty `.git`, and a
 * successful Bash `cat` payload.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const ENTRIES = {
  'claude code': join(ROOT, 'plugin', 'hooks', 'post-tool.mjs'),
  codex: join(ROOT, 'integrations', 'codex', 'hooks', 'post-tool.mjs'),
  'codex plugin': join(ROOT, 'integrations', 'codex', 'plugin', 'hooks', 'post-tool.mjs'),
};

let work;
let home;
let plugin;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'no-store-in-project-'));
  home = join(work, 'home');
  plugin = join(work, 'plugins', 'cache', 'ponytail', '5.3.3');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(join(plugin, '.git'), '');
  writeFileSync(
    join(plugin, 'hooks', 'ponytail-subagent.js'),
    "import { readFileSync } from 'node:fs';\nexport function run() {\n  return readFileSync('x', 'utf8');\n}\n"
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** sha256 of every file under `dir`, the way a bundle fingerprint sees it. */
function fingerprint(dir) {
  const out = {};
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function readThroughHook(entry) {
  const file = join(plugin, 'hooks', 'ponytail-subagent.js');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TOKEN_OPTIMIZER_')) env[k] = v;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, [entry], {
      cwd: plugin,
      encoding: 'utf8',
      timeout: 30_000,
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: `repro-${i}`,
        cwd: plugin,
        tool_name: 'Bash',
        tool_input: { command: `cat ${file}` },
        tool_response: { stdout: readFileSync(file, 'utf8'), stderr: '', interrupted: false },
      }),
      env: {
        ...env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, '.codex'),
        TOKEN_OPTIMIZER_HOME: join(home, '.token-optimizer'),
        TOKEN_OPTIMIZER_STATE_DIR: join(work, 'state'),
      },
    });
    expect(r.status).toBe(0);
  }
}

describe.each(Object.entries(ENTRIES))('%s post-tool hook', (_client, entry) => {
  test('a read of an installed plugin leaves its bundle byte-identical', () => {
    const before = fingerprint(plugin);
    readThroughHook(entry);
    expect(existsSync(join(plugin, '.token-optimizer'))).toBe(false);
    expect(fingerprint(plugin)).toEqual(before);
  });
});

describe('a plugin that already holds a store from an older release', () => {
  test('session start moves it out; afterwards reads leave the bundle unchanged', async () => {
    // What 7.7.1 left behind in the reporter's plugin.
    mkdirSync(join(plugin, '.token-optimizer', 'wiki'), { recursive: true });
    writeFileSync(join(plugin, '.token-optimizer', 'wiki', 'graph.jsonl'), '{"t":"n","id":"file:x","rid":"0000000000000001"}\n');
    const { resumeIfDue } = await import('../../hooks-core/migrate.mjs');
    const env = { TOKEN_OPTIMIZER_HOME: join(home, '.token-optimizer') };

    const notice = resumeIfDue(plugin, { env, processes: () => ({ complete: true, found: [] }), background: false });
    expect(notice).toMatch(/moved this project's graph out of the repository/);
    // One change to the bundle, and only one: the store became a tombstone file.
    expect(readdirSync(plugin).filter((n) => n.startsWith('.token-optimizer'))).toEqual(['.token-optimizer']);
    expect(statSync(join(plugin, '.token-optimizer')).isFile()).toBe(true);

    const settled = fingerprint(plugin);
    readThroughHook(ENTRIES.codex);
    readThroughHook(ENTRIES['claude code']);
    expect(fingerprint(plugin)).toEqual(settled);
  });
});

describe('a repository moved to a new path keeps its graph', () => {
  function gitRepo(dir) {
    mkdirSync(dir, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git('add', 'a.ts');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'root');
  }

  test('the store follows the repository to its new path; a live clone keeps its own', async () => {
    const { projectStore } = await import('../../hooks-core/maintenance.mjs');
    const env = { TOKEN_OPTIMIZER_HOME: join(home, '.token-optimizer') };
    const original = join(work, 'repos', 'project');
    gitRepo(original);
    const store = projectStore(original, env);
    mkdirSync(join(store, 'wiki'), { recursive: true });
    writeFileSync(join(store, 'wiki', 'graph.jsonl'), '{"t":"n","id":"file:remembered"}\n');

    // A second clone of the same history that still exists keeps its own store.
    const clone = join(work, 'repos', 'clone');
    spawnSync('git', ['clone', '-q', original, clone], { encoding: 'utf8' });
    expect(projectStore(clone, env)).not.toBe(store);

    // The original moves.
    const moved = join(work, 'elsewhere', 'project');
    mkdirSync(join(work, 'elsewhere'), { recursive: true });
    renameSync(original, moved);
    const adopted = projectStore(moved, env);
    expect(readFileSync(join(adopted, 'wiki', 'graph.jsonl'), 'utf8')).toContain('file:remembered');
  });
});

describe('the capture still happens, outside the project', () => {
  test('the graph for that file lives in the per-user store', () => {
    readThroughHook(ENTRIES['claude code']);
    const projects = join(home, '.token-optimizer', 'projects');
    expect(existsSync(projects)).toBe(true);
    const stores = readdirSync(projects).filter((id) => existsSync(join(projects, id, 'store')));
    expect(stores).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(projects, stores[0], 'meta.json'), 'utf8'));
    expect(meta.root.toLowerCase()).toBe(plugin.replace(/\\/g, '/').toLowerCase());
    expect(statSync(join(projects, stores[0], 'store')).isDirectory()).toBe(true);
  });
});
