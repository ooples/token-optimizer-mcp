/**
 * The forecast, and the calibration that makes it a measurement.
 *
 * The properties under test are the ones a letter grade cannot have: the panel
 * degrades per-number rather than all-or-nothing, an unmeasurable saving renders
 * as unknown rather than as none, the forecast keeps its own score, it refuses
 * to publish when uncalibrated, and it interrupts only when it has something
 * actionable to say.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record, recordRead } from '../../hooks-core/metrics.mjs';
import {
  burnRate, runway, shadowAvoided, forecastPanel, worthSurfacing, ACTIONABLE_RUNWAY,
} from '../../hooks-core/forecast.mjs';
import {
  logForecast, observeOutcome, reliability, calibrate,
} from '../../hooks-core/calibration.mjs';
import { readMetrics } from '../../hooks-core/metrics.mjs';

let dir;

beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'forecast-')), 'wiki'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Seeds arms where the control arm reads far more than the treated arm. */
function seedArms({ treated = 10, withheld = 4, treatedRead = 500, withheldRead = 5000 } = {}) {
  for (let i = 0; i < treated; i++) {
    record(dir, { kind: 'inject', anchor: `/t${i}.ts`, sessionId: 's', holdout: false, tokens: 100 });
    recordRead(dir, { anchor: `/t${i}.ts`, sessionId: 's', bytes: treatedRead * 4 });
  }
  for (let i = 0; i < withheld; i++) {
    record(dir, { kind: 'inject', anchor: `/c${i}.ts`, sessionId: 's', holdout: true, tokens: 0 });
    recordRead(dir, { anchor: `/c${i}.ts`, sessionId: 's', bytes: withheldRead * 4 });
  }
}

describe('the causal delta comes from the arms, not a model', () => {
  test('the saving is measured when both arms have data', () => {
    seedArms();
    const rate = burnRate(readMetrics(dir));
    expect(rate.savedPerTouch).toBeGreaterThan(0);
  });

  test('an unmeasurable saving is null, never zero', () => {
    // "Unknown" rendering as "none" would be a silent false negative -- the
    // product reporting that it saved nothing when it simply cannot tell yet.
    seedArms({ withheld: 0 });
    expect(burnRate(readMetrics(dir)).savedPerTouch).toBeNull();
  });

  test('no data at all yields no rate rather than a zero', () => {
    expect(burnRate(readMetrics(dir))).toBeNull();
  });
});

describe('the runway is a deadline, with a counterfactual half', () => {
  test('both halves appear once the control arm has spoken', () => {
    seedArms();
    const air = runway({ used: 60_000, capacity: 200_000, turns: 30 }, burnRate(readMetrics(dir)));
    expect(air.withGraph).toBeGreaterThan(0);
    // The half no tool without a holdout can produce.
    expect(air.withoutGraph).toBeLessThan(air.withGraph);
  });

  test('the counterfactual half is omitted when unmeasurable', () => {
    seedArms({ withheld: 0 });
    const air = runway({ used: 60_000, capacity: 200_000, turns: 30 }, burnRate(readMetrics(dir)));
    expect(air.withGraph).toBeGreaterThan(0);
    expect(air.withoutGraph).toBeNull();
  });
});

describe('the panel degrades per-number, not all-or-nothing', () => {
  test('consolidation appears with no metrics at all', () => {
    // Available from the first finding, so a new install is not blank.
    const panel = forecastPanel(dir, {}, [{ claim: 'a'.repeat(40), derivedCost: 9000 }]);
    expect(panel.text).toContain('consolidation');
  });

  test('the runway says WHY the counterfactual is missing', () => {
    seedArms({ withheld: 0 });
    const panel = forecastPanel(dir, { used: 60_000, capacity: 200_000, turns: 30 }, []);
    expect(panel.text).toMatch(/no counterfactual yet/i);
  });

  test('an empty everything returns nothing rather than an empty shell', () => {
    expect(forecastPanel(dir, {}, [])).toBeNull();
  });
});

