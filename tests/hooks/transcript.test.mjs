/**
 * The archive: complete, local, and never transmitted.
 *
 * Storing the whole conversation is only defensible if two things hold. It must
 * never leave the machine, and it must never be what gets retrieved -- the
 * lessons extracted from it are. A store that is both complete and retrievable
 * would drown injection in thousands of ordinary turns.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  readTurns, archive, readArchive, prune, isArchived, transcriptDir, safeName,
} from '../../hooks-core/transcript.mjs';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { load, nodeId } from '../../hooks-core/wiki.mjs';

let dir;
let transcript;

/** A Claude transcript: JSONL, one message per line. */
function writeTranscript(entries) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-'));
  transcript = writeTranscript([
    { type: 'user', message: { role: 'user', content: 'run the tests' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running them.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npx jest tests/' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'PASS tests/a.test.ts\nTests: 40 passed' }],
      },
    },
    { type: 'user', message: { role: 'user', content: 'no, use npm test' } },
  ]);
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('readTurns', () => {
  it('keeps the conversation and the commands', () => {
    const turns = readTurns(transcript);
    expect(turns.find((t) => t.role === 'user' && t.text === 'run the tests')).toBeTruthy();
    expect(turns.find((t) => t.role === 'assistant')?.tools?.[0]?.command).toBe('npx jest tests/');
    expect(turns.find((t) => t.text === 'no, use npm test')).toBeTruthy();
  });

  it('drops tool RESULTS, which is where file contents would enter the record', () => {
    const turns = readTurns(transcript);
    const all = JSON.stringify(turns);
    expect(all).not.toContain('PASS tests/a.test.ts');
    expect(all).not.toContain('Tests: 40 passed');
  });

  it('returns nothing for an unreadable transcript instead of throwing', () => {
    expect(readTurns(join(dir, 'does-not-exist.jsonl'))).toEqual([]);
  });
});

describe('archive', () => {
  it('writes the session and reads back the same turns', () => {
    const n = archive(dir, transcript, { sessionId: 'sess-1' });
    expect(n).toBeGreaterThan(0);

    const back = readArchive(dir, 'sess-1');
    expect(back.length).toBe(n);
    expect(back.some((t) => t.text === 'no, use npm test')).toBe(true);
  });

  it('does not multiply the record when Stop fires repeatedly', () => {
    // Stop fires at the end of every assistant turn and the transcript is
    // cumulative, so appending would store the early turns once per firing.
    archive(dir, transcript, { sessionId: 'sess-1' });
    archive(dir, transcript, { sessionId: 'sess-1' });
    archive(dir, transcript, { sessionId: 'sess-1' });

    expect(readArchive(dir, 'sess-1').length).toBe(readTurns(transcript).length);
  });

  it('cannot be made to write outside its directory by the session id', () => {
    archive(dir, transcript, { sessionId: '../../escaped' });
    // THE INVARIANT IS CONTAINMENT, not the absence of dots. A name like
    // ".._.._escaped.jsonl" contains ".." and traverses nothing -- it is one
    // ordinary flat entry. Asserting on the substring fails correct code, which
    // is a mistake this repository has already made once.
    const root = transcriptDir(dir);
    const files = readdirSync(root);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(dirname(resolve(root, f))).toBe(resolve(root));
    }
    expect(existsSync(join(dir, '..', 'escaped.jsonl'))).toBe(false);
  });

  it('sanitises a session id of nothing but dots', () => {
    expect(safeName('...')).toBe('unknown');
    expect(safeName('')).toBe('unknown');
  });
});

describe('the never-transmit rule', () => {
  it('recognises an archived path so the harvest can exclude it', () => {
    expect(isArchived('C:/repo/.token-optimizer/wiki/transcripts/abc.jsonl')).toBe(true);
    expect(isArchived('/repo/.token-optimizer/wiki/transcripts/abc.jsonl')).toBe(true);
    expect(isArchived('C:/repo/src/index.ts')).toBe(false);
    // The graph itself is fine to reason about; only the raw conversation is not.
    expect(isArchived('C:/repo/.token-optimizer/wiki/graph.jsonl')).toBe(false);
  });
});

