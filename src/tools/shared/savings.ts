/**
 * How a tool is allowed to say what it saved.
 *
 * Across this codebase, savings were being derived by multiplying the RESULT by
 * a constant -- 100x, 50x, 25x, 20x, 18x, 17x, 16x, 15x, 12x, 11x, 10x, 9x,
 * 8.5x, 8x, 7x, 6.5x, 5x, 3x, 2.5x -- and reporting the difference as tokens
 * saved. smart_user alone used eight different multipliers, which is the
 * clearest possible evidence that none of them were measured. Those numbers
 * flowed into the metrics collector and the optimization report, so the
 * headline figure a user was shown was partly invented.
 *
 * An overstated saving is the one number this project must never produce. So
 * there is exactly one way to report one, and it takes two MEASURED
 * quantities: what the alternative would have cost, and what was actually
 * returned.
 *
 * When a tool genuinely has no measured baseline -- a cache hit that never
 * recorded what the original computation cost -- the honest answer is
 * `unmeasured()`, which claims nothing. Understating is the safe direction to
 * be wrong in; overstating is the one that makes the product a lie.
 *
 * A LOSS IS A MEASUREMENT TOO. This helper used to raise `originalTokenCount`
 * to the size of the response whenever the response came out larger, so that
 * `tokensSaved` could never go negative. That bought a non-negative saving by
 * printing a baseline nobody had measured -- the same invention this module
 * exists to prevent, and it hid the outcome that matters most: a tool whose
 * report costs more than the thing it replaced. The core primitive it sits on,
 * TokenCounter.calculateSavings, has always reported that case as a negative,
 * and so does this one now.
 */

import { isAbsolute } from 'node:path';

/**
 * Places a reported ratio is rounded to.
 *
 * The division ran to full double precision and was serialised in full:
 * 0.7630331753554502, which cost 12 tokens in a 75-token metadata block --
 * more than any other field, to state a ratio between two integers to 16
 * digits. Nothing downstream reads past the fourth.
 */
const RATIO_DECIMALS = 4;

function ratio(tokenCount: number, originalTokenCount: number): number {
  if (originalTokenCount <= 0) {
    return 1;
  }
  return Number((tokenCount / originalTokenCount).toFixed(RATIO_DECIMALS));
}

export interface Savings {
  /** Tokens the alternative would have cost. Measured, never assumed. */
  originalTokenCount: number;
  /** Tokens actually returned to the caller. */
  tokenCount: number;
  /**
   * originalTokenCount - tokenCount. NEGATIVE when the response cost more than
   * the alternative it replaced, which is reported rather than clamped.
   */
  tokensSaved: number;
  /**
   * tokenCount / originalTokenCount, guarded against a zero baseline and
   * rounded to {@link RATIO_DECIMALS} places.
   */
  compressionRatio: number;
}

/**
 * A saving computed from two real measurements.
 *
 * @param baselineTokens what the caller would have paid without this tool,
 *   measured from something that actually exists: the file that would have been
 *   read, the raw output that was received, the rows that were filtered out.
 * @param returnedTokens what the response actually costs.
 */
export function measured(
  baselineTokens: number,
  returnedTokens: number
): Savings {
  const tokenCount = Math.max(0, Math.round(returnedTokens) || 0);
  // Reported as measured. A baseline below what was returned means the tool
  // cost the caller more than doing without it, and the difference is that
  // loss -- summing it downstream gives a true net, where clamping each term
  // at zero gave a total that could only ever look like a win.
  const originalTokenCount = Math.max(0, Math.round(baselineTokens) || 0);

  return {
    originalTokenCount,
    tokenCount,
    tokensSaved: originalTokenCount - tokenCount,
    compressionRatio: ratio(tokenCount, originalTokenCount),
  };
}

/**
 * No baseline was measured, so nothing is claimed.
 *
 * Used where a tool returns a cached value without knowing what producing it
 * originally cost. The response still reports its own size honestly.
 */
