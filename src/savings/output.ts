/**
 * Turning recorded rows into the three output-savings tiers.
 *
 * WHERE THIS SITS. `src/proxy/output-savings.ts` is the arithmetic -- pure
 * accumulators, strata, two estimators and an interval -- and knows nothing
 * about a ledger row. This file is the reading: it decides which rows belong in
 * which arm of which comparison, and it is the one place that decision is made,
 * so the live ledger and a day already folded into totals cannot disagree about
 * it.
 *
 * TWO COMPARISONS, NOT ONE, because there are two interventions and conflating
 * them would publish a figure about neither:
 *
 *  - COMPRESSION, which every request gets. Rows we declined to compress are
 *    an observational baseline against rows we did. Nobody randomized this, so
 *    the two groups differ in ways besides the treatment -- the declined rows
 *    are declined BECAUSE they were small or unusual -- and the figure is
 *    labelled estimated for exactly that reason.
 *
 *  - THE OUTPUT SHAPER, which withholds itself from a random fraction of
 *    conversations. That fraction is a real control arm, so the difference
 *    between the arms is a measurement. It exists only when an operator turned
 *    the holdout on, and the tier says nothing at all when they did not.
 *
 * STRATIFIED ON PRE-TREATMENT FEATURES ONLY. The size bucket is taken from the
 * bytes the request arrived with, never the bytes we forwarded: a stratum that
 * depended on the compressed size would put every effective compression in a
 * smaller bucket than the baseline it is compared against, and the comparison
 * would measure its own bucketing. That error produces a large, stable,
 * entirely fictional saving, and nothing in the output looks wrong.
 *
 * BOUNDED BY CONSTRUCTION, which is what makes it safe to carry across a
 * retention fold. Every component of a stratum key comes from a fixed
 * vocabulary -- ten model families, four turn kinds, five size buckets, tools
 * or not -- so there are at most 400 strata per arm no matter how long the
 * proxy runs. Three numbers each; a day's folded output ledger cannot grow
 * without limit the way a per-request store could.
 *
 * COUNTS ONLY, NEVER CONTENT. A stratum key is four words from fixed lists and
 * an accumulator is three numbers. No prompt, no reply, no conversation key,
 * no path.
 */

import {
  OUTPUT_ARM,
  emptyOutputLedger,
  estimateFromBaseline,
  estimateFromHoldout,
  mergeOutputLedger,
  recordBaseline,
  recordOutput,
  stratumKey,
  type Accum,
  type OutputSavingsEstimate,
  type OutputSavingsLedger,
} from '../proxy/output-savings.js';
import type { AccountingRecord } from '../proxy/accounting.js';

/**
 * The two comparisons, kept apart.
 *
 * `compression` USES baseline-vs-treatment; `shaper` USES control-vs-treatment.
 * The unused map in each stays empty, and that is deliberate: one structure
 * with a spare slot is easier to fold, serialize and validate than two shapes,
 * and an estimator pointed at the wrong map returns nothing rather than a
 * plausible number from the wrong rows.
 */
export interface OutputLedgers {
  readonly compression: OutputSavingsLedger;
  readonly shaper: OutputSavingsLedger;
}

export function emptyOutputLedgers(): OutputLedgers {
  return { compression: emptyOutputLedger(), shaper: emptyOutputLedger() };
}

export function mergeOutputLedgers(
  into: OutputLedgers,
  from: OutputLedgers
): void {
  mergeOutputLedger(into.compression, from.compression);
  mergeOutputLedger(into.shaper, from.shaper);
}

/**
 * Four bytes to a token, for the size bucket and nothing else.
 *
 * AN APPROXIMATION THAT CANNOT BIAS THE RESULT, which is why it is allowed to
 * be one. It decides which bucket a borderline request lands in, and a bucket
 * is only a device for comparing like with like; the SAME function places both
 * arms, so a misplaced request is compared against other requests placed by
 * the same rule. Nothing downstream treats the figure as a token count.
 *
 * ONLY USED WHEN THE COUNTER DID NOT RUN. A row with measured token accounting
 * carries its own pre-compression count, and that is preferred.
 */
const BYTES_PER_TOKEN = 4;

function preTreatmentTokens(record: AccountingRecord): number {
  const measured = record.tokens;
  if (measured !== undefined && measured.measured)
    return measured.beforeTokens;
  return Math.round(record.beforeBytes / BYTES_PER_TOKEN);
}

/**
 * Folds one recorded row into both comparisons.
 *
 * A ROW WITH NO REPORTED OUTPUT IS NOT A ROW WITH ZERO OUTPUT. A refused
 * request, a transport failure, a response whose usage never arrived: none of
 * them tell us how much the model wrote, and entering them as zero would pull
 * both arms' means toward nothing in proportion to how often each arm failed.
 * They are skipped, which is the only honest treatment of a missing
 * measurement.
 *
 * THE SHAPER COMPARISON ONLY SEES ROWS THAT CARRY AN ARM, and rows carry one
 * only while a holdout is configured. So a ledger written with no experiment
 * running contributes nothing to the measured tier, and the measured tier
 * reports nothing -- rather than reporting a null result for a trial that was
 * never run.
 */
export function recordOutputRow(
  ledgers: OutputLedgers,
  record: AccountingRecord
): void {
  const emitted = record.usage.output_tokens;
  if (typeof emitted !== 'number' || !Number.isFinite(emitted) || emitted < 0)
    return;
  const key = stratumKey({
    model: record.model ?? '',
    messageCount: record.messageCount ?? 0,
    inputTokens: preTreatmentTokens(record),
    hasTools: (record.toolCount ?? 0) > 0,
  });
  if (record.compressed) recordOutput(ledgers.compression, OUTPUT_ARM.Treatment, key, emitted);
  else recordBaseline(ledgers.compression, key, emitted);
  if (record.outputArm !== undefined)
    recordOutput(ledgers.shaper, record.outputArm, key, emitted);
}

