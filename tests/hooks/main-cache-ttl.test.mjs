/**
 * The main conversation's cache tier (#567): written as "1h" only when this
 * user's own sessions replay cheaper at 1h, never over the user, once ever.
 */
import { describe, expect, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMainTtl,
  describeMainTtl,
  mainTtlCheckedPath,
  mainTtlDecision,
  mainTtlOwner,
  undoMainTtl,
} from '../../src/hooks-core/main-cache-ttl.mjs';

const MIN = 60_000;

/** A session of `turns` requests of a growing 50k+ prompt, `gapMin` minutes apart. */
function session(turns, gapMin) {
  const requests = [];
  for (let i = 0; i < turns; i++) requests.push({ at: i * gapMin * MIN, cached: 50_000 + i * 2_000, read: 0, input: 10 });
  return { requests };
}
const paused = () => Array.from({ length: 6 }, () => session(20, 8)); // every gap past 5m
const brisk = () => Array.from({ length: 6 }, () => session(20, 0.5)); // never pauses

function sandbox(settings) {
  const root = mkdtempSync(join(tmpdir(), 'main-ttl-'));
  const settingsPath = join(root, 'claude', 'settings.json');
  mkdirSync(join(root, 'claude'), { recursive: true });
  if (settings !== undefined) writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { root, settingsPath, env: { TOKEN_OPTIMIZER_HOME: join(root, 'home') } };
}

describe('mainTtlDecision', () => {
  test('sessions that pause past 5m favour 1h', () => {
    const d = mainTtlDecision(paused());
    expect(d.recommend).toBe('1h');
    expect(d.at1h).toBeLessThan(d.at5m);
    expect(d.sessions).toBe(6);
  });

  test('sessions that never pause do not: a 1h write costs 2x against 1.25x', () => {
    const d = mainTtlDecision(brisk());
    expect(d.recommend).toBeNull();
    expect(d.at1h).toBeGreaterThan(d.at5m);
  });

  test('a saving that is large but a sliver of the cost does not flip it', () => {
    // Uncached input dwarfs the cache: the same pauses save the same tokens,
    // now well under 5% of what the sessions cost.
    const heavy = paused().map((s) => ({ requests: s.requests.map((r) => ({ ...r, input: 2_000_000 })) }));
    const d = mainTtlDecision(heavy);
    expect(d.saving).toBeGreaterThanOrEqual(200_000);
    expect(d.share).toBeLessThan(0.05);
    expect(d.recommend).toBeNull();
  });

  test('too few sessions, or single-request ones, never flip it', () => {
    expect(mainTtlDecision(paused().slice(0, 4)).recommend).toBeNull();
    expect(mainTtlDecision([...Array.from({ length: 6 }, () => session(1, 8))]).sessions).toBe(0);
    expect(mainTtlDecision([null, undefined, {}]).recommend).toBeNull();
  });
});