export function unmeasured(returnedTokens: number): Savings {
  const tokenCount = Math.max(0, Math.round(returnedTokens) || 0);
  return {
    originalTokenCount: tokenCount,
    tokenCount,
    tokensSaved: 0,
    compressionRatio: 1,
  };
}

/**
 * WHAT A TOOL IS ALLOWED TO SAY ABOUT ITS OWN SAVING: the before, and nothing
 * else.
 *
 * `measured()` above asks a tool for both halves of its own ratio, and across
 * this fleet the second half was never the figure that reached the caller.
 * Measured over 37 bench readings: `smart_dependencies` published
 * `originalTokenCount: 0, tokensSaved: -11` on calls that really avoided 63.5%
 * and 98.2%; `smart_tsconfig` published `savingsPercent: 8.21` where the wire
 * said -2.9%; `smart_package_json` printed a `-92%` footer against a real
 * -20.9%; `smart_security` printed one flat 85% for three fixtures whose real
 * figures were 98.0%, 97.1% and 92.3%. None of those were lies about the
 * baseline. Every one was a tool counting an INTERNAL object -- a graph, a
 * compacted config, a findings array -- and calling it the response, when what
 * the caller pays for is the serialised reply with its report text and its
 * metadata around it. A tool cannot see that text: it is produced after the
 * tool returns.
 *
 * So the after is measured once, at the wire, by the party that holds it, and
 * a tool declares only the before -- the half that genuinely is its own
 * knowledge, because it read the file, received the raw output, or was handed
 * the code inline.
 *
 * NO ARITHMETIC HERE ON PURPOSE. A declaration with no second operand cannot
 * be wrong about the first, and there is no ratio to drift.
 */
export interface DisplacedBaseline {
  /** Tokens the caller would have paid without this tool. Measured. */
  readonly baselineTokens: number;
  /** What was counted to get there, so a reader can check the claim. */
  readonly baselineSource: BaselineSource;
}

/**
 * The kinds of before a tool in this fleet can actually measure.
 *
 * A UNION RATHER THAN FREE TEXT so the set stays reviewable: every member is
 * something that exists and can be counted, and adding a member is a decision
 * someone has to make rather than a string someone can type.
 */
export type BaselineSource =
  /** The file or files the caller's own arguments named. */
  | 'named-input-files'
  /** A file the tool located from a directory the caller named. */
  | 'resolved-project-file'
  /** Every file in a resolved `extends` chain, not just the entry point. */
  | 'resolved-config-chain'
  /** Text the caller passed inline, which exists nowhere on disk. */
  | 'inline-input'
  /** Raw output of a command this tool ran and then summarised. */
  | 'captured-command-output';

/**
 * Declare what this tool stood in for.
 *
 * A NON-POSITIVE BASELINE IS NOT A DECLARATION. Zero is what produced
 * `tokensSaved: -11` for a tool that avoided 63% of a file read: a baseline
 * nobody managed to measure, published as though it had been measured and
 * found to be nothing. It reads back as null so a missing before stays
 * missing.
 */
export function displaced(
  baselineTokens: number,
  baselineSource: BaselineSource
): DisplacedBaseline | null {
  const tokens = Math.round(baselineTokens) || 0;
  if (tokens <= 0) return null;
  return { baselineTokens: tokens, baselineSource };
}

/**
 * WHAT A TOOL IS ALLOWED TO SAY WHEN IT CAN NAME THE FILES INSTEAD: the paths,
 * and let the recorder count them.
 *
 * `DisplacedBaseline` above is the weaker of the two declarations, because the
 * number in it is the tool's own and has to be taken on trust. It is still the
 * only thing available to a tool handed code inline or summarising a command's
 * output -- there is no file for anyone else to read. But most of the tools
 * that needed a declaration at all needed it for the opposite reason: the file
 * exists and is perfectly readable, the caller's arguments just do not name it.
 * smart_package_json is passed a `projectRoot` and joins `package.json` onto
 * it; smart_tsconfig is passed one config and walks an `extends` chain through
 * several more.
 *
 * For those, naming the paths is strictly better than naming a count. The
 * recorder reads them with the same reader and counts them with the same
 * counter it uses for the reply, so no tool arithmetic enters the ratio at all,
 * the bytes and the digest come out measurable too, and the figure can be
 * re-derived later from the row. It also needs no precedence rule: a tool's
 * resolved paths and the caller's named paths are one set of files, measured
 * once, rather than two competing befores.
 */
