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
  MIN_CONTROL_TOUCHES, balanceAwareEvents,
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
    // The fixture now supplies what this test's own name asserts: a control arm carrying enough
    // held-out touches to have spoken, and the session's intercepted-touch count. Both are new
    // preconditions, and both are asserted on their own below.
    seedArms({ treated: 30, withheld: MIN_CONTROL_TOUCHES + 2 });
    const air = runway(
      { used: 60_000, capacity: 200_000, turns: 30, touches: 30 }, burnRate(readMetrics(dir)),
    );
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

// --- the panel must be able to publish a result that is bad for the product --------

describe('each read is charged to exactly one injection', () => {
  test('five injections of one anchor cost one read, not five', () => {
    // THE DEFECT: every injection's window ran to the end of the log, so the windows overlapped
    // completely. i1 saw all five reads, i2 four, and so on -- 1500/5 = 300 against a true
    // per-touch cost of 100. A 3x inflation growing with the repeat count, and it does NOT cancel
    // between the arms: the holdout is deterministic in (anchor, epoch), so all repeat touches of
    // a file land in the same arm. Whichever arm drew the re-touched anchors was inflated.
    for (let i = 0; i < 5; i++) {
      record(dir, { kind: 'inject', anchor: '/repeat.ts', sessionId: 's', holdout: false, tokens: 0 });
      recordRead(dir, { anchor: '/repeat.ts', sessionId: 's', bytes: 400 });
    }
    const rate = burnRate(readMetrics(dir));
    expect(rate.perTouch).toBe(100);
  });

  test('a read before any injection is charged to none of them', () => {
    // Explicit timestamps: record() and recordRead() called back to back land in the same
    // millisecond, and a window bounded on `at` cannot order two events that share one.
    // record() directly, because recordRead() does not forward `at`.
    record(dir, { kind: 'read', anchor: '/early.ts', sessionId: 's', tokens: 1_000, at: 1_000 });
    record(dir, { kind: 'inject', anchor: '/early.ts', sessionId: 's', holdout: false, tokens: 0, at: 2_000 });
    expect(burnRate(readMetrics(dir)).perTouch).toBe(0);
  });
});

describe('the counterfactual is not published on a thin control arm', () => {
  test('one held-out touch is not volume', () => {
    // THE DEFECT: the only volume check was `if (!rows.length) return null`, so a single withheld
    // touch published '~70 turns to compaction; without the graph, ~40' as a bare fact -- while
    // the header promises the counterfactual appears 'only once the holdout carries volume' and
    // the fallback string says 'the control arm needs more volume'.
    seedArms({ treated: 30, withheld: 1 });
    const air = runway(
      { used: 60_000, capacity: 200_000, turns: 30, touches: 30 }, burnRate(readMetrics(dir)),
    );
    expect(air.withoutGraph).toBeNull();
    expect(air.counterfactual).toBe('thin-control');
    expect(air.withheld).toBe(1);
  });

  test('the panel says how short the arm is, rather than only that it is short', () => {
    seedArms({ treated: 30, withheld: 2 });
    const panel = forecastPanel(dir, { used: 60_000, capacity: 200_000, turns: 30, touches: 30 });
    expect(panel.text).toContain(`2 of the ${MIN_CONTROL_TOUCHES} held-out touches needed`);
  });

  test('the threshold is a real bound', () => {
    expect(MIN_CONTROL_TOUCHES).toBeGreaterThan(1);
  });
});

describe('a per-touch saving is converted before it is added to a per-turn cost', () => {
  test('the counterfactual shrinks as touch density falls', () => {
    // THE DEFECT: perTurn is tokens per TURN for this session; savedPerTouch is an average over
    // injection EVENTS across the whole log. Adding them was only correct at exactly one
    // intercepted touch per turn. At 5 touches over 30 turns the honest counterfactual is 62 and
    // the old arithmetic gave 40 -- the panel claiming the graph nearly doubled the runway when
    // it added about eight turns.
    const rate = { savedPerTouch: 1500, treatedTouches: 5, withheldTouches: MIN_CONTROL_TOUCHES };
    const session = { used: 60_000, capacity: 200_000, turns: 30 };

    const sparse = runway({ ...session, touches: 5 }, rate);
    const dense = runway({ ...session, touches: 30 }, rate);

    expect(sparse.withoutGraph).toBe(62);
    expect(dense.withoutGraph).toBe(40);
    expect(sparse.withoutGraph).toBeGreaterThan(dense.withoutGraph);
  });

  test('with no touch count the counterfactual is withheld, not assumed', () => {
    const rate = { savedPerTouch: 1500, treatedTouches: 5, withheldTouches: MIN_CONTROL_TOUCHES };
    const air = runway({ used: 60_000, capacity: 200_000, turns: 30 }, rate);
    expect(air.withoutGraph).toBeNull();
    expect(air.counterfactual).toBe('no-touch-density');
  });
});

