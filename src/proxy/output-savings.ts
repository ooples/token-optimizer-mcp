/**
 * What our compression did to the OUTPUT side of the bill, and why that figure
 * needs three different words for three different strengths of evidence.
 *
 * THE PROBLEM, STATED PRECISELY. Input compression is a pure function of the
 * request: we hold both bodies, so `beforeTokens` and `afterTokens` are each
 * observed and their difference is a measurement. Output is not like that. We
 * rewrite the request, the model emits some number of tokens, and the number it
 * WOULD have emitted had we not rewritten it never happens. Only one side of
 * the counterfactual exists per request, so a single flat percentage for output
 * savings is a claim no ledger can support -- and the measured split of the
 * bill puts output at 11.5% of it, which is far too much to leave unreported
 * and far too little to justify reporting a guess about.
 *
 * AND THERE ARE TWO TREATMENTS HERE, NOT ONE. `output-shaper.ts` is a
 * deliberate attempt to shorten the reply, and it already withholds a fraction
 * of conversations so that it can be compared against something. Compression is
 * not that: it rewrites the CONTEXT for the input saving, and what a terser
 * context does to the length of the reply is genuinely unknown -- a model shown
 * less of its own earlier work may plausibly restate more of it, not less. So
 * this module is as able to report that we COST the operator output tokens as
 * that we saved them, and every delta here is summed signed and never clamped
 * per request -- clamping each request at zero would turn a wash into a saving,
 * which is the exact arithmetic that makes a measurement into marketing.
 *
 * THE THREE TIERS, strongest evidence last:
 *
 *  1. ESTIMATED (synthetic control). Rows we did not compress give a per-
 *     stratum mean output; the delta against the rows we did compress is an
 *     estimate. It is OBSERVATIONAL and therefore biased: we skip compression
 *     when a request is small or unusual, so the two groups differ in ways
 *     besides the treatment. Reported with a propagated interval, and never
 *     called measured.
 *
 *  2. MEASURED (A/B holdout). When a fraction of conversations is assigned AT
 *     RANDOM to pass through untreated, the per-stratum difference of means is
 *     an unbiased causal estimate, because assignment is independent of
 *     everything else about the request. This is the only tier that earns the
 *     word "measured", and the only arm assignment it will accept is the one
 *     the shaper actually acted on -- see `assignArm`. Assignment is
 *     whole-conversation for two reasons that happen to agree: mixing arms
 *     inside one conversation pollutes the comparison, and it also busts the
 *     provider's prefix cache mid-stream.
 *
 *  3. OBSERVED WASTE (no counterfactual at all). The share of a response that
 *     restates text it was already shown is a property of that one response,
 *     measurable without any counterfactual. "31% of output restated existing
 *     context" is an honest standalone fact; it is not a saving and is never
 *     added to one.
 *
 * STRATIFIED ON REQUEST-TIME FEATURES ONLY -- model family, how long the
 * conversation is, how big the input is, whether tools are present. Nothing
 * here may look at the response: a stratum that depends on the output would
 * make the comparison circular, and the circularity would be invisible in the
 * result.
 *
 * PURE. No I/O, no clock, no network, no state outside the objects passed in --
 * so every figure it produces is reproducible from the rows it was given.
 */

import { inHoldout } from './output-shaper.js';

/** Which kind of evidence a figure rests on. Never a bare string: the word is the claim. */
export const OUTPUT_EVIDENCE = {
  /** Observational, from rows we happened not to compress. Biased; disclosed. */
  Estimated: 'estimated',
  /** Randomized holdout. The only tier that may be called measured. */
  Measured: 'measured',
  /** A property of one response. Not a saving, and never added to one. */
  ObservedWaste: 'observed-waste',
} as const;

export type OutputEvidence =
  (typeof OUTPUT_EVIDENCE)[keyof typeof OUTPUT_EVIDENCE];

/** Which side of the comparison a request is on. */
export const OUTPUT_ARM = {
  /** The request we compressed. */
  Treatment: 'treatment',
  /** The request we deliberately left alone, so it can be compared against. */
  Control: 'control',
} as const;

