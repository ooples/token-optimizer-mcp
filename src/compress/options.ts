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
   * Above this many MESSAGES, a conversation we have never seen is left alone
   * rather than re-anchored.
   *
   * A message count, not a character count, and the distinction matters: a
   * first request can be enormous -- a large system prompt and a full tool
   * schema arrive before the user has said anything -- and it is still a
   * conversation seen from the start, where the prefix is written either way
   * and anchoring is free. Gating that on SIZE refused to anchor exactly the
   * requests where anchoring costs nothing. Default 4.
   */
  readonly coldMessageLimit?: number;
  /** Characters of graph findings allowed in the cached prefix. Default 2000. */
  readonly knowledgeBudgetChars?: number;
  /**
   * How many turns a conversation is ASSUMED to run, for the rewrite decision.
   *
   * A PRIOR, AND IT HAS TO BE ONE. Rewriting a cached prefix spends a 1.25x
   * write now to buy 0.1x reads later, so it repays only if enough turns
   * follow -- and turns REMAINING is the one quantity nothing in the request
   * can observe. The minimum share a rewrite must remove is
   * `1.25 / 0.1 / assumedSessionTurns`: at 100 that is 12.5%, at 13 it is 96%,
   * which is to say never.
   *
   * WHY NOT DERIVE IT FROM THE CONVERSATION INSTEAD. That was the obvious fix
   * and it is wrong. A threshold computed from turns-so-far necessarily differs
   * between two consecutive turns, so a conversation near the boundary declines
   * the rewrite on one turn and accepts it on the next -- and that flip is not
   * a small error, it re-sends the whole prefix at 1.25x instead of re-reading
   * it at 0.1x. Implemented and measured: it broke the proof's STEADY gate on
   * three of six workloads, re-anchoring COSTING tokens on code-search (1066 vs
   * 871), sre-debugging (2139 vs 1795) and raw-build-log (17936 vs 15949).
   *
   * So the length-awareness lives here, fixed for the life of a proxy like
   * every other dial, rather than in a decision that can change under a
   * conversation. Measured justification for moving it: THOL's tasks run 6-27
   * turns and lose money on cache writes below about 13, while this project's
   * own session transcripts run 184-2,319. A workload should say which it is.
   *
   * Default 100.
   */
  readonly assumedSessionTurns?: number;
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
  /**
   * Below this saving, move the whole block out of the request instead.
   *
   * SUBSTITUTION, NOT REDUCTION, and the name of this dial is the only place
   * that can say so before somebody reads a 99% off a table. A block that our
   * engines could only take 50% off is not made smaller by this; it is taken
   * out of the request and replaced by `[... n bytes -> path]`, and the bytes
   * are on disk. The ratio that produces is a measurement of a move.
   *
   * WHY HAVE IT AT ALL. It is what HeadRoom's content-cache references do for
   * every block they touch, which is where their ~99.7% on `grep-output`,
   * `raw-build-log` and `codebase-exploration` comes from -- their
   * `<<ccr:hash,blob,32107>>` is 24 characters and the content is in a store.
   * Ours is better on the only axis that matters after the ratio: the marker
   * carries a path the agent already has, so following it is a `Read` it can
   * issue itself, where a cache reference costs a retrieval round trip and
   * degrades to `[unresolved: entry not found]` when the store has moved on.
   *
   * WHY IT IS OFF BY DEFAULT. Because the trade is real and it is ours to lose:
   * measured over the twelve head-to-head workloads, 1,274 of the 1,582
   * identifiers a reader can rebuild from the output alone are in exactly the
   * three blocks this would move. On by default, the product would be their
   * product with a better marker. Off by default, it is a dial for a caller who
   * has decided that a small context matters more to them than a readable one.
   *
   * Expressed as the saving an engine had to reach to keep its block: 0.9 spills
   * anything the engines could not take 90% off. 0 -- the default -- never
   * spills, and no existing measurement moves. 1 is the like-for-like against a
   * content cache, which moves every block it touches whatever its shape; at
   * that setting the engines are not run at all, since nothing they produced
   * could be kept and their spill files would only be superseded.
   */
  readonly spillWholeBlockBelow?: number;
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
  assumedSessionTurns: 100,
  allowLossy: true,
  spillWholeBlockBelow: 0,
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
    assumedSessionTurns: pick('assumedSessionTurns'),
    allowLossy: pick('allowLossy'),
    spillWholeBlockBelow: pick('spillWholeBlockBelow'),
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