export interface ResolvedInputFiles {
  /**
   * Absolute paths of the files this tool read that the arguments did not name.
   *
   * ABSOLUTE BECAUSE THE READER IS SOMEWHERE ELSE. The recorder resolves a
   * relative path against its own working directory, which is not necessarily
   * the tool's, and would then measure a different file -- or, worse, a file
   * that happens to exist there. A tool has already resolved these paths to
   * read them, so it has the absolute form to hand.
   */
  readonly paths: readonly string[];
  /** How the tool got to them, so a reader can check the claim. */
  readonly baselineSource: BaselineSource;
}

/**
 * The most files one declaration may name.
 *
 * Matches the recorder's own cap: a longer list is refused there anyway, and
 * refusing it here means the reason is visible at the tool rather than as a
 * silently unmeasured row.
 */
const MAX_DECLARED_PATHS = 24;

/** Rejects a NUL, CR or LF, which no real path on either platform contains. */
const DECLARABLE_PATH = /^[^\u0000\n\r]+$/;

/**
 * Declare the files this tool resolved and read.
 *
 * Returns null rather than an empty declaration when there is nothing usable,
 * for the same reason `displaced()` does: a declaration that claims nothing
 * must read as absent and not as a measured nothing.
 */
export function resolvedFiles(
  paths: readonly string[],
  baselineSource: BaselineSource
): ResolvedInputFiles | null {
  const usable = paths.filter(
    (path) =>
      typeof path === 'string' && isAbsolute(path) && DECLARABLE_PATH.test(path)
  );
  if (usable.length === 0 || usable.length > MAX_DECLARED_PATHS) return null;
  return { paths: usable, baselineSource };
}

/**
 * The key the resolved-path declaration travels on.
 *
 * A SECOND KEY RATHER THAN A UNION ON THE FIRST. The two declarations are read
 * by different code -- one is a number the recorder has to decide whether to
 * trust, the other is a list of files the recorder goes and measures -- and a
 * tool uses exactly one of them, so keeping them apart means neither branch
 * has to ask which kind it got.
 */
export const RESOLVED_INPUT_KEY = '__resolvedInputFiles';

/**
 * CHECKED EVERY TIME IT CROSSES A BOUNDARY, as `asDeclaredBaseline` is.
 *
 * What arrives here is about to be turned into file reads, so the paths are
 * re-tested against the same rules `resolvedFiles` applied rather than trusted
 * because they came in on a reserved key.
 */
export function asResolvedInputFiles(raw: unknown): ResolvedInputFiles | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = record.baselineSource;
  if (typeof source !== 'string') return null;
  if (!BASELINE_SOURCES.includes(source as BaselineSource)) return null;
  if (!Array.isArray(record.paths)) return null;
  return resolvedFiles(
    record.paths.filter((path): path is string => typeof path === 'string'),
    source as BaselineSource
  );
}

/**
 * The key a tool hangs its declaration on, and the only one the dispatch lifts.
 *
 * WHY A RESERVED KEY AND NOT A FIELD IN THE REPLY. The declaration exists so a
 * row on disk can say what the call stood in for; it is not information the
 * caller asked for, and a figure in the reply is a figure the caller pays for
 * and a model may quote. So it travels on the result object, is removed before
 * the text is serialised, and is carried the rest of the way in `_meta`, which
 * never enters the text that gets counted.
 */
export const DECLARED_BASELINE_KEY = '__displacedBaseline';

/**
 * A result object that may be carrying a declaration.
 *
 * The key is optional because declaring is: most tools in this fleet name
 * their input files in the arguments, so the recorder measures the before for
 * itself and the tool has nothing to add.
 */