describe('a measured loss is reported as a loss', () => {
  test('a negative saving yields a counterfactual, not an absent one', () => {
    // THE DEFECT: `saved > 0` discarded a MEASUREMENT rather than a missing one. The control arm
    // saying the graph is a net cost rendered as 'no counterfactual yet -- the control arm needs
    // more volume'. The one result unfavourable to the product was the one result the panel was
    // structurally incapable of showing, disguised as insufficient data.
    const rate = { savedPerTouch: -100, treatedTouches: 30, withheldTouches: MIN_CONTROL_TOUCHES };
    const air = runway({ used: 60_000, capacity: 200_000, turns: 30, touches: 30 }, rate);

    expect(air.counterfactual).toBe('costing');
    expect(air.withoutGraph).not.toBeNull();
    // Without the graph each turn is CHEAPER, so the runway is longer.
    expect(air.withoutGraph).toBeGreaterThan(air.withGraph);
  });

  test('the panel says so in words', () => {
    const rate = { savedPerTouch: -100, treatedTouches: 30, withheldTouches: MIN_CONTROL_TOUCHES };
    const air = runway({ used: 60_000, capacity: 200_000, turns: 30, touches: 30 }, rate);
    expect(air.counterfactual).toBe('costing');
    // and the same through the panel, which is where a user actually reads it
    // A control arm that reads LESS than the treated arm: the graph is measurably a net cost.
    // Mild enough that the per-turn saving does not exceed the session's whole per-turn spend,
    // which is a different (and separately reported) situation.
    seedArms({ treated: 12, withheld: MIN_CONTROL_TOUCHES + 1, treatedRead: 800, withheldRead: 500 });
    const panel = forecastPanel(dir, { used: 60_000, capacity: 200_000, turns: 30, touches: 12 });
    expect(panel.text).toMatch(/measurably NOT extending the runway/);
  });

  test('an unmeasured saving is still distinguishable from a measured zero', () => {
    const air = runway({ used: 60_000, capacity: 200_000, turns: 30, touches: 5 },
      { savedPerTouch: null, treatedTouches: 5, withheldTouches: 0 });
    expect(air.counterfactual).toBe('unmeasured');
    expect(air.withoutGraph).toBeNull();
  });
});

describe('the shadow arm reports a net loss instead of nothing', () => {
  test('substitutions that avoided nothing report a negative net', () => {
    // THE DEFECT: `return avoided ? ... : null` guarded on the FAVOURABLE quantity. Twenty
    // substitutions each spending 20 tokens and avoiding nothing -- a measured net loss of 400 --
    // returned null, so the divergence block never ran and the panel said nothing at all.
    const events = Array.from({ length: 20 }, () => ({
      kind: 'substitute', anchor: '/src/real.ts', bytesAvoided: 0, tokens: 20,
    }));
    const shadow = shadowAvoided(events);
    expect(shadow).not.toBeNull();
    expect(shadow.net).toBe(-400);
    expect(shadow.substitutions).toBe(20);
  });

  test('no substitutions at all is still nothing to say', () => {
    expect(shadowAvoided([{ kind: 'read', anchor: '/a.ts', tokens: 10 }])).toBeNull();
  });

  test('fixture anchors are excluded, as the balance sheet already excludes them', () => {
    // Measured in metrics.mjs: 366 of 370 substitutions pointed at the enforcement suite's own
    // fixture under a temp dir, making the product look like it had avoided 40 MB. It had avoided
    // 154 KB. Counting them here blew up shadow.net, pushed the divergence spread past 0.5 and
    // fired the credibility check with a fabricated number.
    const fixture = join(tmpdir(), 'to-hooks-abc123', 'big.ts');
    const events = [
      { kind: 'substitute', anchor: fixture, bytesAvoided: 40_000_000, tokens: 10 },
      { kind: 'substitute', anchor: '/src/real.ts', bytesAvoided: 4_000, tokens: 10 },
    ];
    const shadow = shadowAvoided(events);
    expect(shadow.substitutions).toBe(1);
    expect(shadow.avoided).toBe(1_000);
  });
});

describe('the balance kinds are read from the log that is not windowed', () => {
  test('the control arm survives a firehose long enough to have evicted it', () => {
    // THE DEFECT: the panel was built from readMetrics, which applies MAX_EVENTS and a tail byte
    // cap. metrics.mjs records what that does, measured in this repository: '44 inject records in
    // the file, 9 of them holdout, all at lines 60-76 of 9,058 -- every single one outside the
    // window.' The 10% holdout arm is the rarer kind, so it ages out FIRST: downstream(withheld)
    // returned null and the panel blamed 'the control arm needs more volume' for a read-path bug,
    // while balance.jsonl held the arm in full.
    seedArms({ treated: 12, withheld: MIN_CONTROL_TOUCHES + 2 });

    // Bury the injections under more read events than the window will hold.
    for (let i = 0; i < 5_200; i++) recordRead(dir, { anchor: `/noise${i}.ts`, sessionId: 's', bytes: 40 });

    const windowed = burnRate(readMetrics(dir));
    const complete = burnRate(balanceAwareEvents(dir));

    // The windowed read has lost the arms entirely; the balance-aware read has not.
    expect(windowed).toBeNull();
    expect(complete).not.toBeNull();
    expect(complete.withheldTouches).toBe(MIN_CONTROL_TOUCHES + 2);
    expect(complete.savedPerTouch).not.toBeNull();
  });

  test('balance kinds are not counted twice when both logs hold them', () => {
    seedArms({ treated: 4, withheld: 3 });
    const merged = balanceAwareEvents(dir);
    expect(merged.filter((e) => e.kind === 'inject')).toHaveLength(7);
  });
});
