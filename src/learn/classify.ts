/**
 * Reading a failure and saying what kind it is.
 *
 * A CATEGORY IS A PROMISE THAT A RULE CAN BE WRITTEN. "This failed" teaches
 * nothing; "this failed because the path does not exist, 14 times, always under
 * the same directory" is a line worth putting in an instructions file. So the
 * patterns here are deliberately narrow: each one recognises wording a tool
 * actually emits, and anything else stays Unknown and is counted as such rather
 * than guessed at.
 *
 * These run over other people's build output, which is exactly the input a
 * catastrophic backtrack is found by, and a JavaScript regex cannot be given a
 * timeout to stop one. So the input is bounded instead -- classification reads a
 * fixed head of the output, never the whole thing -- and every pattern below is
 * kept free of a quantifier inside a quantifier. A bound the caller cannot exceed
 * is the only guarantee available here; a timeout constant would be decoration.
 */

import { FailureCategory } from './models.js';

/**
 * How much of an output is examined.
 *
 * A failure says why it failed at the top and then prints a stack, a diff or ten
 * thousand lines of a test run. Reading the first slice is not an optimisation:
 * matching the whole thing finds the word "error" somewhere in every long output
 * and classifies by whatever appeared last.
 */
const HEAD_BYTES = 2000;

interface Rule {
  readonly category: FailureCategory;
  readonly pattern: RegExp;
}

/**
 * Order matters and is the substance of this file.
 *
 * "No such file or directory" appears inside plenty of build failures, so the
 * more specific reading wins where both could match: a test that failed is a test
 * failure even though its output also says "exit code 1".
 */
const RULES: readonly Rule[] = [
  // `Blocked:` and "doesn't want to proceed" are how a refusal actually reaches a
  // transcript. The wording below them is what an SDK writes, and one machine only
  // ever produces one of the two, so matching only the SDK's left the single most
  // actionable failure there is -- a call already refused once -- reading as unknown.
  {
    category: FailureCategory.UserRejected,
    pattern:
      /(\bBlocked:|does ?n.t want to proceed|\buser (?:rejected|denied|declined)|operation was (?:aborted|rejected) by|(?:permission (?:request )?)?denied by the user|rejected by the user)/i,
  },
  {
    category: FailureCategory.Timeout,
    pattern:
      /\b(timed? ?out|timeout after|exceeded the timeout|ETIMEDOUT|deadline exceeded)\b/i,
  },
  {
    category: FailureCategory.OutOfMemory,
    pattern:
      /\b(out of memory|OutOfMemoryException|heap out of memory|Cannot allocate memory|ENOMEM|Killed)\b/,
  },
  {
    category: FailureCategory.ModuleNotFound,
    pattern:
      /\b(Cannot find module|ModuleNotFoundError|MODULE_NOT_FOUND|Could not resolve|Unable to resolve|ImportError)\b/i,
  },
  {
    category: FailureCategory.CommandNotFound,
    pattern:
      /(command not found|is not recognized as (?:an internal|the name)|CommandNotFoundException|\bENOENT\b.*spawn|No such file or directory: '[^'/\\]+')/i,
  },
  {
    category: FailureCategory.PermissionDenied,
    pattern:
      /\b(EACCES|EPERM|permission denied|access is denied|UnauthorizedAccessException|Operation not permitted)\b/i,
  },
  {
    category: FailureCategory.FileTooLarge,
    pattern:
      /(\bEFBIG\b|file (?:is )?too large|exceeds maximum allowed|maximum allowed tokens|too large to read|results are too long)/i,
  },
  {
    category: FailureCategory.IsDirectory,
    pattern: /\b(EISDIR|is a directory|Is a directory)\b/,
  },
  {
    category: FailureCategory.StringNotFound,
    pattern:
      /(String to replace not found|old_string not found|not found in (?:the )?file|No replacement was made|string_not_found)/i,
  },
  {
    category: FailureCategory.NoMatches,
    pattern:
      /(no (?:files? )?(?:matches?|matching files?) found|no results found|0 matches|found 0 files|pattern did not match)/i,
  },
  {
    category: FailureCategory.FileNotFound,
    pattern:
      /\b(ENOENT|No such file or directory|does not exist|cannot find (?:the )?(?:path|file)|FileNotFoundError|could not be found)\b/i,
  },
  {
    category: FailureCategory.ConnectionError,
    pattern:
      /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|connection (?:refused|reset|timed out)|failed to connect|could not connect|could not resolve host|network is unreachable|EHOSTUNREACH|ENETUNREACH|SSL|certificate)\b/i,
  },
  {
    category: FailureCategory.TestFailure,
    pattern:
      /(\b\d+ (?:tests? )?failed\b|Tests?:\s+\d+ failed|FAIL\s+\S+|assertion (?:failed|error)|Expected .* (?:but )?(?:received|got)|AssertionError)/,
  },
  // A COMPILER CODE IS NOT A SYNTAX ERROR. `CS\d{4}` and `TS\d{4}` cover every
  // diagnostic those two compilers emit -- a missing reference, a nullability
  // warning promoted to an error, an unused variable -- so matching them here filed
  // the whole of a failed build under syntax. The build rule below claims them.
  {
    category: FailureCategory.SyntaxError,
    pattern:
      /\b(SyntaxError|ParseError|Unexpected token|unterminated|missing (?:the )?terminator|is not valid JSON)\b/,
  },
  {
    category: FailureCategory.BuildFailure,
    pattern:
      /(\berror\s+(?:CS|TS|MSB|LNK)\d+|Build FAILED|compilation (?:failed|error)|make: \*\*\*|error\[E\d+\])/i,
  },
];

