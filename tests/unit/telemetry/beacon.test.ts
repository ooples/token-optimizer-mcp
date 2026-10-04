/**
 * What the beacon refuses, and the one case where it sends.
 *
 * `fetch` is INJECTED rather than patched globally, so a test that gets the
 * gating wrong fails by recording a captured request instead of by reaching the
 * real receiver: no configuration of this suite can talk to Supabase. Each test
 * gets a disposable home, and the env is passed as an argument rather than set
 * on `process.env`, for the reason recorder.test.ts records -- under
 * --experimental-vm-modules, `jest.resetModules()` does not evict a module
 * loaded by dynamic import.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flushBeacon,
  pendingEvents,
  eventFromLine,
  MAX_BATCH,
} from '../../../src/telemetry/beacon.js';
import { eventsFile, telemetryDir } from '../../../src/telemetry/recorder.js';
import {
  beaconTable,
  beaconUrl,
  TABLE_DEFAULT,
  URL_DEFAULT,
} from '../../../src/telemetry/credentials.js';

let home: string;

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ USERPROFILE: home, HOME: home, ...extra }) as NodeJS.ProcessEnv;

const armed = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  base({
    TOKEN_OPTIMIZER_TELEMETRY: '1',
    TOKEN_OPTIMIZER_BEACON: '1',
    TOKEN_OPTIMIZER_BEACON_KEY: 'test-anon-key',
    ...extra,
  });

const row = (n: number): string =>
  JSON.stringify({
    event_type: 'proxy_request',
    machine_id_hash: 'a'.repeat(32),
    library_version: '7.1.0',
    timestamp_utc: '2026-09-27T00:00:00.000Z',
    properties: { saved: n, armed: true },
  });

const seed = (lines: string[], env: NodeJS.ProcessEnv): void => {
  mkdirSync(telemetryDir(env), { recursive: true });
  writeFileSync(eventsFile(env), lines.map((l) => l + '\n').join(''), 'utf8');
};

interface Captured {
  url: string;
  init: { headers?: Record<string, string>; body?: string };
}

/** A fetch that records what it was handed and answers with `status`. */
const recording = (status = 201): { calls: Captured[]; impl: typeof fetch } => {
  const calls: Captured[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    const opts = (init ?? {}) as { headers?: Record<string, string>; body?: string };
    calls.push({ url: String(url), init: opts });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
};

/** A fetch that must never run. Any call fails the test that permitted it. */
const forbidden = (async () => {
  throw new Error('the beacon made a request it was not permitted to make');
}) as unknown as typeof fetch;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'telemetry-beacon-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('what the beacon refuses', () => {
  it('sends nothing when only local aggregation is on', async () => {
    const env = base({ TOKEN_OPTIMIZER_TELEMETRY: '1' });
    seed([row(1)], env);
    const out = await flushBeacon(env, forbidden);
    expect(out).toEqual({ sent: 0, refused: 'upload is not enabled' });
  });

  it('sends nothing when DO_NOT_TRACK is set, however armed the rest is', async () => {
    const env = armed({ DO_NOT_TRACK: '1' });
    seed([row(1)], env);
    const out = await flushBeacon(env, forbidden);
    // THE GATE REFUSED, NOT THE STUB. `forbidden` throws, and flushBeacon turns
    // a throw into `upload failed: ...` -- so asserting only `sent === 0` would
    // pass just as well if the request had been attempted and blown up.
    expect(out.refused).toBe('upload is not enabled');
  });

  it('sends nothing when the build was packed without a key', async () => {
    // KEY_DEFAULT is empty in the tree on purpose: a published npm package
    // carrying an anon key has shipped a credential it cannot rotate back.
    const env = base({ TOKEN_OPTIMIZER_TELEMETRY: '1', TOKEN_OPTIMIZER_BEACON: '1' });
    seed([row(1)], env);
    const out = await flushBeacon(env, forbidden);
    expect(out.refused).toContain('no beacon key');
  });

  it('makes no request when there is nothing recorded', async () => {
    const out = await flushBeacon(armed(), forbidden);
    expect(out).toEqual({ sent: 0, refused: 'nothing to send' });
  });
});