export type OutputArm = (typeof OUTPUT_ARM)[keyof typeof OUTPUT_ARM];

/**
 * Count, sum and sum of squares: everything a mean and a variance need.
 *
 * THESE THREE NUMBERS ARE ADDITIVE, which is the property the whole module is
 * built on. Merging two accumulators element-wise gives exactly what observing
 * both streams against one accumulator would have given, so a day folded into
 * totals by the retention policy carries its full statistical weight -- not
 * just its mean, which would lose the spread the interval is computed from.
 */
export interface Accum {
  n: number;
  sum: number;
  sumsq: number;
}

export function emptyAccum(): Accum {
  return { n: 0, sum: 0, sumsq: 0 };
}

export function observe(accum: Accum, value: number): void {
  accum.n += 1;
  accum.sum += value;
  accum.sumsq += value * value;
}

/** Folds one accumulator into another. Order-independent, exactly. */
export function mergeAccum(into: Accum, from: Accum): void {
  into.n += from.n;
  into.sum += from.sum;
  into.sumsq += from.sumsq;
}

export function accumMean(accum: Accum): number {
  return accum.n > 0 ? accum.sum / accum.n : 0;
}

/**
 * The unbiased sample variance, or null when there is not enough to estimate it.
 *
 * NULL RATHER THAN ZERO AT n = 1. A single observation has no measurable
 * spread, and calling that spread zero is the same mistake as calling an
 * unpriced row free: it makes an interval collapse to a point, and a point
 * interval reads as certainty about a stratum we have seen once.
 *
 * CLAMPED AT ZERO FROM BELOW because the computational form subtracts two
 * large nearly-equal sums, which can land a hair under zero in binary floating
 * point for a stratum whose observations barely vary.
 */
export function accumVariance(accum: Accum): number | null {
  if (accum.n < 2) return null;
  const spread =
    (accum.sumsq - (accum.sum * accum.sum) / accum.n) / (accum.n - 1);
  return Math.max(0, spread);
}

/**
 * Coarse input-token buckets, in tokens.
 *
 * COARSE ON PURPOSE. Every extra stratum divides the same traffic into smaller
 * groups, and a per-stratum mean over three requests carries an interval wide
 * enough to be useless. Four boundaries give five buckets, which is as fine as
 * a day of one operator's traffic can support.
 */
const INPUT_BUCKETS: readonly number[] = Object.freeze([
  2_000, 8_000, 32_000, 128_000,
]);

const INPUT_BUCKET_NAMES: readonly string[] = Object.freeze([
  'xs',
  's',
  'm',
  'l',
  'xl',
]);

export function inputBucket(inputTokens: number): string {
  for (let index = 0; index < INPUT_BUCKETS.length; index += 1) {
    if (inputTokens < INPUT_BUCKETS[index]) return INPUT_BUCKET_NAMES[index];
  }
  return INPUT_BUCKET_NAMES[INPUT_BUCKET_NAMES.length - 1];
}

/**
 * The families whose output behaviour differs enough to stratify on.
 *
 * A FAMILY, NOT A MODEL ID. How much a model writes clusters by family far
 * more than by point release, and stratifying on the full id would put every
 * version bump in its own sparse group -- so the day a provider ships a new
 * build, every baseline would read as never seen.
 */
const MODEL_FAMILIES: readonly string[] = Object.freeze([
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'gpt',
  'gemini',
  'grok',
  'llama',
  'mistral',
  'qwen',
]);

export function modelFamily(model: string): string {
  const lowered = model.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (lowered.includes(family)) return family;
  }
  return 'other';
}

/**
 * How far into a conversation a request is, from the message count alone.
 *
 * OBSERVABLE BEFORE THE RESPONSE, which is the only rule a stratum feature has
 * to satisfy. It matters because a first turn and a fiftieth turn differ in how
 * much the model writes far more than either differs by model family, and
 * because our compression only has much to do once there is history to compress
 * -- so without this feature the treated and untreated groups would differ
 * mostly in conversation length and the estimate would read that as our effect.
 */
