/**
 * The hook ledger is only worth transmitting if it can never carry a path.
 *
 * Two of these tests matter more than the rest: the one that feeds a report
 * holding real absolute paths and asserts that every transmitted value is a
 * number or a boolean, and the one that asserts nothing is read at all when the
 * user has not opted in. The rest guard the throttle and the "absent means not
 * yet known" encoding.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SNAPSHOT_EVERY_MS,
  snapshotStampFile,
  lastSnapshotAt,
  dueForSnapshot,
  stampSnapshot,
  snapshotProperties,
  flushHookSnapshot,
} from '../../../src/telemetry/hook-rollup.js';
import { eventsFile } from '../../../src/telemetry/recorder.js';

/** A home nothing else shares, so no test can write to the real one. */
let home = '';

/** Opted in locally, never to upload -- the snapshot is recorded, not sent. */
const optedIn = (): NodeJS.ProcessEnv => ({
  HOME: home,
  USERPROFILE: home,
  TOKEN_OPTIMIZER_TELEMETRY: '1',
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'to-hook-rollup-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A report shaped like the real one, with the parts we never send left in. */
const fullReport = (over: Record<string, unknown> = {}) => ({
  nativeOptimizer: {
    substitutions: 12,
    holdouts: 3,
    tokensReturned: 400,
    tokensSaved: 9100,
    // Both of these hold real file paths in production and must never be sent.
    byClient: { 'claude-code': 12 },
    recent: [{ name: 'live_graph_substitution', client: 'claude-code', tokensSaved: 700 }],
    source: 'balance.jsonl: modeled full-file counterfactual',
  },
  memoryDeliveries: 30,
  memoryHoldouts: 7,
  deliveryTokens: 2100,
  injections: 24,
  sessionStartInjections: 4,
  sessionStartInjectedTokens: 800,
  commandInjections: 2,
  commandHoldouts: 1,
  holdouts: 6,
  staleServed: 3,
  staleRate: 0.125,
  injectedTokens: 2900,
  harvestTokens: 640,
  estimatedTokensAvoided: 15_000,
  netTokens: 11_460,
  sufficientData: true,
  verdict: 'the graph is saving more than it costs',
  measurement: {
    schemaVersion: 1,
    freshness: { lastEventAt: 1_700_000_000_000, ageMs: 86_400_000, status: 'fresh' },
    metrics: {
      readingAvoided: {
        status: 'measured',
        source: 'stratified file-touch holdout joined to downstream read events',
        samples: 31,
        treated: 24,
        holdouts: 6,
      },
    },
  },
  ...over,
});

describe('the counts taken from a hook ledger', () => {
  it('sends only numbers and booleans, never a name or a path', () => {
    const props = snapshotProperties(fullReport());
    expect(props).not.toBeNull();
    for (const [key, value] of Object.entries(props ?? {})) {
      expect(['number', 'boolean']).toContain(typeof value);
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('drops the fields that name a client, a file or a judgement', () => {
    const props = snapshotProperties(fullReport()) ?? {};
    // Pinned positively first: this report DID reduce to counts, so the absences
    // below are absences from a real reduction and not from an empty object.
    expect(props.substitutions).toBe(12);
    expect(props.deliveries).toBe(30);
    const serialised = JSON.stringify(props);
    expect(serialised).not.toContain('claude-code');
    expect(serialised).not.toContain('balance.jsonl');
    expect(serialised).not.toContain('saving more than it costs');
    expect(Object.keys(props)).not.toContain('byClient');
    expect(Object.keys(props)).not.toContain('recent');
    expect(Object.keys(props)).not.toContain('verdict');
    expect(Object.keys(props)).not.toContain('source');
  });

  it('carries both numbers the feature exists to learn', () => {
    const props = snapshotProperties(fullReport()) ?? {};
    // How often the graph answered instead of a tool...
    expect(props.substitutions).toBe(12);
    expect(props.tokens_saved).toBe(9100);
    // ...and the holdout arm's outcome.
    expect(props.file_touch_treated).toBe(24);
    expect(props.file_touch_holdouts).toBe(6);
    expect(props.tokens_avoided).toBe(15_000);
    expect(props.net_tokens).toBe(11_460);
    expect(props.sufficient_data).toBe(true);
  });

  it('omits the outcome rather than sending a zero when the arms are too small', () => {
    const props =
      snapshotProperties(
        fullReport({ estimatedTokensAvoided: null, netTokens: null, sufficientData: false })
      ) ?? {};
    // A zero saving and an unmeasured saving are the opposite finding, so the
    // absence has to survive the wire.
    expect(props).not.toHaveProperty('tokens_avoided');
    expect(props).not.toHaveProperty('net_tokens');
    expect(props.sufficient_data).toBe(false);
    // The counts that ARE known still go.
    expect(props.substitutions).toBe(12);
  });

  it('refuses a project that never used the graph', () => {
    expect(
      snapshotProperties(
        fullReport({
          nativeOptimizer: { substitutions: 0 },
          memoryDeliveries: 0,
          memoryHoldouts: 0,
        })
      )
    ).toBeNull();
  });

  it('refuses a report it cannot read at all', () => {
    expect(snapshotProperties(null)).toBeNull();
    expect(snapshotProperties('not a report')).toBeNull();
    expect(snapshotProperties({})).toBeNull();
  });
});

describe('the once-per-window throttle', () => {
  it('is due when no snapshot was ever taken', () => {
    expect(lastSnapshotAt(optedIn())).toBeNull();
    expect(dueForSnapshot(Date.now(), optedIn())).toBe(true);
  });

  it('is not due again immediately, and is due after the window', () => {
    const env = optedIn();
    const at = 1_700_000_000_000;
    stampSnapshot(at, env);
    expect(lastSnapshotAt(env)).toBe(at);
    expect(dueForSnapshot(at + 1000, env)).toBe(false);
    expect(dueForSnapshot(at + SNAPSHOT_EVERY_MS - 1, env)).toBe(false);
    expect(dueForSnapshot(at + SNAPSHOT_EVERY_MS, env)).toBe(true);
  });

  it('is due when the clock moved backwards, instead of going silent', () => {
    const env = optedIn();
    stampSnapshot(1_700_000_000_000, env);
    expect(dueForSnapshot(1_600_000_000_000, env)).toBe(true);
  });

  it('is due when the stamp is corrupt, rather than never reporting', () => {
    const env = optedIn();
    stampSnapshot(1_700_000_000_000, env);
    writeFileSync(snapshotStampFile(env), 'not json at all', 'utf8');
    expect(lastSnapshotAt(env)).toBeNull();
    expect(dueForSnapshot(Date.now(), env)).toBe(true);
  });
});

/** A project whose ledger the hooks really wrote, in the format they write. */
function projectWithLedger(events: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'to-hook-project-'));
  const wiki = join(root, '.token-optimizer', 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(
    join(wiki, 'balance.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8'
  );
  return root;
}

describe('reading a real ledger at boot', () => {
  let project = '';

  afterEach(() => {
    if (project) rmSync(project, { recursive: true, force: true });
    project = '';
  });

  it('records one event from the ledger the hooks wrote', async () => {
    project = projectWithLedger([
      { kind: 'inject', at: Date.now(), anchor: 'src/secret/private.ts', tokens: 120 },
      { kind: 'inject', at: Date.now(), anchor: 'src/secret/other.ts', tokens: 90, holdout: true },
    ]);
    const env = optedIn();
    const result = await flushHookSnapshot(env, project, Date.now());
    expect(result.refused).toBeNull();
    expect(result.recorded).toBe(true);

    const lines = readFileSync(eventsFile(env), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event: Record<string, unknown> = JSON.parse(lines[0] ?? '{}');
    expect(event.event_type).toBe('hook_graph_snapshot');
    // THE PATHS IN THAT LEDGER ARE NOT IN THE EVENT. This is the assertion the
    // whole module exists to satisfy.
    expect(JSON.stringify(event)).not.toContain('private.ts');
    expect(JSON.stringify(event)).not.toContain(project);
    const properties = event.properties as Record<string, unknown>;
    for (const value of Object.values(properties)) {
      expect(['number', 'boolean']).toContain(typeof value);
    }
  });

  it('leaves behind the strings that the report it read really did carry', async () => {
    // A NEGATIVE ASSERTION NEEDS A POSITIVE CONTROL. "the event contains no
    // client name" is worth nothing unless the reduction it came from contained
    // one -- otherwise the test passes on a ledger the reader never parsed.
    const distinctive = 'client-name-that-must-not-travel';
    project = projectWithLedger([
      {
        kind: 'substitute',
        at: Date.now(),
        anchor: 'src/secret/private.ts',
        client: distinctive,
        tokens: 40,
        bytesAvoided: 8000,
      },
    ]);
    const metrics = await import(
      pathToFileURL(join(process.cwd(), 'hooks-core', 'metrics.mjs')).href
    );
    const report = metrics.report(join(project, '.token-optimizer', 'wiki'));
    // The control: the reduction DID carry the client name through, twice.
    expect(JSON.stringify(report)).toContain(distinctive);
    expect(report.nativeOptimizer.substitutions).toBe(1);

    const env = optedIn();
    expect((await flushHookSnapshot(env, project, Date.now())).recorded).toBe(true);
    const recorded = readFileSync(eventsFile(env), 'utf8');
    expect(recorded).not.toContain(distinctive);
    expect(recorded).not.toContain('private.ts');
    // The count it stood for still arrives.
    expect(JSON.parse(recorded.trim()).properties.substitutions).toBe(1);
  });
  it('reads nothing and records nothing when the user has not opted in', async () => {
    project = projectWithLedger([
      { kind: 'inject', at: Date.now(), anchor: 'src/secret/private.ts', tokens: 120 },
    ]);
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
    const result = await flushHookSnapshot(env, project, Date.now());
    expect(result.recorded).toBe(false);
    expect(result.refused).toBe('local telemetry is not enabled');
    // Not even a throttle stamp: an opted-out machine leaves no telemetry trace.
    expect(existsSync(snapshotStampFile(env))).toBe(false);
    expect(existsSync(eventsFile(env))).toBe(false);
  });

  it('honours DO_NOT_TRACK over an explicit opt-in', async () => {
    project = projectWithLedger([{ kind: 'inject', at: Date.now(), anchor: 'a.ts', tokens: 1 }]);
    const result = await flushHookSnapshot(
      { ...optedIn(), DO_NOT_TRACK: '1' },
      project,
      Date.now()
    );
    expect(result.recorded).toBe(false);
    expect(result.refused).toBe('local telemetry is not enabled');
  });

  it('does not take a second snapshot inside the window', async () => {
    project = projectWithLedger([{ kind: 'inject', at: Date.now(), anchor: 'a.ts', tokens: 1 }]);
    const env = optedIn();
    const at = Date.now();
    expect((await flushHookSnapshot(env, project, at)).recorded).toBe(true);
    const second = await flushHookSnapshot(env, project, at + 60_000);
    expect(second.recorded).toBe(false);
    expect(second.refused).toBe('a snapshot was taken recently');
    expect(readFileSync(eventsFile(env), 'utf8').trim().split('\n')).toHaveLength(1);
    // And due again once the window has passed.
    expect((await flushHookSnapshot(env, project, at + SNAPSHOT_EVERY_MS)).recorded).toBe(true);
  });

  it('stamps but records nothing for a project that never used the graph', async () => {
    project = mkdtempSync(join(tmpdir(), 'to-hook-empty-'));
    const env = optedIn();
    const at = Date.now();
    const result = await flushHookSnapshot(env, project, at);
    expect(result.recorded).toBe(false);
    expect(result.refused).toBe('the graph was not used in this project');
    // Stamped, so the next boot does not re-reduce the same empty log.
    expect(lastSnapshotAt(env)).toBe(at);
    expect(existsSync(eventsFile(env))).toBe(false);
  });
});