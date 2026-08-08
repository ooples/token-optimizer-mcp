/**
 * The feedback loop, from a real transcript to a served standing rule.
 *
 * THE PRODUCER HAD NEVER BEEN RUN BY ANYTHING. harvest-worker.mjs is spawned
 * detached by the Stop adapter, and nothing else referenced it -- so when an
 * edit severed a `record(dir, {...})` call and left the file a SYNTAX ERROR,
 * the suite stayed green and the worker had simply been dead. A second defect
 * in the same file, a missing `wikiDir` import, was equally invisible.
 *
 * Loadability is guarded separately now. This is the other half: that the
 * pipeline actually produces something, end to end, through the real worker.
 *
 * THE MODEL CALL IS A LOOPBACK STUB, not a mock of the module. `localEndpoint`
 * exists because organisations route model traffic through their own gateway,
 * so pointing it at 127.0.0.1 exercises the real fetch, the real response
 * parsing, the real validation and the real write path -- everything except who
 * answers. Mocking `extract` would have proved none of that.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { load } from '../../hooks-core/wiki.mjs';
import { standingRules } from '../../hooks-core/inject.mjs';
import { ORIGIN_HUMAN } from '../../hooks-core/curate.mjs';
import { transcriptDir, safeName } from '../../hooks-core/transcript.mjs';

const WORKER = join(process.cwd(), 'plugin', 'hooks', 'harvest-worker.mjs');
const SESSION = 's-feedback-e2e';

let project;
let dir;
let server;
let endpoint;
let bodies;

/** The exact correction the user typed, which the lesson must quote verbatim. */
const USER_TURN = "no, use npm test not npx jest";

function startStub() {
  bodies = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(raw);
        // The worker calls twice: once for the code harvest, once for the
        // feedback pass. Both must be answered or the first await never
        // settles; only the second is asserted on.
        const isFeedback = /correct|wrong|instruction/i.test(raw);
        const payload = isFeedback
          ? [
              {
                type: 'feedback',
                claim: 'Use npm test, not npx jest.',
                trigger: 'jest',
                quote: USER_TURN,
                anchors: [join(project, 'a.ts')],
                confidence: 0.9,
              },
            ]
          : [];
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
  project = mkdtempSync(join(tmpdir(), 'feedback-e2e-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  dir = join(project, '.token-optimizer', 'wiki');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, 'a.ts'), 'export const a = 1;' + '\n');
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

describe('the feedback loop end to end', () => {
  // ASYNC SPAWN, NOT spawnSync. The stub server runs in THIS process, and
  // `spawnSync` blocks the event loop until the child exits -- so the child's
  // request could never be answered and both sides waited for each other until
  // the timeout. An in-process stub and a synchronous child cannot coexist.
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

  it('turns a user correction into a served standing rule', async () => {
    // The archive the Stop adapter would have written.
    mkdirSync(transcriptDir(dir), { recursive: true });
    writeFileSync(
      join(transcriptDir(dir), `${safeName(SESSION)}.jsonl`),
      [
        JSON.stringify({ role: 'user', text: 'run the tests' }),
        JSON.stringify({ role: 'assistant', text: 'Running npx jest.' }),
        JSON.stringify({ role: 'user', text: USER_TURN }),
      ].join('\n') + '\n'
    );

    // And the raw transcript the worker reads for the code harvest.
    const transcript = join(project, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'run the tests' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: join(project, 'a.ts') } },
            ],
          },
        }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: USER_TURN } }),
      ].join('\n') + '\n'
    );

    const r = await runWorker([transcript, SESSION, project], {
      TOKEN_OPTIMIZER_MODE: 'on',
      TOKEN_OPTIMIZER_WIKI_DIR: dir, TOKEN_OPTIMIZER_SHARED_DIR: dir,
      TOKEN_OPTIMIZER_HARVEST_ENDPOINT: endpoint,
    });

    // EXIT STATUS IS PART OF THE CONTRACT. This caught a crash no assertion
    // about the graph would have: process.exit() in the worker's `finally` ran
    // while the model call's sockets were still closing, so libuv aborted the
    // process with 0xC0000409 on every Windows run -- silently, because the
    // worker is detached and nothing reads its status.
    expect(r.status).toBe(0);
    expect(String(r.stderr || '')).not.toMatch(
      /SyntaxError|ReferenceError|is not defined|Assertion failed/
    );

    // The worker actually reached the model. Without this, a worker that
    // returned early would look identical to one that found nothing to learn.
    expect(bodies.length).toBeGreaterThanOrEqual(2);

    const graph = load(dir);
    const lesson = [...graph.nodes.values()].find(
      (n) => n.kind === 'finding' && n.type === 'feedback'
    );
    expect(lesson).toBeDefined();

    // Promoted BY EVIDENCE: the quote was found word-for-word in the user's own
    // turn, and travels with the claim so the provenance can be checked.
    expect(lesson.origin).toBe(ORIGIN_HUMAN);
    expect(lesson.quote).toBe(USER_TURN);
    expect(lesson.claim).toContain('npm test');

    // AND IT IS ACTUALLY SERVED. Everything above only proves it was stored;
    // delivery is the half that was disconnected, and the reason the feature
    // could pass its own unit tests while doing nothing at all.
    const rules = standingRules(dir, load(dir));
    expect(rules).toContain('Use npm test, not npx jest.');
  }, 120_000);
});

describe('the worker reports its own status honestly', () => {
  // The `finally` used to assign `process.exitCode = 0` unconditionally, which
  // would turn a harvest that had already recorded a failure into one that
  // reports success. Reported by CodeRabbit on the PR. It matters more here
  // than it looks: the worker is spawned DETACHED, so its exit status is the
  // only signal a supervisor could ever act on.
  it('does not overwrite a failure code recorded before the finally', async () => {
    const { mkdtempSync: mk, writeFileSync: wf } = await import('fs');
    const probe = join(mkdtempSync(join(tmpdir(), 'exitcode-')), 'probe.mjs');
    mkdirSync(join(probe, '..'), { recursive: true });

    // The exact shape of the worker's tail, in isolation: a main() that records
    // a failure, the same catch, and the same finally.
    wf(
      probe,
      [
        'async function main() { process.exitCode = 3; throw new Error("boom"); }',
        'main()',
        '  .catch(() => {})',
        '  .finally(() => {',
        '    const code = process.exitCode ?? 0;',
        '    process.exitCode = code;',
        '    const w = setTimeout(() => process.exit(code), 5000);',
        '    w.unref();',
        '  });',
      ].join('\n')
    );

    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [probe]);
      c.on('close', (code) => resolve(code));
    });
    expect(r).toBe(3);
  }, 60_000);
});