export function turnKind(messageCount: number): string {
  if (messageCount <= 1) return 'first';
  if (messageCount <= 8) return 'early';
  if (messageCount <= 32) return 'mid';
  return 'long';
}

/** The request-time features one request is compared within. */
export interface OutputStratum {
  readonly model: string;
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly hasTools: boolean;
}

/**
 * The stratum key, most specific field first.
 *
 * THE ORDER IS THE BACK-OFF ORDER. A baseline lookup that misses trims
 * trailing fields and tries again, so the fields are written least-dispensable
 * first: giving up the tools flag costs less than giving up the model family.
 */
export function stratumKey(features: OutputStratum): string {
  return [
    modelFamily(features.model),
    turnKind(features.messageCount),
    inputBucket(features.inputTokens),
    features.hasTools ? 'tools' : 'notools',
  ].join('|');
}

/**
 * Which arm a conversation is in, decided once and the same way every time.
 *
 * WHOLE CONVERSATIONS, NOT REQUESTS, for two reasons that happen to agree.
 * Statistically, alternating arms inside one conversation contaminates both: a
 * turn that follows a compressed turn is not an untreated turn, because the
 * history it inherits was already rewritten. Mechanically, changing whether we
 * rewrite the prefix part-way through a conversation invalidates the provider's
 * prefix cache for every remaining turn, which would cost the operator real
 * money to run the experiment -- the holdout would then be measuring partly its
 * own overhead.
 *
 * DERIVED, NOT STORED. The arm is a function of the conversation key and the
 * fraction, so there is no assignment table to keep, to bound, or to lose; a
 * proxy that restarts mid-conversation puts the conversation back in the arm it
 * was already in.
 *
 * DELEGATED TO `inHoldout`, AND THAT IS THE WHOLE POINT. The shaper already
 * decides this, and it decides it for real: a conversation it put in the
 * holdout went to the provider unshaped. A second hash here -- even a correct,
 * uniform, stable one -- would be a second opinion about a fact that has
 * already happened, and the ledger would then label some requests as controls
 * that were shaped and some as treated that were not. The comparison would be
 * between two arms neither of which existed. There is one assignment function
 * in this package and this is a reading of it, not a copy.
 *
 * ZERO MEANS NO EXPERIMENT. A holdout withholds a working optimizer from real
 * traffic, so the fraction defaults to none and every request is treated.
 */
export function assignArm(
  conversationKey: string | undefined,
  holdoutFraction: number
): OutputArm {
  return inHoldout(conversationKey, holdoutFraction)
    ? OUTPUT_ARM.Control
    : OUTPUT_ARM.Treatment;
}

/**
 * One tier's figure, with the words that say how far it can be trusted.
 *
 * `tokens` IS SIGNED. A positive figure is output we avoided and a negative one
 * is output we caused, and both are reported: an estimator that can only
 * produce good news is not an estimator.
 *
 * `interval` IS NULL WHEN IT CANNOT BE COMPUTED rather than collapsed to the
 * point estimate, because a zero-width band on a stratum seen once reads as
 * certainty. `pooledRequests` says how many requests borrowed their spread from
 * the pooled variance across strata, so a band that leans on that can be
 * discounted by the reader rather than quietly trusted.
 */
export interface OutputSavingsEstimate {
  readonly evidence: OutputEvidence;
  readonly tokens: number;
  readonly baselineTokens: number;
  readonly percent: number | null;
  readonly interval: { readonly lowPercent: number; readonly highPercent: number } | null;
  readonly requests: number;
  readonly strata: number;
  readonly pooledRequests: number;
}

/**
 * Per-stratum output-token observations for both arms, plus the observational
 * baseline the estimated tier compares against.
 *
 * THREE MAPS, NOT TWO. `control` holds the randomized holdout and `baseline`
 * holds the rows that simply were not compressed; they look alike and mean
 * different things, and merging them would let an observational mean be
 * reported under the word "measured".
 */
export interface OutputSavingsLedger {
  readonly baseline: Map<string, Accum>;
  readonly treatment: Map<string, Accum>;
  readonly control: Map<string, Accum>;
}