describe('modelled and measured check each other', () => {
  test('a large disagreement is stated rather than quietly resolved', () => {
    seedArms();
    // A substitution tally wildly out of line with the measured arm.
    for (let i = 0; i < 5; i++) {
      record(dir, { kind: 'substitute', anchor: `/t${i}.ts`, tokens: 100, bytesAvoided: 4_000_000 });
    }
    const panel = forecastPanel(dir, { used: 60_000, capacity: 200_000, turns: 30 }, []);
    expect(panel.text).toMatch(/disagree/i);
    expect(panel.text).toMatch(/measured figure as authoritative/i);
  });

  test('the shadow tally is null when nothing was substituted', () => {
    expect(shadowAvoided(readMetrics(dir))).toBeNull();
  });
});

describe('it interrupts only when actionable', () => {
  const panelWith = (turns) => ({ parts: { runway: { withGraph: turns } } });

  test('a comfortable runway never surfaces', () => {
    expect(worthSurfacing(panelWith(40), null)).toBe(false);
  });

  test('crossing into the actionable band surfaces once', () => {
    expect(worthSurfacing(panelWith(ACTIONABLE_RUNWAY - 1), panelWith(ACTIONABLE_RUNWAY + 5))).toBe(true);
  });

  test('drifting within the band does not surface again', () => {
    // 19 -> 18 turns is different, not actionable.
    expect(worthSurfacing(panelWith(6), panelWith(7))).toBe(false);
  });

  test('halving inside the band surfaces again', () => {
    expect(worthSurfacing(panelWith(3), panelWith(7))).toBe(true);
  });
});

describe('the forecast keeps its own score', () => {
  function scoreSome(count, errorFn) {
    for (let i = 0; i < count; i++) {
      logForecast(dir, { sessionId: `s${i}`, predictedTurns: 10, used: 1, capacity: 2 });
      observeOutcome(dir, { sessionId: `s${i}`, actualTurns: 10 + errorFn(i) });
    }
  }

  test('accurate forecasts produce a high hit rate', () => {
    scoreSome(10, () => 1);
    expect(reliability(dir).hitRate).toBe(1);
  });

  test('bias is signed, because direction is what is actionable', () => {
    // "Runs 6 turns long" is usable; "62% accurate" is not.
    scoreSome(10, () => 6);
    expect(reliability(dir).buckets.mid.bias).toBeGreaterThan(0);
  });

  test('an uncalibrated horizon refuses to publish a number', () => {
    // The same rule the savings report follows: no confident figure from data
    // that cannot support one.
    const out = calibrate(dir, 12);
    expect(out.publishable).toBe(false);
    expect(out.reason).toMatch(/not yet calibrated/i);
  });

  test('an unreliable horizon refuses too, and says how unreliable', () => {
    scoreSome(10, (i) => (i % 5 === 0 ? 1 : 40));
    const out = calibrate(dir, 12);
    expect(out.publishable).toBe(false);
    expect(out.reason).toMatch(/unreliable/i);
  });

  test('a calibrated horizon publishes, corrected by observed bias', () => {
    scoreSome(12, () => 2);
    const out = calibrate(dir, 12);
    expect(out.publishable).toBe(true);
    // Refit from THIS project's error, not a global constant.
    expect(out.predictedTurns).toBeGreaterThan(12);
    expect(out.note).toMatch(/past forecasts/);
  });

  test('outcomes are scored by horizon, not lumped together', () => {
    // A single average hides that far-horizon forecasts run long, which is the
    // failure mode that actually matters.
    logForecast(dir, { sessionId: 'near', predictedTurns: 3 });
    observeOutcome(dir, { sessionId: 'near', actualTurns: 3 });
    logForecast(dir, { sessionId: 'far', predictedTurns: 50 });
    observeOutcome(dir, { sessionId: 'far', actualTurns: 90 });

    const rel = reliability(dir);
    expect(rel.buckets.near.hitRate).toBe(1);
    expect(rel.buckets.far.hitRate).toBe(0);
  });
});
