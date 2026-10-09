/**
 * The transcript archive is built incrementally, and is byte-identical to a rebuild.
 *
 * Stop fires on every turn. Rebuilding the archive from the whole transcript each
 * time cost 1.0-1.1 s per Stop on a 45.6 MB transcript (issue #473, defect 9), so
 * `archive()` now parses only what was appended since the last call. These tests
 * pin the property that makes that safe: however the transcript grows -- including
 * a Stop that lands while the last line is half-written -- the archive equals the
 * one a full rebuild would write.
 */

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archive } from '../../hooks-core/transcript.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archive-inc-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const user = (i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `question ${i}` }, timestamp: `t${i}` });
const assistant = (i) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }, { type: 'tool_use', name: 'Bash', input: { command: `echo ${i}` } }] },
    timestamp: `t${i}`,
  });
const lines = (from, to) => {
  const out = [];
  for (let i = from; i < to; i++) out.push(user(i), assistant(i));
  return out.join('\n') + '\n';
};

const archived = (dir) => readFileSync(join(dir, '.token-optimizer', 'wiki', 'transcripts', 's1.jsonl'), 'utf8');
const wiki = (name) => join(root, name, '.token-optimizer', 'wiki');

test('growing in steps gives the same archive as one rebuild', () => {
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, lines(0, 5));
  archive(wiki('inc'), transcript, { sessionId: 's1' });
  appendFileSync(transcript, lines(5, 9));
  archive(wiki('inc'), transcript, { sessionId: 's1' });
  archive(wiki('inc'), transcript, { sessionId: 's1' });

  archive(wiki('full'), transcript, { sessionId: 's1' });

  expect(archived(join(root, 'inc'))).toBe(archived(join(root, 'full')));
  expect(archived(join(root, 'inc')).split('\n').filter(Boolean)).toHaveLength(18);
});

test('a Stop during a half-written line picks the line up once it completes', () => {
  const transcript = join(root, 'session.jsonl');
  const whole = user(1);
  writeFileSync(transcript, lines(0, 1) + whole.slice(0, 20));
  archive(wiki('inc'), transcript, { sessionId: 's1' });
  appendFileSync(transcript, whole.slice(20) + '\n');
  archive(wiki('inc'), transcript, { sessionId: 's1' });

  archive(wiki('full'), transcript, { sessionId: 's1' });

  expect(archived(join(root, 'inc'))).toBe(archived(join(root, 'full')));
  expect(archived(join(root, 'inc'))).toContain('question 1');
});

test('a transcript that shrank is rebuilt rather than appended to', () => {
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, lines(0, 6));
  archive(wiki('inc'), transcript, { sessionId: 's1' });
  writeFileSync(transcript, lines(100, 102));
  archive(wiki('inc'), transcript, { sessionId: 's1' });

  const text = archived(join(root, 'inc'));
  expect(text).toContain('question 100');
  expect(text).not.toContain('question 0');
});

test('concurrent archivers do not append the same turns twice', async () => {
  // Appending is not idempotent the way the old rewrite was. Measured before
  // the lock existed: eight processes archiving the same growth wrote 10.7 MB
  // where the rebuild is 2.1 MB -- every new turn appended about five times.
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, lines(0, 200));
  const dir = wiki('inc');
  archive(dir, transcript, { sessionId: 's1' });
  appendFileSync(transcript, lines(200, 2000));

  const moduleUrl = pathToFileURL(join(ROOT, 'hooks-core', 'transcript.mjs')).href;
  const script =
    `import(${JSON.stringify(moduleUrl)}).then(({ archive }) => ` +
    `archive(${JSON.stringify(dir)}, ${JSON.stringify(transcript)}, { sessionId: 's1' }))`;
  await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve) => {
          spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' }).on(
            'close',
            resolve
          );
        })
    )
  );

  archive(wiki('full'), transcript, { sessionId: 's1' });
  expect(archived(join(root, 'inc'))).toBe(archived(join(root, 'full')));
});

test('an archive written before coverage existed is rebuilt once, then extended', () => {
  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, lines(0, 3));
  const dir = wiki('inc');
  archive(dir, transcript, { sessionId: 's1' });
  // Simulate the previous version: an archive with no coverage record.
  rmSync(join(dir, 'transcripts', 's1.covered'));
  appendFileSync(transcript, lines(3, 4));
  archive(dir, transcript, { sessionId: 's1' });

  expect(existsSync(join(dir, 'transcripts', 's1.covered'))).toBe(true);
  archive(wiki('full'), transcript, { sessionId: 's1' });
  expect(archived(join(root, 'inc'))).toBe(archived(join(root, 'full')));
});