/**
 * The two estimated tiers, each from the comparison that can support it.
 *
 * `measured` IS NULL WHENEVER NO HOLDOUT RAN, and the renderer prints nothing
 * for it. `estimated` always has a value once any row carried an output count,
 * because there is always a declined-compression group to compare against --
 * though it may be a thin one, which is what the interval and
 * `pooledRequests` are for.
 */
export interface OutputTiers {
  readonly estimated: OutputSavingsEstimate;
  readonly measured: OutputSavingsEstimate | null;
}

export function outputTiers(ledgers: OutputLedgers): OutputTiers {
  return {
    estimated: estimateFromBaseline(ledgers.compression),
    measured: estimateFromHoldout(ledgers.shaper),
  };
}

/**
 * One arm's strata as a plain object, for a rollup file.
 *
 * THREE NUMBERS PER STRATUM, IN AN ARRAY, because a rollup line is written once
 * per day per ledger and read on every report; `[n, sum, sumsq]` is a third the
 * bytes of three named fields and carries exactly the same information. The
 * order is fixed by `TRIPLE` below and validated on the way back in.
 */
export type SerializedArm = Record<string, readonly number[]>;

export interface SerializedOutputLedgers {
  readonly compression: {
    readonly baseline: SerializedArm;
    readonly treatment: SerializedArm;
    readonly control: SerializedArm;
  };
  readonly shaper: {
    readonly baseline: SerializedArm;
    readonly treatment: SerializedArm;
    readonly control: SerializedArm;
  };
}

const ARMS = ['baseline', 'treatment', 'control'] as const;
const TRIPLE = 3;

function serializeArm(arm: ReadonlyMap<string, Accum>): SerializedArm {
  const out: Record<string, readonly number[]> = {};
  // SORTED, SO A ROLLUP LINE IS BYTE-STABLE FOR THE SAME DATA. A rollup file is
  // rewritten in place on every prune, and a map's insertion order would make
  // an unchanged day's line change for no reason -- which reads, to anyone
  // diffing it, as the figures having moved.
  for (const key of [...arm.keys()].sort()) {
    const accum = arm.get(key);
    if (accum === undefined || accum.n === 0) continue;
    out[key] = [accum.n, accum.sum, accum.sumsq];
  }
  return out;
}

function serializeOne(
  ledger: OutputSavingsLedger
): SerializedOutputLedgers['compression'] {
  return {
    baseline: serializeArm(ledger.baseline),
    treatment: serializeArm(ledger.treatment),
    control: serializeArm(ledger.control),
  };
}

export function serializeOutputLedgers(
  ledgers: OutputLedgers
): SerializedOutputLedgers {
  return {
    compression: serializeOne(ledgers.compression),
    shaper: serializeOne(ledgers.shaper),
  };
}

/**
 * One stratum triple back from a rollup line, or null if it is not one.
 *
 * REFUSED RATHER THAN REPAIRED. A triple that is the wrong length, or holds a
 * negative count, or a sum of squares smaller than a single observation allows,
 * is not a day with a slightly wrong figure in it -- it is a line this build
 * cannot interpret, and the caller counts it as skipped and says so. Coercing
 * it would publish an interval computed from a variance that cannot exist.
 */
function parseTriple(value: unknown): Accum | null {
  if (!Array.isArray(value) || value.length !== TRIPLE) return null;
  const [n, sum, sumsq] = value as unknown[];
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  if (typeof sum !== 'number' || !Number.isFinite(sum)) return null;
  if (typeof sumsq !== 'number' || !Number.isFinite(sumsq) || sumsq < 0)
    return null;
  // CAUCHY-SCHWARZ: sum^2 <= n * sumsq for any real sample, so a pair that
  // breaks it could not have come from observations and would yield a negative
  // variance. A small tolerance keeps a legitimately zero-spread stratum --
  // where the two sides are equal and float rounding can tip either way --
  // from being thrown out.
  if (sum * sum > n * sumsq * (1 + 1e-9) + 1e-6) return null;
  return { n, sum, sumsq };
}

function parseArm(value: unknown, into: Map<string, Accum>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  for (const [key, triple] of Object.entries(value as Record<string, unknown>)) {
    const accum = parseTriple(triple);
    if (accum === null) return false;
    into.set(key, accum);
  }
  return true;
}

function parseOne(value: unknown, into: OutputSavingsLedger): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const seen = value as Record<string, unknown>;
  for (const arm of ARMS) {
    if (!parseArm(seen[arm] ?? {}, into[arm])) return false;
  }
  return true;
}

/**
 * Both ledgers back from a rollup line, or null when the line is not one.
 *
 * AN ABSENT FIELD IS AN EMPTY LEDGER, NOT A REFUSAL, so a rollup written before
 * this existed still folds -- it simply contributes no output rows, which is
 * the truth about it. A field that is PRESENT and malformed is refused, because
 * then something did write output figures and this build cannot read them.
 */
export function parseOutputLedgers(value: unknown): OutputLedgers | null {
  const ledgers = emptyOutputLedgers();
  if (value === undefined) return ledgers;
  if (typeof value !== 'object' || value === null) return null;
  const seen = value as Record<string, unknown>;
  if (!parseOne(seen.compression ?? {}, ledgers.compression)) return null;
  if (!parseOne(seen.shaper ?? {}, ledgers.shaper)) return null;
  return ledgers;
}
