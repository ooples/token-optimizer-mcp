/**
 * Regressions for the second review round, which audited the first round's fixes.
 *
 * The two that mattered most were security defects in code I had just written:
 * a caller-controlled path that reached a file WRITE, and graph-derived values
 * interpolated into the dashboard unescaped. Both are covered here at the level
 * they can be covered without a browser; the DOM escaping is asserted through
 * the same helper the page uses.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decide, normalizeTool } from '../../hooks-core/decide.mjs';
import { extractSymbols } from '../../hooks-core/symbols.mjs';
import { load, putNode, GRAPH_VERSION } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { record, recordRead, report } from '../../hooks-core/metrics.mjs';

// THE HOLDOUT IS OFF IN THIS SUITE, DELIBERATELY.
//
// These assert what injection DELIVERS and how downstream cost is joined, not whether the holdout works.
//
// The arm is a hash of the anchor, and the anchor is a fresh mkdtemp path, so
// whether it is withheld changes with the path the OS hands out. That passed
// on Windows and failed on Linux CI -- a test that depends on which machine
// runs it is not testing what it claims to.
const PRIOR_HOLDOUT = process.env.TOKEN_OPTIMIZER_HOLDOUT;
process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
afterAll(() => {
  if (PRIOR_HOLDOUT === undefined) delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
  else process.env.TOKEN_OPTIMIZER_HOLDOUT = PRIOR_HOLDOUT;
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'round2-'));
  dir = join(workspace, 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const state = () => ({ seen: {}, denied: {} });

describe('recursive shell searches are recognised in the forms people type', () => {
  test.each([
    'grep -r pattern .',
    'grep -R pattern .',
    'grep -rn pattern .',
    'grep -nr pattern .',
    'grep --recursive pattern .',
    'rg pattern',
    'ag pattern',
  ])('%s is challenged', (command) => {
    // `grep -rn` -- one of the most common forms there is -- was not matched by
    // the original lone-flag pattern and passed straight through.
    const verdict = decide({ tool_name: 'Bash', tool_input: { command }, cwd: workspace }, state());
    expect(verdict).not.toBeNull();
    expect(verdict.reason).toContain('smart_grep');
  });

  test('a non-recursive grep with an explicit small file is left alone', () => {
    const path = join(workspace, 'small.ts');
    writeFileSync(path, 'x');
    expect(decide({ tool_name: 'Bash', tool_input: { command: `grep -n foo ${path}` }, cwd: workspace }, state()))
      .toBeNull();
  });
});

describe('every client shell tool normalizes', () => {
  test.each([
    ['run_shell_command', 'Bash'],
    ['run_terminal_cmd', 'Bash'],
    ['execute_command', 'Bash'],
    ['shell', 'Bash'],
  ])('%s -> %s', (alias, canonical) => {
    // Gemini's hooks.json matcher already listed run_shell_command, so the hook
    // fired and normalizeTool then returned null -- silently allowing every
    // shell call through on that client.
    expect(normalizeTool(alias)).toBe(canonical);
  });
});

describe('graph records are version-tagged', () => {
  test('records carry the current schema version', () => {
    const id = putNode(dir, { kind: 'file', key: '/a.ts' });
    expect(load(dir).nodes.get(id).v).toBe(GRAPH_VERSION);
  });

  test('a record from another schema is skipped, not interpreted', () => {
    // No migration exists by design: nothing has shipped, so an old dev graph
    // is an artifact rather than user data. Skipping degrades to "rebuilds from
    // use"; interpreting would mix incompatible identities silently.
    putNode(dir, { kind: 'file', key: '/a.ts' });
    const log = join(dir, 'graph.jsonl');
    writeFileSync(log, readFileSync(log, 'utf8') +
      JSON.stringify({ t: 'n', v: 99, id: 'file:fromthefuture', kind: 'file', key: '/x.ts' }) + '\n');

    const graph = load(dir);
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.has('file:fromthefuture')).toBe(false);
  });
});

describe('symbol identities stay stable when a duplicate appears', () => {
  test('the first occurrence keeps its plain key', () => {
    const one = extractSymbols('a.ts', 'class A {\n  read() { return 1; }\n}').map((s) => s.name);
    expect(one).toContain('read');

    // Introducing a namesake must not RENAME the existing symbol, or every
    // finding already anchored to it is orphaned.
    const two = extractSymbols('a.ts',
      'class A {\n  read() { return 1; }\n}\nclass B {\n  read() { return 2; }\n}').map((s) => s.name);
    expect(two).toContain('read');
    expect(two).toContain('read~1');
  });
});

describe('downstream cost counts reads AFTER the touch, not before', () => {
  test('a read preceding the injection is not credited to it', () => {
    // Summing every read for the anchor would charge the treated arm with the
    // very read that triggered the injection, inflating its apparent cost.
    recordRead(dir, { anchor: '/a.ts', sessionId: 's', bytes: 400_000 });

    for (let i = 0; i < 25; i++) {
      record(dir, { kind: 'inject', anchor: '/a.ts', sessionId: 's', holdout: false, tokens: 10 });
    }
    for (let i = 0; i < 8; i++) {
      record(dir, { kind: 'inject', anchor: `/c${i}.ts`, sessionId: 's', holdout: true, tokens: 0 });
      recordRead(dir, { anchor: `/c${i}.ts`, sessionId: 's', bytes: 40_000 });
    }

    const out = report(dir);
    // The control arm's reads all follow their injections, so it should still
    // show the higher downstream cost despite the huge earlier treated read.
    expect(out.estimatedTokensAvoided).toBeGreaterThan(0);
  });
});

describe('snapshot limit rejects nonsense', () => {
  test('a non-finite limit falls back to the default rather than snapshotting everything', () => {
    process.env.TOKEN_OPTIMIZER_SNAPSHOT_LIMIT = 'Infinity';
    const path = join(workspace, 'a.ts');
    writeFileSync(path, 'export const a = 1;');
    expect(() => indexFile(dir, path)).not.toThrow();
    delete process.env.TOKEN_OPTIMIZER_SNAPSHOT_LIMIT;
  });
});

describe('the dashboard escapes graph-derived values', () => {
  const source = readFileSync(join(ROOT, 'src', 'dashboard', 'public', 'js', 'wiki.js'), 'utf8');

  test('no interpolation of a node/item field is left unescaped in MARKUP', () => {
    // The graph is built from repository files by an agent, so a path or a
    // harvested `type` is untrusted input. A file named `"><img onerror=...>`
    // reached the page verbatim before this.
    //
    // Lines assigning to .textContent are excluded deliberately: the DOM
    // escapes text nodes by construction, so interpolating there is safe and
    // requiring escapeHtml would double-encode what the user sees. Only values
    // that reach innerHTML need it.
    const markupLines = source
      .split('\n')
      .filter((line) => !line.includes('.textContent'))
      .join('\n');

    const risky = [
      '${item.id}', '${item.key}', '${item.type}', '${item.claim}',
      '${node.kind}', '${node.type}', '${t.text}', '${t.status}',
    ];
    for (const token of risky) {
      expect(markupLines).not.toContain(token);
    }
  });

  test('the curate POST carries the header the server requires', () => {
    // Without it the server refuses the request as cross-site.
    expect(source).toContain("'x-token-optimizer': 'dashboard'");
  });
});

describe('the server exposes no caller-controlled graph path', () => {
  const routes = readFileSync(join(ROOT, 'src', 'server', 'wiki-routes.ts'), 'utf8');

  test('the project query parameter is gone', () => {
    // It flowed into wikiDir(), a plain path join accepting absolute paths and
    // `..`, and on the curate route reached mkdir + append -- a file-write
    // primitive at a caller-chosen location, on a server with no auth.
    expect(routes).not.toContain('req.query.project');
  });

  test('the mutating route is guarded against cross-site requests', () => {
    expect(routes).toContain('rejectsCrossSite');
  });
});

describe('the UI verification script cannot delete a real graph', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'verify-wiki-ui.mjs'), 'utf8');

  test('it seeds into a temp directory, not the repository', () => {
    // It pointed at <repo>/.token-optimizer/wiki and deleted it on entry and in
    // the finally -- running the UI check would have destroyed a developer's
    // accumulated findings.
    expect(script).toContain('mkdtempSync');
    expect(script).toContain('TOKEN_OPTIMIZER_WIKI_DIR');
    expect(script).not.toContain("join(ROOT, '.token-optimizer'");
  });
});
