/**
 * The harvest worker resolves the repository root before it picks a graph.
 *
 * A session can start anywhere inside a repository, and the worker is handed
 * that cwd verbatim. `wikiDir` only joins the path it is given -- it does not
 * walk up -- so a cwd one directory down selected `<subdir>/.token-optimizer/wiki`:
 * a second graph that no other hook reads, because every other entry point
 * (the adapter, session-start, the Stop adapter) resolves the root first.
 *
 * The same value was passed as `projectRoot`, which is the containment root the
 * write is checked against, so a finding anchored anywhere else in the same
 * repository was refused for sitting "outside" the project.
 *
 * This runs the real worker against a loopback model stub, and deliberately
 * does NOT set TOKEN_OPTIMIZER_WIKI_DIR: that variable short-circuits the very
 * computation under test, which is why the existing end-to-end coverage could
 * not have caught this.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load, nodeId } from '../../hooks-core/wiki.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

const WORKER = join(process.cwd(), 'plugin', 'hooks', 'harvest-worker.mjs');
const SESSION = 's-subdir-root';

let project;
let subdir;
let anchoredFile;
let server;
let endpoint;

function startStub() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        // One finding, anchored at a file in the REPOSITORY ROOT -- above the
        // cwd the worker is given. Under the old containment root that anchor
        // was outside the project and the finding was dropped.
        const payload = [
          {
            type: 'finding',
            claim: 'The subdirectory harvest must land in the repository graph.',
            evidence: 'The worker resolved the repository root before selecting a graph.',
            applicability: 'Any session started below the repository root.',
            confidenceLabel: 'verified',
            anchors: [anchoredFile],
          },
        ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }));
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}/v1/messages`)
    );
  });
}

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'harvest-subdir-')));
  mkdirSync(join(project, '.git'), { recursive: true });
  subdir = join(project, 'packages', 'worker');
  mkdirSync(subdir, { recursive: true });
  anchoredFile = join(project, 'a.ts');
  writeFileSync(anchoredFile, 'export const a = 1;\n');
  endpoint = await startStub();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  try {
    rmSync(project, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

function runWorker(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ status: code, stderr }));
    child.on('error', () => resolve({ status: -1, stderr }));
  });
}

describe('harvest worker run from a repository subdirectory', () => {
  it('writes the repository graph and keeps an anchor above the cwd', async () => {
    const transcript = join(project, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'change a.ts' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Edit', input: { file_path: anchoredFile } }],
          },
        }),
      ].join('\n') + '\n'
    );

    // cwd is the SUBDIRECTORY, which is the whole point.
    const r = await runWorker([transcript, SESSION, subdir], {
      TOKEN_OPTIMIZER_MODE: 'on',
      TOKEN_OPTIMIZER_HARVEST_ENDPOINT: endpoint,
    });
    expect(r.status).toBe(0);

    const repoGraph = join(project, '.token-optimizer', 'wiki');
    const strayGraph = join(subdir, '.token-optimizer', 'wiki');

    // The graph belongs to the repository, not to whichever directory the
    // session happened to start in.
    expect(existsSync(repoGraph)).toBe(true);
    expect(existsSync(strayGraph)).toBe(false);

    // And the finding survived: an anchor above the cwd is inside the project.
    // Node ids are hashes of the canonical path, so the id is computed rather
    // than matched as a substring.
    const nodes = load(repoGraph).nodes;
    expect(nodes.has(nodeId('file', canonicalPath(anchoredFile)))).toBe(true);
  }, 30000);
});