export function emptyOutputLedger(): OutputSavingsLedger {
  return { baseline: new Map(), treatment: new Map(), control: new Map() };
}

function bucket(into: Map<string, Accum>, key: string): Accum {
  let found = into.get(key);
  if (found === undefined) {
    found = emptyAccum();
    into.set(key, found);
  }
  return found;
}

/** Records one request's output tokens into the arm and stratum it belongs to. */
export function recordOutput(
  ledger: OutputSavingsLedger,
  arm: OutputArm,
  key: string,
  outputTokens: number
): void {
  observe(
    bucket(arm === OUTPUT_ARM.Treatment ? ledger.treatment : ledger.control, key),
    outputTokens
  );
}

/**
 * Records one uncompressed request into the observational baseline.
 *
 * SEPARATE ENTRY POINT FROM `recordOutput`, so the two cannot be confused at
 * the call site: a row reaches the baseline because nobody chose to leave it
 * alone, and reaches the control arm because somebody did.
 */
export function recordBaseline(
  ledger: OutputSavingsLedger,
  key: string,
  outputTokens: number
): void {
  observe(bucket(ledger.baseline, key), outputTokens);
}

/** Folds one ledger into another. Used to add a folded day back in. */
export function mergeOutputLedger(
  into: OutputSavingsLedger,
  from: OutputSavingsLedger
): void {
  for (const field of ['baseline', 'treatment', 'control'] as const) {
    for (const [key, accum] of from[field]) {
      mergeAccum(bucket(into[field], key), accum);
    }
  }
}

/**
 * A stratum's mean, with back-off when the exact stratum was never seen.
 *
 * TRIMS TRAILING FIELDS, which is why `stratumKey` orders them as it does: a
 * long conversation on an unseen model family is better compared against the
 * same family's other buckets than against nothing at all. Falling back keeps
 * the estimate defined at the cost of specificity, and the cost is disclosed by
 * `strata` in the result -- an estimate built mostly from back-off has fewer
 * contributing strata than requests.
 *
 * NULL WHEN EVEN THE POOL IS EMPTY, so a request with nothing to compare
 * against is dropped from the estimate rather than compared against zero.
 */
export function baselineFor(
  baseline: ReadonlyMap<string, Accum>,
  key: string
): Accum | null {
  const exact = baseline.get(key);
  if (exact !== undefined && exact.n > 0) return exact;
  const parts = key.split('|');
  while (parts.length > 1) {
    parts.pop();
    const prefix = `${parts.join('|')}|`;
    // MERGED ACROSS EVERY MATCHING STRATUM, not the first one found. Taking the
    // first would make the figure depend on map insertion order, so the same
    // rows would estimate differently depending on the order they arrived in.
    const pooled = emptyAccum();
    for (const [candidate, accum] of baseline) {
      if (candidate.startsWith(prefix)) mergeAccum(pooled, accum);
    }
    if (pooled.n > 0) return pooled;
  }
  return null;
}

/**
 * The spread to use for a stratum too small to have one of its own.
 *
 * WHY POOL RATHER THAN REFUSE. A stratum seen once has no measurable variance,
 * and the two obvious responses are both wrong: calling it zero fabricates
 * certainty, and refusing the whole interval throws away a usable band because
 * one small group exists. Pooling -- using the variance measured across every
 * stratum that does have one -- is the standard answer, it is conservative
 * here because the pooled spread includes between-stratum variation, and the
 * number of requests that leaned on it is reported so the reader can discount
 * the band accordingly.
 */
export function pooledVariance(
  groups: Iterable<Accum>
): number | null {
  let weighted = 0;
  let degrees = 0;
  for (const group of groups) {
    const spread = accumVariance(group);
    if (spread === null) continue;
    weighted += spread * (group.n - 1);
    degrees += group.n - 1;
  }
  return degrees > 0 ? weighted / degrees : null;
}

/** 1.96 standard errors: the 95% band under a normal approximation. */
const Z_95 = 1.96;

