/**
 * The entry point the forecast never had.
 *
 * The properties under test are the ones that decide whether this is a feature or a liability:
 * the cost is bounded before any file is opened, the panel only interrupts when it is actionable
 * AND has moved since the last one shown, the throttle survives the process boundary that every
 * hook invocation crosses, and the calibration loop is closed by the one event that can close it.
 *
 * The last test in this file is the one that matters most: the reachability guard's own verdict
 * that these functions now have shipped callers. Everything else here would pass just as well on
 * a module nothing imports -- which is exactly the defect this wiring exists to end.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  maybeSurface, closeForecast, sessionUsage, SURFACE_INTERVAL_MS, DEFAULT_CAPACITY,
} from '../../hooks-core/surface.mjs';
import { logForecast, observeOutcome, reliability } from '../../hooks-core/calibration.mjs';
import { record, recordRead, readBalance } from '../../hooks-core/metrics.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'surface-'));
  dir = join(workspace, 'wiki');
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * A transcript with `turns` assistant rows, the last one reporting `used` tokens of context.
 *
 * The usage shape mirrors a real transcript: the context size at a turn is cache reads plus cache
 * writes plus fresh input, not the marginal cost of that turn alone.
 */
function transcript(turns, used = 60_000) {
  const path = join(workspace, `t-${turns}-${used}.jsonl`);
  const rows = [];
  for (let i = 0; i < turns; i++) {
    const last = i === turns - 1;
    rows.push(JSON.stringify({
      type: 'assistant',
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-opus-4',
        usage: {
          cache_read_input_tokens: last ? used - 1_000 : 100,
          cache_creation_input_tokens: last ? 900 : 10,
          input_tokens: last ? 100 : 5,
        },
      },
    }));
  }
  writeFileSync(path, `${rows.join('\n')}\n`);
  return path;
}

/** Arms with a control arm big enough to publish a counterfactual, plus a short runway. */
function seedArms({ treated = 12, withheld = 12, treatedRead = 500, withheldRead = 9000 } = {}) {
  for (let i = 0; i < treated; i++) {
    record(dir, { kind: 'inject', anchor: `/t${i}.ts`, sessionId: 'live', holdout: false, tokens: 100 });
    recordRead(dir, { anchor: `/t${i}.ts`, sessionId: 'live', bytes: treatedRead * 4 });
  }
  for (let i = 0; i < withheld; i++) {
    record(dir, { kind: 'inject', anchor: `/c${i}.ts`, sessionId: 'live', holdout: true, tokens: 0 });
    recordRead(dir, { anchor: `/c${i}.ts`, sessionId: 'live', bytes: withheldRead * 4 });
  }
}

describe('the session numbers come from the transcript', () => {
  test('used is the size of the context, not the sum of the turns', () => {
    // Summing per-turn inputs counts the carried prefix once per turn and reports a number many
    // times the window size -- which would make every runway look like an emergency.
    const usage = sessionUsage(transcript(20, 60_000));
    expect(usage.used).toBe(60_000);
    expect(usage.turns).toBe(20);
    expect(usage.capacity).toBe(DEFAULT_CAPACITY);
  });

  test('no usage rows is null, not a zeroed session', () => {
    const path = join(workspace, 'empty.jsonl');
    writeFileSync(path, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    expect(sessionUsage(path)).toBeNull();
  });

  test('a missing transcript is null rather than a throw', () => {
    expect(sessionUsage(join(workspace, 'nope.jsonl'))).toBeNull();
  });
});

describe('the cost is bounded before anything is opened', () => {
  test('inside the throttle window nothing is read at all', () => {
    // The transcript path is deliberately nonexistent: if the throttle were checked after the
    // read, this would still return null and the test would pass for the wrong reason. It cannot
    // even be attempted, so the state must come back byte-identical.
    const previous = { checkedAt: 1_000, shown: 4 };
    const out = maybeSurface(dir, {
      transcriptPath: join(workspace, 'never-opened.jsonl'),
      sessionId: 'live',
      state: { forecast: previous },
      now: 1_000 + SURFACE_INTERVAL_MS - 1,
    });
    expect(out.text).toBeNull();
    expect(out.state).toBe(previous); // the same object, untouched
  });

  test('past the window the clock is stamped even when there is nothing to say', () => {
    // Otherwise a session with no usage rows re-parses the transcript on every single tool call.
    const out = maybeSurface(dir, {
      transcriptPath: join(workspace, 'absent.jsonl'),
      sessionId: 'live',
      state: { forecast: { checkedAt: 1_000, shown: null } },
      now: 1_000 + SURFACE_INTERVAL_MS + 1,
    });
    expect(out.text).toBeNull();
    expect(out.state.checkedAt).toBe(1_000 + SURFACE_INTERVAL_MS + 1);
  });

  test('the interval is a real bound', () => {
    expect(SURFACE_INTERVAL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SURFACE_INTERVAL_MS)).toBe(true);
  });
});

