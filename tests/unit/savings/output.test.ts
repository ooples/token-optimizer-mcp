/**
 * WHAT THE PURE MODULE'S TESTS CANNOT REACH. `output-savings.test.ts` pins the
 * arithmetic given a stratum key and a token count. This file pins the step
 * before it -- turning a ledger row into that key -- and the step after it,
 * carrying the result through a rollup and back. Both are where a figure can go
 * wrong while every number still looks reasonable: a stratum derived from a
 * post-treatment field manufactures a saving out of its own bucketing, and a
 * triple that survives a round trip with its spread dropped publishes a point
 * estimate where an interval belongs.
 */

import {
  deferralTier,
  emptyOutputLedgers,
  mergeOutputLedgers,
  outputTiers,
  parseOutputLedgers,
  recordOutputRow,
  serializeOutputLedgers,
} from '../../../src/savings/output.js';
import { OUTPUT_ARM, stratumKey } from '../../../src/proxy/output-savings.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

const NOW = '2026-10-01T15:00:00.000Z';
const METHOD = 'tiktoken-gpt-4-compatible-local-estimate';

function record(over: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    ts: NOW,
    path: '/v1/messages',
    status: 200,
    compressed: true,
    beforeBytes: 40000,
    afterBytes: 10000,
    model: 'claude-opus-5',
    messageCount: 6,
    usage: { input_tokens: 2500, output_tokens: 300 },
    tokens: {
      measured: true,
      beforeTokens: 10000,
      afterTokens: 2500,
      method: METHOD,
    },
    ...over,
  };
}

function ledgerOf(records: readonly AccountingRecord[]) {
  const ledgers = emptyOutputLedgers();
  for (const one of records) recordOutputRow(ledgers, one);
  return ledgers;
}

describe('the stratum a row is filed under', () => {
  it('takes the size bucket from the pre-treatment token count', () => {
    // THE CIRCULARITY THIS FORBIDS. The row forwarded 2,500 tokens where it
    // started with 10,000. Bucketing on the forwarded figure would file every
    // effective compression one bucket below its own baseline, and the tiers
    // would then compare large-context baselines against medium-context
    // treatments -- a large, stable saving produced entirely by the bucketing.
    const ledgers = ledgerOf([record()]);
    const key = stratumKey({
      model: 'claude-opus-5',
      messageCount: 6,
      inputTokens: 10000,
      hasTools: false,
    });
    expect([...ledgers.compression.treatment.keys()]).toEqual([key]);
    // POSITIVE CONTROL: the post-treatment key is a DIFFERENT key, so the
    // assertion above would fail if the rule were ever reversed.
    const wrong = stratumKey({
      model: 'claude-opus-5',
      messageCount: 6,
      inputTokens: 2500,
      hasTools: false,
    });
    expect(wrong).not.toBe(key);
  });

  it('falls back to bytes when the counter could not measure the row', () => {
    const ledgers = ledgerOf([
      record({
        beforeBytes: 8000,
        tokens: { measured: false, reason: 'worker-failed' },
      }),
    ]);
    // 8000 bytes / 4 = 2000 tokens, which is the first token of the 's' bucket.
    expect([...ledgers.compression.treatment.keys()]).toEqual([
      stratumKey({
        model: 'claude-opus-5',
        messageCount: 6,
        inputTokens: 2000,
        hasTools: false,
      }),
    ]);
  });

  it('files an uncompressed row as the observational baseline', () => {
    const ledgers = ledgerOf([record({ compressed: false })]);
    expect(ledgers.compression.treatment.size).toBe(0);
    expect(ledgers.compression.baseline.size).toBe(1);
  });

  it('records the shaper arm only when an arm was assigned', () => {
    const withArm = ledgerOf([record({ outputArm: OUTPUT_ARM.Control })]);
    expect(withArm.shaper.control.size).toBe(1);
    expect(withArm.shaper.treatment.size).toBe(0);
    // POSITIVE CONTROL: the same row without an arm reaches the compression
    // ledger and leaves the shaper ledger empty, so "no experiment ran" is
    // distinguishable from "the experiment put everyone in one arm".
    const without = ledgerOf([record()]);
    expect(without.compression.treatment.size).toBe(1);
    expect(without.shaper.treatment.size).toBe(0);
    expect(without.shaper.control.size).toBe(0);
  });
});