interface Contribution {
  /** Signed tokens this stratum contributes to the total. */
  readonly tokens: number;
  /** What the untreated side of this stratum would have produced. */
  readonly baselineTokens: number;
  /** This stratum's contribution to the variance of the total, or null. */
  readonly variance: number | null;
  readonly requests: number;
}

/**
 * Turns per-stratum contributions into one figure with its interval.
 *
 * THE INTERVAL IS ON THE TOKEN TOTAL AND THEN EXPRESSED AS A PERCENTAGE of the
 * same baseline the point estimate uses, so the band and the figure are
 * commensurable. A band computed on the percentage directly would have to treat
 * its denominator as exact, and the denominator is itself an estimate.
 *
 * A NULL VARIANCE ANYWHERE MAKES THE BAND NULL. One stratum whose spread could
 * not be estimated even from the pool means the total's variance is unknown,
 * not smaller -- and an interval that quietly omitted that stratum's
 * uncertainty would be narrower than the truth, which is the direction that
 * makes a reader more confident than the data allows.
 */
function finalize(
  evidence: OutputEvidence,
  contributions: readonly Contribution[],
  pooledRequests: number
): OutputSavingsEstimate {
  let tokens = 0;
  let baselineTokens = 0;
  let requests = 0;
  let variance: number | null = 0;
  for (const part of contributions) {
    tokens += part.tokens;
    baselineTokens += part.baselineTokens;
    requests += part.requests;
    if (part.variance === null) variance = null;
    else if (variance !== null) variance += part.variance;
  }
  const percent =
    baselineTokens > 0 ? (tokens / baselineTokens) * 100 : null;
  let interval: OutputSavingsEstimate['interval'] = null;
  if (variance !== null && baselineTokens > 0) {
    const error = Z_95 * Math.sqrt(variance);
    interval = {
      lowPercent: ((tokens - error) / baselineTokens) * 100,
      highPercent: ((tokens + error) / baselineTokens) * 100,
    };
  }
  return {
    evidence,
    tokens,
    baselineTokens,
    percent,
    interval,
    requests,
    strata: contributions.length,
    pooledRequests,
  };
}

/**
 * Tier 1: the output delta against rows nobody chose to leave uncompressed.
 *
 * THE ARITHMETIC. For each treated stratum s with n_s requests, observed mean
 * output ȳ_s and baseline mean µ_s over m_s rows, the contribution is
 * n_s·(µ_s − ȳ_s), and its variance is n_s·σ²_y,s + n_s²·σ²_µ,s/m_s -- the
 * spread of what we observed, plus the error in the baseline we compared it to.
 * The second term is the one an estimator is tempted to drop, and dropping it
 * would report a baseline built from four requests as confidently as one built
 * from four thousand.
 *
 * WHY THIS IS NOT CALLED A MEASUREMENT. The rows in the baseline are there
 * because compression declined to act on them -- the request was small, or the
 * body did not parse, or a refusal fired -- so the two groups differ in ways
 * besides the treatment, in an unknown direction. That is selection bias, not
 * noise, and no interval covers it. The word "estimated" travels with the
 * figure everywhere it is published.
 */
export function estimateFromBaseline(
  ledger: OutputSavingsLedger
): OutputSavingsEstimate {
  const pool = pooledVariance([
    ...ledger.treatment.values(),
    ...ledger.baseline.values(),
  ]);
  const contributions: Contribution[] = [];
  let pooledRequests = 0;
  for (const [key, observed] of ledger.treatment) {
    if (observed.n === 0) continue;
    const reference = baselineFor(ledger.baseline, key);
    if (reference === null || reference.n === 0) continue;
    const n = observed.n;
    const observedVariance = accumVariance(observed);
    const referenceVariance = accumVariance(reference);
    if (observedVariance === null || referenceVariance === null)
      pooledRequests += n;
    const spread = observedVariance ?? pool;
    const referenceSpread = referenceVariance ?? pool;
    contributions.push({
      tokens: n * (accumMean(reference) - accumMean(observed)),
      baselineTokens: n * accumMean(reference),
      variance:
        spread === null || referenceSpread === null
          ? null
          : n * spread + ((n * n) * referenceSpread) / reference.n,
      requests: n,
    });
  }
  return finalize(OUTPUT_EVIDENCE.Estimated, contributions, pooledRequests);
}