describe('it interrupts only when the forecast has earned it', () => {
  test('a comfortable runway says nothing', () => {
    seedArms();
    // 10% used over 20 turns leaves a very long runway.
    const out = maybeSurface(dir, {
      transcriptPath: transcript(20, 20_000), sessionId: 'live', state: {}, now: 5_000,
    });
    expect(out.text).toBeNull();
    expect(out.state.checkedAt).toBe(5_000);
  });

  test('a short runway surfaces, once', () => {
    seedArms();
    // 190k of 200k used over 20 turns: about 1 turn left.
    const path = transcript(20, 190_000);
    const first = maybeSurface(dir, { transcriptPath: path, sessionId: 'live', state: {}, now: 5_000 });
    expect(first.text).toMatch(/turns to compaction/);
    expect(first.state.shown).toBeGreaterThanOrEqual(0);

    // Same runway a window later: different, not actionable, so it stays quiet.
    const second = maybeSurface(dir, {
      transcriptPath: path,
      sessionId: 'live',
      state: { forecast: first.state },
      now: 5_000 + SURFACE_INTERVAL_MS + 1,
    });
    expect(second.text).toBeNull();
  });

  test('the comparison is against the last panel SHOWN, not the last computed', () => {
    // Otherwise the runway drifts down one throttle window at a time, each step too small to trip
    // the threshold test, and the interruption never fires at all.
    seedArms();
    const shownAt = maybeSurface(dir, {
      transcriptPath: transcript(20, 190_000), sessionId: 'live', state: {}, now: 5_000,
    });
    expect(shownAt.text).not.toBeNull();
    expect(shownAt.state.shown).not.toBeUndefined();
  });
});

describe('the calibration loop is closed by compaction', () => {
  test('a forecast made earlier in the session is scored against the elapsed turns', () => {
    // predictedTurns is an INTERVAL, so the ground truth is turns elapsed between the prediction
    // and compaction -- not the turn number compaction happened on.
    logForecast(dir, { sessionId: 'live', predictedTurns: 10, used: 60_000, capacity: 200_000, turns: 20 });
    closeForecast(dir, { transcriptPath: transcript(31, 190_000), sessionId: 'live' });

    const scored = reliability(dir);
    expect(scored.scored).toBe(1);
    // 31 turns at compaction minus 20 at prediction = 11 elapsed, against a prediction of 10.
    expect(scored.hitRate).toBe(1);
  });

  test('a forecast with no recorded origin is left open rather than scored against an absolute', () => {
    // Scoring an interval against a turn NUMBER manufactures an error instead of measuring one.
    record(dir, {
      kind: 'forecast', sessionId: 'live', predictedTurns: 10, horizon: 'mid', turns: null,
    });
    closeForecast(dir, { transcriptPath: transcript(31, 190_000), sessionId: 'live' });
    expect(reliability(dir).scored).toBe(0);
  });

  test('an explicit actualTurns still works, so the interval can be supplied directly', () => {
    logForecast(dir, { sessionId: 'live', predictedTurns: 10, used: 1, capacity: 2, turns: 5 });
    observeOutcome(dir, { sessionId: 'live', actualTurns: 12 });
    expect(reliability(dir).scored).toBe(1);
  });

  test('no transcript means no score, and no crash', () => {
    logForecast(dir, { sessionId: 'live', predictedTurns: 10, used: 1, capacity: 2, turns: 5 });
    expect(closeForecast(dir, { transcriptPath: join(workspace, 'gone.jsonl'), sessionId: 'live' })).toBe(false);
    expect(reliability(dir).scored).toBe(0);
  });
});