describe('prune', () => {
  it('drops the oldest sessions once the budget is exceeded', () => {
    const root = transcriptDir(dir);
    mkdirSync(root, { recursive: true });
    for (const name of ['old', 'mid', 'new']) {
      writeFileSync(join(root, `${name}.jsonl`), 'x'.repeat(1000));
    }

    const dropped = prune(root, 1500);
    expect(dropped).toBeGreaterThan(0);

    const left = readdirSync(root);
    expect(left.length).toBeLessThan(3);
  });

  it('keeps everything when under budget', () => {
    const root = transcriptDir(dir);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.jsonl'), 'x'.repeat(10));
    expect(prune(root, 1_000_000)).toBe(0);
    expect(readdirSync(root)).toHaveLength(1);
  });
});

describe('the never-transmit guarantee is enforced, not merely stated', () => {
  it('does not harvest a transcript the agent happens to open', () => {
    // `isArchived` is the test for "this path is a stored conversation". It was
    // written, unit-tested, and called from NOWHERE -- so the guarantee it
    // describes was enforced by nothing.
    //
    // The exposure is ordinary, not exotic: archived transcripts are plain
    // files on disk. An agent that greps the project or opens one to look at it
    // sends it through the PreToolUse router, which hashes, snapshots and
    // indexes every file it lets through. The user's own words would land in
    // the graph, and injection would later serve them back into context.
    //
    // So this drives the REAL router at a real archive path and asserts the
    // graph never learned it. Unit-testing `isArchived` cannot show this: the
    // function was always correct, it was simply never asked.
    const project = mkdtempSync(join(tmpdir(), 'archive-leak-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    const graph = mkdtempSync(join(tmpdir(), 'archive-graph-'));

    const archived = join(project, '.token-optimizer', 'wiki', 'transcripts', 's-old.jsonl');
    mkdirSync(dirname(archived), { recursive: true });
    writeFileSync(
      archived,
      JSON.stringify({ prompt: 'my AWS key is AKIAEXAMPLE', response: 'noted' }) + '\n'
    );

    // A normal file in the same session, to prove the router was working at all
    // and the archive was skipped specifically.
    const ordinary = join(project, 'ordinary.ts');
    writeFileSync(ordinary, 'export const ordinary = 1;\n');

    // `fileURLToPath`, NOT `pathname.slice(1)`. Stripping the leading slash is
    // right for a Windows file URL (`/C:/...`) and wrong everywhere else, where
    // it turns `/home/runner/...` into a relative path -- so the router was
    // never spawned on CI and the CONTROL assertion failed, which is the only
    // reason this was caught rather than passing vacuously.
    const router = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'plugin',
      'hooks',
      'pretooluse-router.mjs'
    );

    for (const target of [archived, ordinary]) {
      spawnSync(process.execPath, [router], {
        input: JSON.stringify({
          session_id: 's-archive-leak',
          cwd: project,
          tool_name: 'Read',
          tool_input: { file_path: target },
        }),
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, TOKEN_OPTIMIZER_WIKI_DIR: graph, TOKEN_OPTIMIZER_SHARED_DIR: graph },
      });
    }

    const g = load(graph);
    const keys = [...g.nodes.values()].filter((n) => n.kind === 'file').map((n) => n.key);

    // The control: the router did run and did harvest.
    expect(keys.some((k) => k.endsWith('ordinary.ts'))).toBe(true);

    // The guarantee: nothing about the archive, under any spelling.
    expect(g.nodes.has(nodeId('file', archived))).toBe(false);
    expect(keys.some((k) => k.includes('transcripts'))).toBe(false);

    // And its contents were never stored anywhere in the graph.
    const dump = JSON.stringify([...g.nodes.values()]);
    expect(dump).not.toContain('AKIAEXAMPLE');

    for (const d of [project, graph]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows */
      }
    }
  }, 60_000);
});