describe('rows that must contribute nothing', () => {
  it('ignores a row with no output token count', () => {
    const ledgers = ledgerOf([
      record({ usage: { input_tokens: 2500 } }),
      record({ usage: { input_tokens: 2500, output_tokens: -1 } }),
      record({
        usage: { input_tokens: 2500, output_tokens: Number.NaN },
      }),
    ]);
    expect(ledgers.compression.treatment.size).toBe(0);
    // POSITIVE CONTROL: a zero-token reply IS an observation -- the model
    // answering with nothing is a real length, not a missing measurement.
    const zero = ledgerOf([
      record({ usage: { input_tokens: 2500, output_tokens: 0 } }),
    ]);
    expect(zero.compression.treatment.size).toBe(1);
  });
});

describe('the tiers read off a row-built ledger', () => {
  it('estimates from the observational arms and measures from the holdout', () => {
    const base = { messageCount: 6, beforeBytes: 40000 };
    const ledgers = ledgerOf([
      record({ ...base, compressed: false, usage: { output_tokens: 800 } }),
      record({ ...base, compressed: false, usage: { output_tokens: 800 } }),
      record({ ...base, usage: { output_tokens: 300 } }),
      record({
        ...base,
        usage: { output_tokens: 300 },
        outputArm: OUTPUT_ARM.Treatment,
      }),
      record({
        ...base,
        usage: { output_tokens: 500 },
        outputArm: OUTPUT_ARM.Control,
      }),
    ]);
    const tiers = outputTiers(ledgers);
    expect(tiers.estimated.evidence).toBe('estimated');
    // ALL THREE COMPRESSED ROWS ARE IN THE COMPRESSION TREATMENT ARM, the
    // shaper-control one included: being withheld from the SHAPER does not make
    // a row uncompressed. The two experiments are independent readings of the
    // same rows, so 3 * (800 - 1100/3) = 1300, not 1 * (800 - 300).
    expect(tiers.estimated.tokens).toBe(1300);
    expect(tiers.estimated.requests).toBe(3);
    expect(tiers.measured).not.toBeNull();
    expect(tiers.measured?.evidence).toBe('measured');
    expect(tiers.measured?.tokens).toBe(200);
  });

  it('returns no measured tier when no holdout ran', () => {
    const tiers = outputTiers(
      ledgerOf([record({ compressed: false }), record()])
    );
    expect(tiers.measured).toBeNull();
    // POSITIVE CONTROL: the estimated tier is present on the same ledger, so a
    // null here is "the experiment did not run", not "nothing was recorded".
    expect(tiers.estimated.requests).toBeGreaterThan(0);
  });
});