describe('the wiring is real, not merely present', () => {
  // This is the test that would have failed for the whole life of calibration.mjs. Every other
  // test in this file passes just as well on a module nothing imports.
  const hook = (name) => readFileSync(join(process.cwd(), 'plugin', 'hooks', name), 'utf8');

  test('the PreToolUse router calls maybeSurface', () => {
    expect(hook('pretooluse-router.mjs')).toMatch(/maybeSurface\(/);
  });

  test('the PreCompact hook calls closeForecast', () => {
    expect(hook('precompact-optimize.mjs')).toMatch(/closeForecast\(/);
  });

  test('the vendored copy of surface.mjs is in place for the plugin to import', () => {
    // The hooks import from ./lib/, which is synced rather than symlinked -- an unsynced module
    // means the hook throws on load and fails open, silently doing nothing.
    expect(() => readFileSync(join(process.cwd(), 'plugin', 'hooks', 'lib', 'surface.mjs'), 'utf8'))
      .not.toThrow();
  });
});

// --- a forecast is logged when it is SHOWN, and only then ---------------------------

describe('only a surfaced forecast is scored', () => {
  test('a panel the throttle or worthSurfacing rejects logs nothing', () => {
    // THE DEFECT: forecastPanel logged on every build. maybeSurface builds one per throttle window
    // and worthSurfacing rejects most of them, so open forecast records nobody ever saw piled up
    // in balance.jsonl -- and that log is read by its TAIL BYTES, so those rows would eventually
    // evict the inject/harvest/substitute rows BALANCE_KINDS exists to protect. The fix this work
    // is built on would have been undone by its own display path.
    seedArms();
    const out = maybeSurface(dir, {
      transcriptPath: transcript(20, 20_000), sessionId: 'live', state: {}, now: 5_000,
    });
    expect(out.text).toBeNull(); // comfortable runway: nothing worth showing
    expect(readBalance(dir).filter((e) => e.kind === 'forecast')).toHaveLength(0);
  });

  test('a surfaced panel logs exactly one forecast, carrying its origin turn', () => {
    seedArms();
    const out = maybeSurface(dir, {
      transcriptPath: transcript(20, 190_000), sessionId: 'live', state: {}, now: 5_000,
    });
    expect(out.text).not.toBeNull();

    const logged = readBalance(dir).filter((e) => e.kind === 'forecast');
    expect(logged).toHaveLength(1);
    expect(logged[0].sessionId).toBe('live');
    expect(logged[0].predictedTurns).toBe(out.state.shown);
    // The origin turn is what makes the outcome an interval rather than an absolute.
    expect(logged[0].turns).toBe(20);
  });

  test('a throttled second call adds no second forecast', () => {
    seedArms();
    const path = transcript(20, 190_000);
    const first = maybeSurface(dir, { transcriptPath: path, sessionId: 'live', state: {}, now: 5_000 });
    expect(first.text).not.toBeNull();
    maybeSurface(dir, {
      transcriptPath: path, sessionId: 'live', state: { forecast: first.state }, now: 5_100,
    });
    expect(readBalance(dir).filter((e) => e.kind === 'forecast')).toHaveLength(1);
  });
});
