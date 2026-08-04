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
