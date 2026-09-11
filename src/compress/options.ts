/**
 * Expert presets, fully overridable.
 *
 * WHY THIS EXISTS AT ALL, given that every constant it exposes already had a
 * measured default. Because the defaults were measured against THIS
 * repository's workloads, and the person running it is not always doing what
 * those workloads do. Somebody triaging an incident wants every exception line
 * kept whatever it costs; somebody paging through a monorepo wants the smallest
 * request that still answers the question; somebody in a regulated review
 * cannot accept a lossy elision at all. Those are three different settings of
 * the same dials, and hardcoding one of them makes the other two impossible.
 *
 * NULLABLE, WITH THE DEFAULT APPLIED INTERNALLY. Every field is optional and
 * `undefined` means "use your best judgement", not "use zero" -- the
 * convention this codebase already follows for infrastructure configuration.
 * That way a caller supplies only the dial it cares about, and a default can be
 * improved later without breaking anybody who never set it.
 *
 * A PRESET IS A STARTING POINT, NEVER A CEILING. `resolveTuning` layers the
 * caller's own values over the preset, so "aggressive, but keep six head rows"
 * is expressible. An expert who knows their content beats our heuristics, and a
 * configuration system that does not let them say so is decoration.
 *
 * THE VALUES HERE ARE NOT INVENTED. `balanced` is exactly what the engines used
 * before this file existed, so the default path is unchanged to the token, and
 * every benchmark figure recorded against those defaults still stands. The
 * other presets move the same dials in one direction, and their justification
 * is the direction rather than any claim about the specific numbers.
 */

/** Every dial, all optional. Absent means the resolved default applies. */
export interface CompressionOptions {
  /** Rows kept at the head of a long JSON array, for shape. Default 3. */
  readonly keepRows?: number;
  /** Below this many rows an array is left whole. Default 6. */
  readonly minRowsToElide?: number;
  /** Fraction of prose sentences kept. Default 0.5. */
  readonly keepSentenceFraction?: number;
  /** Smallest function body worth replacing with a marker, in lines. Default 2. */
  readonly minBodyLines?: number;
  /**
   * Share of a file's bodies that may be kept as "live" before the question is
   * judged too broad to be evidence about any of them. Default 0.5.
   */
  readonly maxLiveShare?: number;
  /** Repeated lines needed before a log run folds. Default 3. */
  readonly minRun?: number;
  /** Smallest repeated block worth a back-reference, in bytes. Default 600. */
  readonly minDedupBytes?: number;
  /**
   * Above this many characters of cached prefix, a conversation we have never
   * seen is left alone rather than re-anchored. Default 20000.
   */
  readonly coldMessageLimit?: number;
  /** Characters of graph findings allowed in the cached prefix. Default 2000. */
  readonly knowledgeBudgetChars?: number;
  /**
   * May an engine remove something it cannot reconstruct from the output?
   *
   * THE ONE DIAL THAT IS NOT A NUMBER, and the one some users actually need.
   * False forbids every lossy transform -- function bodies, array tails,
   * lower-signal prose -- leaving only the transforms whose output fully
   * determines what was removed: whitespace, null keys, folded duplicates with
   * their timestamps listed, repeated path prefixes, and back-references to
   * content still in the request. The reduction is much smaller and every byte
   * of it is recoverable from what the model can see. Default true.
   */
  readonly allowLossy?: boolean;
}

/** The same shape with nothing left to decide. */
export type Tuning = Required<CompressionOptions>;

/**
 * The measured defaults, which are also the `balanced` preset.
 *
 * Changing a number here changes every benchmark figure in the repository, so
 * it is a measurement, not a preference.
 */
export const DEFAULT_TUNING: Tuning = Object.freeze({
  keepRows: 3,
  minRowsToElide: 6,
  keepSentenceFraction: 0.5,
  minBodyLines: 2,
  maxLiveShare: 0.5,
  minRun: 3,
  minDedupBytes: 600,
  coldMessageLimit: 4,
  knowledgeBudgetChars: 2000,
  allowLossy: true,
});

export type PresetName =
  | 'balanced'
  | 'aggressive'
  | 'conservative'
  | 'lossless';

/**
 * Named starting points.
 *
 * Each is a direction, not a discovery. `balanced` is the measured default;
 * the others move the same dials one way and say why in a sentence, because a
 * preset whose reasoning is not written down is a magic number with a name.
 */
export const PRESETS: Readonly<
  Record<PresetName, Readonly<CompressionOptions>>
> = Object.freeze({
  /** What the engines have always done. Every published figure is this. */
  balanced: Object.freeze({}),

  /**
   * Smallest request that still answers the question.
   *
   * For long exploratory sessions over large codebases, where the binding
   * constraint is the context window rather than any single answer. Keeps less
   * of everything and starts eliding sooner.
   */
  aggressive: Object.freeze({
    keepRows: 1,
    minRowsToElide: 3,
    keepSentenceFraction: 0.3,
    minBodyLines: 1,
    minDedupBytes: 300,
  }),

  /**
   * Keeps more, elides later.
   *
   * For incident work, where the line you dropped is the one you needed and a
   * larger request is cheaper than a second round trip to find it again.
   */
  conservative: Object.freeze({
    keepRows: 8,
    minRowsToElide: 20,
    keepSentenceFraction: 0.75,
    minBodyLines: 6,
    minDedupBytes: 2000,
  }),

  /**
   * Nothing is removed that the output does not fully describe.
   *
   * For review, audit and regulated work, where "the model can Read the path"
   * is not an acceptable answer. Compresses far less, and every byte of it is
   * reconstructable from what the model was sent.
   */
  lossless: Object.freeze({ allowLossy: false }),
});

/**
 * Fills in the blanks: caller's values over the preset, preset over defaults.
 *
 * Unknown preset names resolve to `balanced` rather than throwing. A typo in a
 * configuration string should not take down a proxy whose entire design is to
 * fail open -- and the shipped behaviour is the one a typo lands on.
 */
export function resolveTuning(
  options: CompressionOptions = {},
  preset: PresetName | string | undefined = 'balanced'
): Tuning {
  const base =
    (PRESETS as Record<string, CompressionOptions | undefined>)[
      String(preset ?? 'balanced')
    ] ?? PRESETS.balanced;

  const pick = <K extends keyof Tuning>(key: K): Tuning[K] =>
    (options[key] ?? base[key] ?? DEFAULT_TUNING[key]) as Tuning[K];

  return {
    keepRows: pick('keepRows'),
    minRowsToElide: pick('minRowsToElide'),
    keepSentenceFraction: pick('keepSentenceFraction'),
    minBodyLines: pick('minBodyLines'),
    maxLiveShare: pick('maxLiveShare'),
    minRun: pick('minRun'),
    minDedupBytes: pick('minDedupBytes'),
    coldMessageLimit: pick('coldMessageLimit'),
    knowledgeBudgetChars: pick('knowledgeBudgetChars'),
    allowLossy: pick('allowLossy'),
  };
}

/**
 * The preset named by the environment, for the proxy.
 *
 * One variable, because a proxy is started by a launcher and nobody is going to
 * pass a config object to it. Expert overrides go through the library.
 */
export function presetFromEnv(env: NodeJS.ProcessEnv): PresetName {
  const raw = String(env.TOKEN_OPTIMIZER_COMPRESSION ?? '')
    .trim()
    .toLowerCase();
  return raw in PRESETS ? (raw as PresetName) : 'balanced';
}
