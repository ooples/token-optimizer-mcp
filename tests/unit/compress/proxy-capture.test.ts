/**
 * Capture writes conversation content to disk, which is the one thing the proxy
 * otherwise promises never to do. These pin the guards that make that
 * defensible rather than reckless.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureDir,
  captureRequest,
  captureNotice,
} from '../../../src/proxy/capture.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cap-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('capture is off unless a path is named', () => {
  test('absent means off', () => {
    expect(captureDir({})).toBeNull();
  });

  test('a BOOLEAN is refused, in both directions', () => {
    // THE SHAPE IS THE GUARD. If `=1` enabled capture, someone could turn on
    // writing conversation content to a default location without ever deciding
    // where it should live. Naming a directory is the decision.
    for (const value of ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off']) {
      expect(captureDir({ TOKEN_OPTIMIZER_PROXY_CAPTURE: value })).toBeNull();
    }
  });

  test('whitespace is not a path', () => {
    expect(captureDir({ TOKEN_OPTIMIZER_PROXY_CAPTURE: '   ' })).toBeNull();
  });

  test('a real path turns it on', () => {
    expect(captureDir({ TOKEN_OPTIMIZER_PROXY_CAPTURE: '/tmp/corpus' })).toBe(
      '/tmp/corpus'
    );
  });
});

describe('what it writes', () => {
  test('one JSON line per request, carrying the body verbatim', async () => {
    // Verbatim matters: the corpus exists to measure what compression would
    // remove, so anything normalised on the way in is a measurement of the
    // normalisation instead.
    const body = Buffer.from(
      JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
    );
    expect(await captureRequest(dir, '/v1/messages', body)).toBe(true);

    const lines = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row.path).toBe('/v1/messages');
    expect(row.body).toBe(body.toString('utf8'));
    expect(typeof row.at).toBe('number');
  });

  test('appends rather than overwriting', async () => {
    await captureRequest(dir, '/v1/messages', Buffer.from('{"a":1}'));
    await captureRequest(dir, '/v1/messages', Buffer.from('{"b":2}'));
    const lines = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
  });

  test('creates the directory rather than requiring one', async () => {
    const nested = join(dir, 'deep', 'corpus');
    expect(
      await captureRequest(nested, '/v1/messages', Buffer.from('{}'))
    ).toBe(true);
    expect(existsSync(join(nested, 'requests.jsonl'))).toBe(true);
  });
});

describe('it never fails the request it is observing', () => {
  test('an unwritable destination returns false rather than throwing', async () => {
    // FAIL SILENT, like every optional path in this proxy. The user is waiting
    // on a response; a full disk must not become their problem.
    //
    // A NUL byte rather than a parent-is-a-file path: the latter is refused on
    // POSIX and tolerated on Windows, so it tested the platform rather than the
    // guard. A NUL is rejected by both, which is what makes this assertion mean
    // the same thing everywhere it runs.
    // Built rather than written as an escape: a literal NUL in source is what
    // `no-stray-control-characters` exists to catch, and it caught this one.
    const nul = String.fromCharCode(0);
    expect(
      await captureRequest(`bad${nul}dir`, '/v1/messages', Buffer.from('{}'))
    ).toBe(false);
  });
});

test('concurrent large captures remain complete JSON lines in arrival order', async () => {
  const bodies = Array.from(
    { length: 12 },
    (_, i) => `${i}:${'x'.repeat(128 * 1024)}`
  );
  expect(
    await Promise.all(
      bodies.map((body) =>
        captureRequest(dir, '/v1/messages', Buffer.from(body))
      )
    )
  ).toEqual(bodies.map(() => true));
  const rows = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n');
  expect(rows.map((row) => JSON.parse(row).body)).toEqual(bodies);
});

describe('it announces itself', () => {
  test('the notice names the path and what it does', () => {
    // Built with `join`, so the separator is the platform's. Asserting a POSIX
    // literal tested the separator rather than the message, and failed on
    // Windows for a reason that had nothing to do with the behaviour.
    const notice = captureNotice(join('tmp', 'corpus'));
    expect(notice).toContain(join('tmp', 'corpus', 'requests.jsonl'));
    expect(notice).toMatch(/conversation content/i);
    expect(notice).toMatch(/plaintext/i);
    // And how to stop, because a warning without a remedy is just noise.
    expect(notice).toContain('TOKEN_OPTIMIZER_PROXY_CAPTURE');
  });
});

test('streamed capture preserves chunk-edge Unicode, escapes, and the enqueue snapshot', async () => {
  const text =
    'a'.repeat(65535) + '🙂' + String.fromCharCode(0) + '\\"\n' + 'z';
  const body = Buffer.from(text);
  const write = captureRequest(dir, '/responses', body);
  body.fill(120);
  expect(await write).toBe(true);
  expect(
    JSON.parse(readFileSync(join(dir, 'requests.jsonl'), 'utf8')).body
  ).toBe(text);
});

test('capture pressure is bounded across destinations and capacity returns after draining', async () => {
  const body = Buffer.alloc(128 * 1024, 120);
  const writes = Array.from({ length: 300 }, (_, i) =>
    captureRequest(join(dir, String(i % 3)), '/responses', body)
  );
  const results = await Promise.all(writes);
  expect(results.filter(Boolean).length).toBeGreaterThan(0);
  expect(results.filter(Boolean).length).toBeLessThan(128);
  expect(results.filter((v) => !v).length).toBeGreaterThan(0);
  expect(
    await captureRequest(dir, '/responses', Buffer.from('recovered'))
  ).toBe(true);
  expect(
    JSON.parse(readFileSync(join(dir, 'requests.jsonl'), 'utf8')).body
  ).toBe('recovered');
});