describe('the log the events live in', () => {
  it('keeps the events when the receiver refuses', async () => {
    const env = armed();
    seed([row(1), row(2)], env);
    const before = readFileSync(eventsFile(env), 'utf8');
    const { impl } = recording(503);
    const out = await flushBeacon(env, impl);
    expect(out).toEqual({ sent: 0, refused: 'receiver refused with 503' });
    // STILL THERE, which is the property that makes an offline week cost
    // nothing. Clearing before a confirmed insert is how intermittent
    // connectivity turns into no data at all.
    expect(readFileSync(eventsFile(env), 'utf8')).toBe(before);
  });

  it('keeps the events when the request itself throws', async () => {
    const env = armed();
    seed([row(1)], env);
    const before = readFileSync(eventsFile(env), 'utf8');
    const out = await flushBeacon(env, forbidden);
    expect(out.sent).toBe(0);
    expect(out.refused).toContain('upload failed');
    expect(readFileSync(eventsFile(env), 'utf8')).toBe(before);
  });

  it('clears it only after a 2xx', async () => {
    const env = armed();
    seed([row(1), row(2), row(3)], env);
    const { impl } = recording(200);
    const out = await flushBeacon(env, impl);
    expect(out).toEqual({ sent: 3, refused: null });
    expect(readFileSync(eventsFile(env), 'utf8')).toBe('');
  });

  it('caps one flush at MAX_BATCH events', async () => {
    const env = base();
    seed(
      Array.from({ length: MAX_BATCH + 25 }, (_, i) => row(i)),
      env
    );
    expect(await pendingEvents(env)).toHaveLength(MAX_BATCH);
  });

  it('drops a line that is missing a field rather than defaulting it', () => {
    expect(eventFromLine('not json at all')).toBeNull();
    expect(eventFromLine(JSON.stringify({ event_type: 'x' }))).toBeNull();
    expect(eventFromLine(JSON.stringify([1, 2]))).toBeNull();
    expect(eventFromLine(JSON.stringify({ ...JSON.parse(row(1)), library_version: '' }))).toBeNull();
    expect(eventFromLine(row(1))?.event_type).toBe('proxy_request');
  });

  it('skips the unreadable lines and still sends the readable ones', async () => {
    const env = armed();
    seed([row(1), '{ truncated', row(2)], env);
    const { calls, impl } = recording();
    const out = await flushBeacon(env, impl);
    expect(out.sent).toBe(2);
    expect(JSON.parse(String(calls[0].init.body))).toHaveLength(2);
  });
});

describe('what goes on the wire', () => {
  it('posts to the project rest endpoint with the key in both places', async () => {
    const env = armed();
    seed([row(1)], env);
    const { calls, impl } = recording();
    await flushBeacon(env, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_DEFAULT + '/rest/v1/' + TABLE_DEFAULT);
    const headers = calls[0].init.headers ?? {};
    expect(headers.apikey).toBe('test-anon-key');
    expect(headers.authorization).toBe('Bearer test-anon-key');
    expect(headers.prefer).toBe('return=minimal');
  });

  it('transmits no string beyond the four the schema names', async () => {
    const env = armed();
    // A LINE WITH CONTENT IN IT, as an edited or appended log could hold. The
    // guarantee in event.ts covers what we construct; this covers what we send
    // after the file has sat on disk between the two.
    seed(
      [
        JSON.stringify({
          event_type: 'proxy_request',
          machine_id_hash: 'b'.repeat(32),
          library_version: '7.1.0',
          timestamp_utc: '2026-09-27T00:00:00.000Z',
          properties: {
            saved: 12,
            prompt: 'the private text of a real conversation',
            path: 'C:/Users/someone/secret/file.ts',
            nested: { still: 'a string' },
          },
        }),
      ],
      env
    );
    const { calls, impl } = recording();
    await flushBeacon(env, impl);
    const sent = String(calls[0].init.body);
    expect(sent).not.toContain('private text');
    expect(sent).not.toContain('secret');
    expect(sent).not.toContain('still');
    expect(JSON.parse(sent)[0].properties).toEqual({ saved: 12 });
  });
});

describe('where it is pointed', () => {
  it('takes an override for the project, and trims a trailing slash', () => {
    expect(beaconUrl(base({ TOKEN_OPTIMIZER_BEACON_URL: 'https://x.test/' }))).toBe(
      'https://x.test'
    );
    expect(beaconUrl(base())).toBe(URL_DEFAULT);
  });

  it('refuses a table name that is not an identifier', () => {
    // A TABLE NAME IS PART OF A URL PATH. `../rpc/...` would aim the insert at
    // a different endpoint on the same host, so anything that is not a
    // Postgres identifier falls back to the default instead of being sent.
    expect(beaconTable(base({ TOKEN_OPTIMIZER_BEACON_TABLE: '../rpc/exec' }))).toBe(
      TABLE_DEFAULT
    );
    expect(beaconTable(base({ TOKEN_OPTIMIZER_BEACON_TABLE: 'staging_events' }))).toBe(
      'staging_events'
    );
  });
});