describe('applyMainTtl', () => {
  test('writes 1h with a byte-exact backup and a record, once', () => {
    const s = sandbox({ theme: 'dark' });
    const before = readFileSync(s.settingsPath, 'utf8');
    const r = applyMainTtl(s.settingsPath, { env: s.env, tallies: paused(), now: 1_000 });
    expect(r.written).toBe(true);
    expect(JSON.parse(readFileSync(s.settingsPath, 'utf8'))).toEqual({ theme: 'dark', promptCacheTtl: '1h' });
    expect(readFileSync(r.backup, 'utf8')).toBe(before);
    // Removed by hand = declined: never written back, even a day later.
    writeFileSync(s.settingsPath, JSON.stringify({ theme: 'dark' }));
    const again = applyMainTtl(s.settingsPath, { env: s.env, tallies: paused(), now: 1_000 + 2 * 86_400_000 });
    expect(again.written).toBe(false);
    expect(again.reason).toMatch(/declining/);
  });

  test('never over the user: a settings value or the environment variable', () => {
    const own = sandbox({ promptCacheTtl: '5m' });
    expect(applyMainTtl(own.settingsPath, { env: own.env, tallies: paused() }).reason).toBe('already set in settings');
    expect(JSON.parse(readFileSync(own.settingsPath, 'utf8')).promptCacheTtl).toBe('5m');
    const envd = sandbox({});
    const env = { ...envd.env, CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' };
    expect(applyMainTtl(envd.settingsPath, { env, tallies: paused() }).reason).toBe('already set in environment');
    expect(mainTtlOwner({}, {})).toBeNull();
  });

  test('writes nothing when the evidence does not favour 1h, and measures at most once a day', () => {
    const s = sandbox({});
    const r = applyMainTtl(s.settingsPath, { env: s.env, tallies: brisk(), now: Date.now() });
    expect(r.written).toBe(false);
    expect(r.reason).toBe('evidence does not favour 1h');
    expect(existsSync(mainTtlCheckedPath(s.env))).toBe(true);
    expect(applyMainTtl(s.settingsPath, { env: s.env, tallies: paused(), now: Date.now() }).reason).toBe('measured within the day');
    // A day on, it measures again.
    const old = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(mainTtlCheckedPath(s.env), old, old);
    expect(applyMainTtl(s.settingsPath, { env: s.env, tallies: paused(), now: Date.now() }).written).toBe(true);
  });

  test('opted out, unparseable or non-object settings: untouched', () => {
    const s = sandbox({});
    const off = { ...s.env, TOKEN_OPTIMIZER_MAIN_CACHE_TTL: 'off' };
    expect(applyMainTtl(s.settingsPath, { env: off, tallies: paused() }).reason).toBe('opted out');
    const bad = sandbox('{ not json');
    expect(applyMainTtl(bad.settingsPath, { env: bad.env, tallies: paused() }).reason).toMatch(/not parseable/);
    expect(readFileSync(bad.settingsPath, 'utf8')).toBe('{ not json');
    const arr = sandbox([1]);
    expect(applyMainTtl(arr.settingsPath, { env: arr.env, tallies: paused() }).reason).toBe('settings not an object');
  });

  test('a missing settings file is created, with no backup', () => {
    const s = sandbox(undefined);
    const r = applyMainTtl(s.settingsPath, { env: s.env, tallies: paused() });
    expect(r.written).toBe(true);
    expect(r.backup).toBeNull();
    expect(JSON.parse(readFileSync(s.settingsPath, 'utf8'))).toEqual({ promptCacheTtl: '1h' });
  });
});

describe('undoMainTtl and describeMainTtl', () => {
  test('undo removes our value, and leaves one the user changed', () => {
    const s = sandbox({ theme: 'dark' });
    applyMainTtl(s.settingsPath, { env: s.env, tallies: paused() });
    expect(describeMainTtl(s.settingsPath, s.env)).toMatch(/written by token-optimizer/);
    expect(undoMainTtl({ env: s.env }).undone).toBe(true);
    expect(JSON.parse(readFileSync(s.settingsPath, 'utf8'))).toEqual({ theme: 'dark' });
    expect(describeMainTtl(s.settingsPath, s.env)).toMatch(/removed since/);

    const t = sandbox({});
    applyMainTtl(t.settingsPath, { env: t.env, tallies: paused() });
    writeFileSync(t.settingsPath, JSON.stringify({ promptCacheTtl: '5m' }));
    expect(undoMainTtl({ env: t.env }).reason).toMatch(/yours now/);
    expect(describeMainTtl(t.settingsPath, t.env)).toMatch(/yours; never changed/);
    expect(undoMainTtl({ env: sandbox({}).env }).undone).toBe(false);
  });

  test('describe names the automatic tier when nothing is set', () => {
    const s = sandbox({});
    expect(describeMainTtl(s.settingsPath, s.env)).toMatch(/automatic/);
    expect(describeMainTtl(s.settingsPath, { ...s.env, TOKEN_OPTIMIZER_MAIN_CACHE_TTL: 'off' })).toMatch(/=off/);
  });
});

test('the backup sits beside the settings file', () => {
  const s = sandbox({ a: 1 });
  applyMainTtl(s.settingsPath, { env: s.env, tallies: paused(), now: 42 });
  expect(readdirSync(join(s.root, 'claude')).some((n) => n.includes('token-optimizer-main-ttl-42'))).toBe(true);
});