/**
 * Tier 2: the output delta against conversations we withheld compression from.
 *
 * ONLY STRATA PRESENT IN BOTH ARMS CONTRIBUTE. A treated stratum with no
 * control rows has no randomized comparison, and reaching for the observational
 * baseline to fill the gap would quietly turn the measured tier back into the
 * estimated one under the stronger word.
 *
 * NULL WHEN NO STRATUM QUALIFIES, which is the normal state: a holdout is
 * opt-in, so with none configured this tier has nothing to say and says
 * nothing. An empty estimate reading zero would publish "the holdout found no
 * output effect" for an experiment that was never run.
 *
 * WEIGHTED BY TREATED VOLUME, so the figure answers "what did compression do
 * to the output we actually billed for", rather than averaging a stratum of
 * three requests level with one of three thousand.
 */
export function estimateFromHoldout(
  ledger: OutputSavingsLedger
): OutputSavingsEstimate | null {
  const pool = pooledVariance([
    ...ledger.treatment.values(),
    ...ledger.control.values(),
  ]);
  const contributions: Contribution[] = [];
  let pooledRequests = 0;
  for (const [key, treated] of ledger.treatment) {
    const held = ledger.control.get(key);
    if (held === undefined || held.n === 0 || treated.n === 0) continue;
    const n = treated.n;
    const treatedVariance = accumVariance(treated);
    const heldVariance = accumVariance(held);
    if (treatedVariance === null || heldVariance === null) pooledRequests += n;
    const treatedSpread = treatedVariance ?? pool;
    const heldSpread = heldVariance ?? pool;
    contributions.push({
      tokens: n * (accumMean(held) - accumMean(treated)),
      baselineTokens: n * accumMean(held),
      // Var(ȳ_c − ȳ_t) = σ²_c/n_c + σ²_t/n_t, scaled by the n² the weighting
      // applies to the difference.
      variance:
        treatedSpread === null || heldSpread === null
          ? null
          : (n * n) * (heldSpread / held.n + treatedSpread / treated.n),
      requests: n,
    });
  }
  if (contributions.length === 0) return null;
  return finalize(OUTPUT_EVIDENCE.Measured, contributions, pooledRequests);
}

/**
 * Tier 3: the share of a response that restates text it was already shown.
 *
 * NOT A SAVING, AND NEVER ADDED TO ONE. There is no counterfactual here at
 * all: this is a property of one response against the context it was given,
 * and it stands on its own as a fact about waste. It is reported because it is
 * the only output figure that needs no estimate -- and because it is the thing
 * an output-side optimization would have to move, so publishing it now is what
 * makes any later claim checkable against a before.
 *
 * WORD N-GRAMS, which is deliberately crude: it is language-agnostic, costs one
 * pass over each side, and the quantity it reports -- "this much of the answer
 * was already on screen" -- does not need tokenizer-level precision to be
 * worth an operator's attention.
 *
 * ZERO WHEN THERE IS NOTHING TO COMPARE, never a divide by zero and never a
 * fabricated ratio from a response too short to contain one n-gram.
 */
export function echoRatio(
  outputText: string,
  contextText: string,
  size = 8
): number {
  if (size < 1) return 0;
  const out = outputText.split(/\s+/).filter((word) => word !== '');
  if (out.length < size) return 0;
  const context = contextText.split(/\s+/).filter((word) => word !== '');
  if (context.length < size) return 0;
  const seen = new Set<string>();
  for (let index = 0; index + size <= context.length; index += 1) {
    seen.add(context.slice(index, index + size).join(' '));
  }
  let hits = 0;
  let total = 0;
  for (let index = 0; index + size <= out.length; index += 1) {
    total += 1;
    if (seen.has(out.slice(index, index + size).join(' '))) hits += 1;
  }
  return total > 0 ? hits / total : 0;
}