/**
 * A tool refusing its own arguments, which is the one failure that is always a
 * habit rather than an accident.
 *
 * It sits below the RULES array on purpose: it is checked after them, because
 * "requires" and "did you mean" also appear inside the output of a build that
 * failed for its own reasons, and the more specific categories should win.
 */
const INVALID_ARGUMENTS =
  /\b(?:requires?|does not accept|unknown (?:option|parameter|argument|field)|unrecognized (?:option|argument)|missing required|invalid (?:input|argument|parameter|value for)|expected .{0,20}(?:but (?:got|received))|did you mean)\b/i;

/** The exit-code line a shell failure ends up with when nothing else matched. */
const EXIT_CODE =
  /(?:^|\n)\s*(?:exit(?:ed with)? code|Command exited with)\s*:?\s*([0-9]+)/i;

function test(pattern: RegExp, text: string): boolean {
  // None of the rules carry /g, so there is no lastIndex to leak between calls
  // and the pattern objects above are safe to share.
  return pattern.test(text);
}

/**
 * Classify one failed tool call.
 *
 * `toolName` is used only where the same wording means different things to
 * different tools -- a search tool returning nothing is a "no matches", the same
 * words from an edit tool are a missing file.
 */
export function classifyFailure(
  toolName: string,
  output: string
): FailureCategory {
  const head =
    output.length > HEAD_BYTES ? output.slice(0, HEAD_BYTES) : output;
  if (head.trim().length === 0) return FailureCategory.Unknown;
  for (const rule of RULES) {
    if (test(rule.pattern, head)) return rule.category;
  }
  if (test(EXIT_CODE, head)) return FailureCategory.ExitCode;
  if (test(INVALID_ARGUMENTS, head)) return FailureCategory.InvalidArguments;
  // A search tool that failed with nothing to say found nothing. Every other
  // tool's silence is genuinely unexplained and is left that way.
  if (/^(grep|glob|search|smart_grep|smart_glob)$/i.test(toolName)) {
    return FailureCategory.NoMatches;
  }
  return FailureCategory.Unknown;
}

/** How much of an output classification looks at, exported for the same reason. */
export const classifyHeadBytes = HEAD_BYTES;

/** A line that only restates that the call failed, which every failure did. */
const SAYS_NOTHING =
  /^(?:(?:exit(?:ed with)? code|command exited with(?: code)?)\s*:?\s*[0-9]+\.?|error|exception|traceback|failed|<stderr>|<empty>)\s*:?$/i;

/**
 * The first meaningful line of a failure, for showing as evidence.
 *
 * A SHELL FAILURE LEADS WITH "Exit code 1", AND THAT IS NOT THE EVIDENCE. Measured
 * on real transcripts, taking the first non-empty line made every one of 175 shell
 * failures read "Exit code 1" -- the detail restated the category and the actual
 * message sat on the next line, unread. So the lines that only say "this failed"
 * are stepped over, and one of them is returned only when it is all there was.
 */
export function failureDetail(output: string, limit = 160): string {
  const head = output.slice(0, HEAD_BYTES);
  let first = '';
  let restated = '';
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (SAYS_NOTHING.test(line)) {
      if (restated.length === 0) restated = line;
      continue;
    }
    // A LINE THAT READS LIKE AN ERROR BEATS THE FIRST LINE. A shell tool hands back
    // the command's whole output, stdout and stderr in the order they happened, so
    // the first line of a failed run is usually the successful start of it. Quoting
    // that as the reason produced evidence like `python` failed, saying: "===== [1]"
    // -- a true count with a quotation that pointed away from the cause.
    if (LOOKS_LIKE_ERROR.test(line)) return clip(line, limit);
    if (first.length === 0) first = line;
  }
  if (first.length > 0) return clip(first, limit);
  return restated;
}

/** Wording that means something went wrong, wherever in the output it turns up. */
const LOOKS_LIKE_ERROR =
  /\b(?:error|exception|traceback|fatal|no such file|not found|cannot find|cannot access|is denied|permission denied|refused|failed to|timed out|unrecognized|unexpected)\b/i;

function clip(line: string, limit: number): string {
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}