export type Declaring<T> = T & {
  readonly [DECLARED_BASELINE_KEY]?: DisplacedBaseline | null;
  readonly [RESOLVED_INPUT_KEY]?: ResolvedInputFiles | null;
};

/**
 * Where a string-returning tool's text travels so a declaration can ride with
 * it.
 *
 * HALF THIS FLEET RETURNS A STRING, and a string has nowhere to hang a
 * property. The alternative was to put the baseline in the report text, which
 * is exactly the thing this module exists to stop: a figure in the text is a
 * figure the caller pays for and a model may quote. So the text moves into a
 * one-key envelope for the length of the dispatch and is taken back out
 * before it is serialised -- the caller sees the same string either way.
 */
export const DECLARED_TEXT_KEY = '__declaredText';

/**
 * Attach a declaration to a report that is just text.
 *
 * Returns the string unchanged when there is nothing to declare, so a tool
 * that could not measure its before stays exactly as cheap as it was.
 */
export function declaringText(
  text: string,
  declaration: DisplacedBaseline | ResolvedInputFiles | null
): string | Record<string, unknown> {
  if (!declaration) return text;
  // The two declarations ride on their own keys, so the branch that reads each
  // one never has to ask which kind arrived.
  const key =
    'paths' in declaration ? RESOLVED_INPUT_KEY : DECLARED_BASELINE_KEY;
  return { [DECLARED_TEXT_KEY]: text, [key]: declaration };
}

/**
 * Take the declaration off a tool's result, leaving the payload the caller sees.
 *
 * The payload is rebuilt without the key rather than deleted from in place: a
 * tool may hand back a frozen object, and a tool that returns a string -- half
 * this fleet does -- has nowhere to put a key and simply declares nothing.
 */
export function liftDeclarations(result: unknown): {
  readonly payload: unknown;
  readonly declaration: DisplacedBaseline | null;
  readonly resolved: ResolvedInputFiles | null;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { payload: result, declaration: null, resolved: null };
  }
  const record = result as Record<string, unknown>;
  if (!(DECLARED_BASELINE_KEY in record) && !(RESOLVED_INPUT_KEY in record)) {
    return { payload: result, declaration: null, resolved: null };
  }
  const {
    [DECLARED_BASELINE_KEY]: rawBaseline,
    [RESOLVED_INPUT_KEY]: rawResolved,
    ...payload
  } = record;
  const declaration = asDeclaredBaseline(rawBaseline);
  const resolved = asResolvedInputFiles(rawResolved);
  // THE ENVELOPE COMES OFF HERE, not at the serialiser: a tool that declared
  // alongside a text report put its string inside one, and what the caller is
  // given has to be that string and not an object wrapping it.
  const keys = Object.keys(payload);
  if (keys.length === 1 && keys[0] === DECLARED_TEXT_KEY) {
    const text = payload[DECLARED_TEXT_KEY];
    if (typeof text === 'string')
      return { payload: text, declaration, resolved };
  }
  return { payload, declaration, resolved };
}

/**
 * CHECKED EVERY TIME IT CROSSES A BOUNDARY, NOT TRUSTED ONCE. `displaced()` is the only sanctioned
 * producer, but the key is a plain property on a plain object, so whatever
 * arrives here is re-tested against the same rules before it is allowed to
 * reach a stored row.
 */
export function asDeclaredBaseline(raw: unknown): DisplacedBaseline | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = record.baselineSource;
  if (typeof source !== 'string') return null;
  if (!BASELINE_SOURCES.includes(source as BaselineSource)) return null;
  return displaced(Number(record.baselineTokens), source as BaselineSource);
}

/** The runtime half of `BaselineSource`, so the union can be checked. */
const BASELINE_SOURCES: readonly BaselineSource[] = [
  'named-input-files',
  'resolved-project-file',
  'resolved-config-chain',
  'inline-input',
  'captured-command-output',
];