describe('carrying a ledger through a rollup line', () => {
  it('round-trips every arm with its spread intact', () => {
    const ledgers = ledgerOf([
      record({ compressed: false, usage: { output_tokens: 800 } }),
      record({ compressed: false, usage: { output_tokens: 600 } }),
      record({ usage: { output_tokens: 300 } }),
      record({ usage: { output_tokens: 100 } }),
      record({ usage: { output_tokens: 400 }, outputArm: OUTPUT_ARM.Control }),
      record({ usage: { output_tokens: 200 }, outputArm: OUTPUT_ARM.Control }),
    ]);
    const parsed = parseOutputLedgers(
      JSON.parse(JSON.stringify(serializeOutputLedgers(ledgers)))
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error('unreachable');
    // THE INTERVAL IS THE POINT. A round trip that kept only n and sum would
    // reproduce every mean exactly and still turn each tier into a point
    // estimate, so the equality asserted here is of the whole estimate --
    // tokens, percent, interval and disclosed pooling together.
    expect(outputTiers(parsed)).toEqual(outputTiers(ledgers));
    expect(outputTiers(parsed).estimated.interval).not.toBeNull();
  });

  it('prints its strata in sorted order so an unchanged day does not churn', () => {
    const forward = emptyOutputLedgers();
    const backward = emptyOutputLedgers();
    const rows = [
      record({ model: 'claude-opus-5' }),
      record({ model: 'gpt-5.6-sol' }),
      record({ model: 'gemini-3-pro' }),
    ];
    for (const one of rows) recordOutputRow(forward, one);
    for (const one of [...rows].reverse()) recordOutputRow(backward, one);
    expect(JSON.stringify(serializeOutputLedgers(forward))).toBe(
      JSON.stringify(serializeOutputLedgers(backward))
    );
    // POSITIVE CONTROL: there really are three distinct strata here, so the
    // equality above is not two empty objects agreeing.
    expect(
      Object.keys(serializeOutputLedgers(forward).compression.treatment)
    ).toHaveLength(3);
  });

  it('folds exactly, so a pruned day reports what the rows did', () => {
    const first = ledgerOf([
      record({ compressed: false, usage: { output_tokens: 800 } }),
      record({ usage: { output_tokens: 300 } }),
    ]);
    const second = ledgerOf([
      record({ compressed: false, usage: { output_tokens: 600 } }),
      record({ usage: { output_tokens: 100 } }),
    ]);
    const whole = ledgerOf([
      record({ compressed: false, usage: { output_tokens: 800 } }),
      record({ usage: { output_tokens: 300 } }),
      record({ compressed: false, usage: { output_tokens: 600 } }),
      record({ usage: { output_tokens: 100 } }),
    ]);
    mergeOutputLedgers(first, second);
    expect(outputTiers(first)).toEqual(outputTiers(whole));
  });

  it('reads an absent ledger as empty and a malformed one as unreadable', () => {
    expect(parseOutputLedgers(undefined)).not.toBeNull();
    expect(parseOutputLedgers(null)).toBeNull();
    expect(parseOutputLedgers(7)).toBeNull();
    const malformed = [
      { compression: { treatment: { 'opus|early|m|tools': [1, 2] } } },
      { compression: { treatment: { 'opus|early|m|tools': [0, 0, 0] } } },
      { compression: { treatment: { 'opus|early|m|tools': [2, 'x', 1] } } },
      { compression: { treatment: { 'opus|early|m|tools': [2, 1, -1] } } },
      { compression: { treatment: 'not-a-map' } },
      { shaper: { control: { 'opus|early|m|tools': [1.5, 1, 1] } } },
    ];
    for (const one of malformed) expect(parseOutputLedgers(one)).toBeNull();
    // POSITIVE CONTROL: the same shape with a valid triple parses, so the
    // refusals above are about the triples and not about the wrapper.
    expect(
      parseOutputLedgers({
        compression: { treatment: { 'opus|early|m|tools': [2, 300, 50000] } },
      })
    ).not.toBeNull();
  });

  it('refuses a triple no real sample could have produced', () => {
    // CAUCHY-SCHWARZ: sum^2 <= n * sumsq always. n=2, sum=300 needs sumsq of at
    // least 45000 (two observations of 150); 40000 would give a negative
    // variance and hence an imaginary interval half-width.
    expect(
      parseOutputLedgers({
        compression: { treatment: { 'opus|early|m|tools': [2, 300, 40000] } },
      })
    ).toBeNull();
    // POSITIVE CONTROL: the boundary case -- two identical observations -- is
    // legal and must parse, so the check is not simply rejecting tight spreads.
    expect(
      parseOutputLedgers({
        compression: { treatment: { 'opus|early|m|tools': [2, 300, 45000] } },
      })
    ).not.toBeNull();
  });
});

describe('the waste tier read off rows', () => {
  it('files a ratio and ignores a row that carried none', () => {
    const ledgers = ledgerOf([
      record({ echoRatio: 0.25 }),
      record({ echoRatio: 0.75 }),
      record(),
    ]);
    expect(outputTiers(ledgers).waste?.requests).toBe(2);
    expect(outputTiers(ledgers).waste?.meanRatio).toBe(0.5);
  });

  it('refuses a ratio that is not a share', () => {
    const ledgers = ledgerOf([
      record({ echoRatio: -0.1 }),
      record({ echoRatio: 1.5 }),
      record({ echoRatio: Number.NaN }),
    ]);
    expect(outputTiers(ledgers).waste).toBeNull();
    // POSITIVE CONTROL: both endpoints of the unit interval are legal shares.
    const legal = ledgerOf([
      record({ echoRatio: 0 }),
      record({ echoRatio: 1 }),
    ]);
    expect(outputTiers(legal).waste?.requests).toBe(2);
  });

  it('counts a scanned reply whose usage never arrived', () => {
    // THE TWO INSTRUMENTS ARE INDEPENDENT. The scanner read this reply; the
    // provider's usage object did not turn up. Dropping the waste figure for
    // want of a token count would make the waste mean an average over only the
    // rows that also reported usage.
    const ledgers = ledgerOf([record({ usage: {}, echoRatio: 0.4 })]);
    expect(ledgers.compression.treatment.size).toBe(0);
    expect(outputTiers(ledgers).waste?.meanRatio).toBe(0.4);
  });

  it('carries the waste figure across a rollup line', () => {
    const ledgers = ledgerOf([
      record({ echoRatio: 0.2 }),
      record({ echoRatio: 0.4 }),
    ]);
    const wire = JSON.parse(JSON.stringify(serializeOutputLedgers(ledgers)));
    // The exact float sums, written out: n, sum of the ratios, sum of their
    // squares. Pinned literally because the whole point of the triple is that
    // a day's spread survives the rollup, and a rounded expectation here would
    // pass against a serializer that quietly dropped digits.
    expect(wire.echo).toEqual([2, 0.6000000000000001, 0.20000000000000004]);
    const parsed = parseOutputLedgers(wire);
    expect(parsed).not.toBeNull();
    if (parsed === null) throw new Error('unreachable');
    expect(outputTiers(parsed).waste).toEqual(outputTiers(ledgers).waste);
  });

  it('omits the field entirely when nothing was scanned', () => {
    // ABSENT IS NOT ZERO. A day from an operator who never turned the scanner
    // on must not come back as a day in which no reply echoed anything.
    const wire = serializeOutputLedgers(ledgerOf([record()]));
    expect('echo' in wire).toBe(false);
    expect(parseOutputLedgers(wire)).not.toBeNull();
    expect(
      outputTiers(parseOutputLedgers(wire) ?? emptyOutputLedgers()).waste
    ).toBeNull();
    // POSITIVE CONTROL: a scanned day does carry the field.
    expect(
      'echo' in serializeOutputLedgers(ledgerOf([record({ echoRatio: 0.1 })]))
    ).toBe(true);
  });

  it('fails the whole line on an echo triple it cannot stand behind', () => {
    expect(parseOutputLedgers({ echo: [2, 300, 40000] })).toBeNull();
    expect(parseOutputLedgers({ echo: [1, 0.5] })).toBeNull();
    expect(parseOutputLedgers({ echo: 'nope' })).toBeNull();
    // POSITIVE CONTROL: a legal triple parses in the same position.
    expect(parseOutputLedgers({ echo: [2, 0.6, 0.2] })).not.toBeNull();
  });
});

/**
 * THE PROMPT-SIDE LEDGER, WHICH IS WHERE THE WRONG NUMBER WOULD BE INVISIBLE.
 * Everything else in this file files output tokens. This ledger files the
 * provider's billed PROMPT tokens, and the two are the same shape and the same
 * type and about different halves of the bill -- so a row filed into the wrong
 * one is a plausible figure under a wrong name rather than a crash.
 */
describe('the tool-deferral holdout ledger', () => {
  /** Billed prompt tokens, which is what this ledger is denominated in. */
  const billed = (
    input: number,
    over: Partial<AccountingRecord> = {}
  ): AccountingRecord =>
    record({ usage: { input_tokens: input, output_tokens: 300 }, ...over });

  const KEY = stratumKey({
    model: 'claude-opus-5',
    messageCount: 6,
    inputTokens: 10000,
    hasTools: false,
  });

  it('files each arm under the arm it was in', () => {
    const ledgers = ledgerOf([
      billed(9000, { deferralArm: OUTPUT_ARM.Control }),
      billed(3000, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    expect(ledgers.deferral.control.get(KEY)?.sum).toBe(9000);
    expect(ledgers.deferral.treatment.get(KEY)?.sum).toBe(3000);
    // THE FIGURE IS THE PROVIDER'S, NOT OURS. 2,500 is what our own counter
    // said about this row's forwarded body, and it appears in the compression
    // ledger; nothing in the deferral ledger may be derived from it.
    expect(ledgers.deferral.control.get(KEY)?.sum).not.toBe(2500);
  });

  it('leaves the output tiers alone, because its unit is not theirs', () => {
    const ledgers = ledgerOf([
      billed(9000, { deferralArm: OUTPUT_ARM.Control }),
      billed(3000, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    // NO HOLDOUT RAN ON THE SHAPER, so the measured OUTPUT tier is still null
    // even though a measured PROMPT tier is available. A ledger that shared a
    // map would have published 6,000 prompt tokens as an output saving.
    expect(outputTiers(ledgers).measured).toBeNull();
    // POSITIVE CONTROL: the prompt-side estimate does exist on these rows.
    expect(deferralTier(ledgers)?.tokens).toBe(6000);
  });

  it('reports control minus treatment, so withheld-pays-more is a saving', () => {
    const ledgers = ledgerOf([
      billed(9000, { deferralArm: OUTPUT_ARM.Control }),
      billed(9400, { deferralArm: OUTPUT_ARM.Control }),
      billed(3000, { deferralArm: OUTPUT_ARM.Treatment }),
      billed(3200, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    const estimate = deferralTier(ledgers);
    // Two treated requests, each saving the 6,100-token gap between the arms'
    // means: (9200 - 3100) * 2.
    expect(estimate?.tokens).toBe(12200);
    expect(estimate?.requests).toBe(2);
    // SIGNED, AND THE SIGN IS CHECKED IN BOTH DIRECTIONS. If the provider were
    // ignoring the beta the arms would bill alike and this would read near
    // zero; if deferral somehow cost tokens it would read negative. Neither
    // case may be silently printed as a saving.
    const reversed = ledgerOf([
      billed(3000, { deferralArm: OUTPUT_ARM.Control }),
      billed(3200, { deferralArm: OUTPUT_ARM.Control }),
      billed(9000, { deferralArm: OUTPUT_ARM.Treatment }),
      billed(9400, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    expect(deferralTier(reversed)?.tokens).toBe(-12200);
  });

  it('is absent when no holdout ran', () => {
    // The ordinary case: deferral acts on everything and nothing is withheld,
    // so there is no control arm and no measurement -- not a measurement of no
    // effect, which is what a zero here would have claimed.
    expect(deferralTier(ledgerOf([record(), record()]))).toBeNull();
    // POSITIVE CONTROL: the same rows with arms DO produce an estimate.
    expect(
      deferralTier(
        ledgerOf([
          billed(9000, { deferralArm: OUTPUT_ARM.Control }),
          billed(3000, { deferralArm: OUTPUT_ARM.Treatment }),
        ])
      )
    ).not.toBeNull();
  });

  it('skips a row the provider never charged for', () => {
    // A 429 OR A DROPPED CONNECTION IS NOT A CHEAP REQUEST. Entering it as
    // zero prompt tokens would pull whichever arm failed more often toward
    // nothing, and the arm more likely to fail is the one carrying the
    // feature.
    const ledgers = ledgerOf([
      billed(9000, { deferralArm: OUTPUT_ARM.Control, status: 429 }),
      billed(9000, {
        deferralArm: OUTPUT_ARM.Treatment,
        transportError: 'socket hang up',
      }),
    ]);
    expect(ledgers.deferral.control.size).toBe(0);
    expect(ledgers.deferral.treatment.size).toBe(0);
    // POSITIVE CONTROL: the identical rows at status 200 are filed.
    const kept = ledgerOf([
      billed(9000, { deferralArm: OUTPUT_ARM.Control }),
      billed(9000, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    expect(kept.deferral.control.size).toBe(1);
    expect(kept.deferral.treatment.size).toBe(1);
  });

  it('skips a billed row that reported no prompt count', () => {
    const ledgers = ledgerOf([
      record({
        deferralArm: OUTPUT_ARM.Control,
        usage: { output_tokens: 300 },
      }),
    ]);
    expect(ledgers.deferral.control.size).toBe(0);
    // POSITIVE CONTROL: the arm label is not what was rejected -- the same
    // label with a prompt count is filed.
    expect(
      ledgerOf([billed(9000, { deferralArm: OUTPUT_ARM.Control })]).deferral
        .control.size
    ).toBe(1);
  });

  it('adds the cache tokens the provider billed for the prompt', () => {
    // THE PROMPT IS WHAT WAS IN CONTEXT, however it was paid for. Deferral
    // changes the tool block, the tool block lives in the cached prefix, and a
    // figure that read `input_tokens` alone would miss the whole effect on any
    // conversation whose prefix was being cached or read.
    const ledgers = ledgerOf([
      record({
        deferralArm: OUTPUT_ARM.Control,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 900,
          output_tokens: 300,
        },
      }),
    ]);
    expect(ledgers.deferral.control.get(KEY)?.sum).toBe(9000);
  });

  it('survives a rollup round trip, and an old row without it parses', () => {
    const ledgers = ledgerOf([
      billed(9000, { deferralArm: OUTPUT_ARM.Control }),
      billed(3000, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    const back = parseOutputLedgers(serializeOutputLedgers(ledgers));
    expect(back).not.toBeNull();
    expect(deferralTier(back ?? emptyOutputLedgers())?.tokens).toBe(6000);
    // AN OLD ROLLUP FILE HAS NO `deferral` KEY AT ALL, and must fold as an
    // empty ledger rather than failing the whole row -- a rejected row drops
    // every other tier that day with it.
    const serialized = serializeOutputLedgers(ledgers) as Record<
      string,
      unknown
    >;
    delete serialized.deferral;
    const older = parseOutputLedgers(serialized);
    expect(older).not.toBeNull();
    expect(deferralTier(older ?? emptyOutputLedgers())).toBeNull();
    // POSITIVE CONTROL: the rest of the row still arrived.
    expect(older?.compression.treatment.size).toBe(1);
  });

  it('folds two windows into one estimate', () => {
    const left = ledgerOf([billed(9000, { deferralArm: OUTPUT_ARM.Control })]);
    const right = ledgerOf([
      billed(3000, { deferralArm: OUTPUT_ARM.Treatment }),
    ]);
    mergeOutputLedgers(left, right);
    expect(deferralTier(left)?.tokens).toBe(6000);
    // POSITIVE CONTROL: neither side could produce that on its own.
    expect(deferralTier(right)).toBeNull();
  });
});
