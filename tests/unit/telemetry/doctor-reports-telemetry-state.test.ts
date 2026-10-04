/**
 * The doctor says what the telemetry switches are doing.
 *
 * `describePolicy`, `recordedBytes` and `recorderLastError` were all written and
 * then had NO consumer anywhere in src/ -- so a user who wanted to know whether
 * this tool was sending anything had nothing to read but the source. That is the
 * same defect doctor-reports-harvest-state.test.ts was written for, pointed at
 * the other opt-in: the state existed, nothing surfaced it.
 *
 * It must also never send while answering the question. Someone running the
 * doctor to check whether we upload is the last person to upload for.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { telemetrySection } from '../../../src/server/doctor-tool.js';
import { eventsFile, telemetryDir } from '../../../src/telemetry/recorder.js';
import { TABLE_DEFAULT, URL_DEFAULT } from '../../../src/telemetry/credentials.js';

let home: string;
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ USERPROFILE: home, HOME: home, ...extra }) as NodeJS.ProcessEnv;

const seedOne = (e: NodeJS.ProcessEnv): void => {
  mkdirSync(telemetryDir(e), { recursive: true });
  writeFileSync(
    eventsFile(e),
    JSON.stringify({
      event_type: 'proxy_request',
      machine_id_hash: 'c'.repeat(32),
      library_version: '7.1.0',
      timestamp_utc: '2026-09-27T00:00:00.000Z',
      properties: { saved: 3 },
    }) + '\n',
    'utf8'
  );
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'doctor-telemetry-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the doctor telemetry section', () => {
  it('says the local switch is opt-in and unset when nothing is set', async () => {
    const lines = await telemetrySection(env());
    expect(lines.join('\n')).toContain('policy: off: local telemetry is opt-in and unset');
    expect(lines.join('\n')).toContain('local log: not written yet');
  });

  it('reports the pending count once events exist', async () => {
    const e = env({ TOKEN_OPTIMIZER_TELEMETRY: '1' });
    seedOne(e);
    const text = (await telemetrySection(e)).join('\n');
    expect(text).toContain('1 event(s) pending');
    expect(text).toMatch(/local log: \d+ bytes/);
  });

  it('names the endpoint only when a key was packed', async () => {
    const withKey = env({
      TOKEN_OPTIMIZER_TELEMETRY: '1',
      TOKEN_OPTIMIZER_BEACON: '1',
      TOKEN_OPTIMIZER_BEACON_KEY: 'test-anon-key',
    });
    const named = (await telemetrySection(withKey)).join('\n');
    expect(named).toContain(URL_DEFAULT + '/rest/v1/' + TABLE_DEFAULT);
    expect(named).toContain('local and upload: both explicitly enabled');
    // AND THE KEY ITSELF IS NOT IN THE OUTPUT. The doctor's text gets pasted
    // into issues.
    expect(named).not.toContain('test-anon-key');

    const unkeyed = env({ TOKEN_OPTIMIZER_TELEMETRY: '1', TOKEN_OPTIMIZER_BEACON: '1' });
    const text = (await telemetrySection(unkeyed)).join('\n');
    // OPTED IN AND STILL UNABLE TO SEND: a build packed without a key never
    // sends a byte, and saying only "both explicitly enabled" would leave an
    // operator believing it does.
    expect(text).toContain('packed without a key');
  });

  it('sends nothing while it reports', async () => {
    const e = env({
      TOKEN_OPTIMIZER_TELEMETRY: '1',
      TOKEN_OPTIMIZER_BEACON: '1',
      TOKEN_OPTIMIZER_BEACON_KEY: 'test-anon-key',
    });
    seedOne(e);
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return { ok: true, status: 201 } as Response;
    }) as unknown as typeof fetch;
    try {
      await telemetrySection(e);
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(0);
    // THE EVENTS ARE STILL PENDING, which is the other half of "nothing was
    // sent": a flush that failed would also leave `called` at 0.
    expect((await telemetrySection(e)).join('\n')).toContain('1 event(s) pending');
  });
});
