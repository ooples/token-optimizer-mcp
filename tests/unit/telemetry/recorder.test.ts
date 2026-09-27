/**
 * Like policy.test.ts, these are mostly about what the recorder REFUSES.
 *
 * The one it tests positively is the case that did not exist before: that an
 * opt-in produces a file with the event in it. That was the whole gap -- the
 * switch was readable and nothing read it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  record,
  recordedBytes,
  recorderLastError,
  telemetryDir,
  eventsFile,
  rotatedFile,
  MAX_BYTES,
  libraryVersion,
} from '../../../src/telemetry/recorder.js';

const OPTED_IN = { TOKEN_OPTIMIZER_TELEMETRY: '1' } as NodeJS.ProcessEnv;

/**
 * Each test gets its own disposable home, handed to the recorder in the same env
 * object the opt-in is read from.
 *
 * NOT VIA process.env AND jest.resetModules(). The first version of these tests
 * did exactly that and two of them passed against the previous test's leftovers:
 * under --experimental-vm-modules, resetModules does not evict a module loaded
 * by dynamic import, so the recorder kept the paths it resolved on first import
 * and wrote to a directory afterEach had already deleted. The recorder now
 * resolves its paths per call, which is what makes this possible at all.
 */
let home: string;
const optedIn = (): NodeJS.ProcessEnv =>
  ({ ...OPTED_IN, USERPROFILE: home, HOME: home }) as NodeJS.ProcessEnv;
const optedOut = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ USERPROFILE: home, HOME: home, ...extra }) as NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'telemetry-recorder-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('an opt-in is what makes anything happen', () => {
  it('writes nothing at all on a machine with no configuration', () => {
    expect(record('tool_call', '1.0.0', { ms: 12 }, optedOut())).toBeNull();
    expect(existsSync(eventsFile(optedOut()))).toBe(false);
  });

  it('writes nothing when DO_NOT_TRACK is set even alongside an opt-in', () => {
    const env = { ...optedIn(), DO_NOT_TRACK: '1' } as NodeJS.ProcessEnv;
    expect(record('tool_call', '1.0.0', { ms: 12 }, env)).toBeNull();
    expect(existsSync(eventsFile(env))).toBe(false);
  });

  it('records one json line per event once opted in', () => {
    const env = optedIn();
    expect(record('tool_call', '1.2.3', { ms: 12 }, env)).not.toBeNull();
    expect(record('tool_call', '1.2.3', { ms: 30 }, env)).not.toBeNull();
    const lines = readFileSync(eventsFile(env), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.event_type).toBe('tool_call');
    expect(first.library_version).toBe('1.2.3');
    expect(first.properties).toEqual({ ms: 12 });
  });

  it('writes under the home it is given, never the real one', () => {
    // The guarantee the previous version of this file could not make, and the
    // reason two of its cases passed against stale state.
    const env = optedIn();
    record('tool_call', '1.0.0', {}, env);
    expect(eventsFile(env).startsWith(home)).toBe(true);
    expect(existsSync(eventsFile(env))).toBe(true);
  });
});

describe('what is on disk cannot carry content', () => {
  it('drops a string property before it reaches the file', () => {
    // THE CASE THAT MATTERS. A caller passing a path or a prompt is the leak
    // this module is shaped around, and it must fail closed at the file rather
    // than only in a type signature an `any` cast would defeat.
    const env = optedIn();
    record('tool_call', '1.0.0', { ms: 4, path: '/home/someone/secret.ts' }, env);
    const written = readFileSync(eventsFile(env), 'utf8');
    expect(written).not.toContain('secret');
    expect(JSON.parse(written.trim()).properties).toEqual({ ms: 4 });
  });

  it('does not record the hostname anywhere in the line', () => {
    const env = optedIn();
    record('tool_call', '1.0.0', {}, env);
    expect(readFileSync(eventsFile(env), 'utf8')).not.toContain(hostname());
  });
});

describe('a failure to record is not a failure of the caller', () => {
  it('returns null and remembers why when the file cannot be written', () => {
    const env = optedIn();
    // A DIRECTORY WHERE THE FILE GOES. Portable in a way a chmod is not:
    // appending to a directory fails everywhere, and the point is that the
    // caller still gets null rather than an exception.
    mkdirSync(eventsFile(env), { recursive: true });
    expect(() => record('tool_call', '1.0.0', {}, env)).not.toThrow();
    expect(record('tool_call', '1.0.0', {}, env)).toBeNull();
    expect(recorderLastError()).not.toBeNull();
  });

  it('reports nothing on disk before anything has been recorded', () => {
    expect(recordedBytes(optedIn())).toBeNull();
  });
});

describe('the file is bounded', () => {
  it('rotates rather than growing past the ceiling', () => {
    const env = optedIn();
    mkdirSync(telemetryDir(env), { recursive: true });
    writeFileSync(eventsFile(env), 'x'.repeat(MAX_BYTES), 'utf8');
    record('tool_call', '1.0.0', { ms: 1 }, env);
    // The ceiling-sized file moved aside, and the live file holds only the new
    // event -- a fixed two-file cost rather than unbounded growth.
    expect(existsSync(rotatedFile(env))).toBe(true);
    expect(readFileSync(eventsFile(env), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the version an event is stamped with', () => {
  it('is our real one, not the fallback', () => {
    // THE ASSERTION THAT MATTERS. 'unknown' is a legal answer the code returns
    // rather than throwing, which means a broken resolution degrades silently and
    // every event still looks well formed. Only comparing against the manifest
    // catches that, so this reads package.json by a different route than the code
    // under test does.
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    ) as { version: string };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(libraryVersion()).toBe(manifest.version);
  });
});
