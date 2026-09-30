/**
 * What an offline pass over past sessions works with.
 *
 * THE POINT OF THESE TYPES IS THAT THEY ARE NOT CLAUDE'S. Every coding agent
 * writes its own log format, and an analyser written against one of them learns
 * from one of them. A plugin's whole job is to turn its agent's file into the
 * shapes here, so the analysis, the ranking and the writing are shared and only
 * the parsing is per-agent.
 *
 * Nothing in this module reads the network. A failure that already happened is
 * on disk, and learning from it is the one kind of improvement that costs a user
 * no tokens at all.
 */

/**
 * Why a tool call failed, as far as its output can tell us.
 *
 * These are categories a rule can be written against. "Unknown" is kept honest:
 * a failure that lands there is reported as uncategorised rather than folded into
 * a neighbouring class, because a rule derived from a misread failure is worse
 * than no rule.
 */
export enum FailureCategory {
  FileNotFound = 'file_not_found',
  ModuleNotFound = 'module_not_found',
  CommandNotFound = 'command_not_found',
  PermissionDenied = 'permission_denied',
  FileTooLarge = 'file_too_large',
  IsDirectory = 'is_directory',
  NoMatches = 'no_matches',
  Timeout = 'timeout',
  ExitCode = 'exit_code',
  BuildFailure = 'build_failure',
  TestFailure = 'test_failure',
  SyntaxError = 'syntax_error',
  ConnectionError = 'connection_error',
  UserRejected = 'user_rejected',
  StringNotFound = 'string_not_found',
  OutOfMemory = 'out_of_memory',
  /** The tool exists and was called with arguments it does not take. */
  InvalidArguments = 'invalid_arguments',
  Unknown = 'unknown',
}

/** One tool call and how it went, normalised out of whatever wrote it. */
/**
 * What kind of thing the subject is.
 *
 * WITHOUT THIS THE GROUPING GUESSES, AND IT GUESSED WRONG. A shell call's subject is
 * a command line, and a "file not found" from one names no file that the call itself
 * mentioned -- the path is inside the output. Grouping such a failure by the parent
 * directory of its subject produced sixteen groups of one from sixteen failures of
 * three commands, so none of them ever reached the threshold and the pass reported
 * nothing. The plugin knows which field it read; it says so here rather than leaving
 * the analyser to infer it from punctuation.
 */
export enum SubjectKind {
  Path = 'path',
  Pattern = 'pattern',
  Command = 'command',
  Url = 'url',
  /** The call named nothing this can group by. */
  None = 'none',
}

export interface ToolCall {
  readonly name: string;
  readonly id: string;
  /** The one field that identifies the target: a path, a pattern, a command. */
  readonly subject: string;
  /** Which field the subject came out of, so it is grouped as what it is. */
  readonly subjectKind: SubjectKind;
  readonly failed: boolean;
  readonly category: FailureCategory;
  /** The first line or so of the failure, already trimmed. Empty on success. */
  readonly detail: string;
  /** Bytes the failure put in the context window, which is what it cost. */
  readonly outputBytes: number;
  readonly index: number;
}

/** One session, from one agent. */
export interface SessionData {
  readonly sessionId: string;
  readonly agent: string;
  /**
   * The FAILED calls only.
   *
   * A session is thousands of successful reads and a handful of failures, and the
   * successes teach nothing -- keeping them would mean holding a quarter of a
   * gigabyte of other people's file contents in memory to count to ten thousand.
   */
  readonly calls: readonly ToolCall[];
  /** Every tool call the session made, so a rate has a denominator. */
  readonly totalCalls: number;
  readonly startedAt: Date | null;
  /** True when the file was longer than the byte budget and was cut short. */
  readonly truncated: boolean;
}

/** A project an agent has sessions for. */
export interface ProjectInfo {
  readonly name: string;
  /** The working directory the sessions ran in, when the log records one. */
  readonly projectPath: string | null;
  /** Where the logs are, which is never the project directory. */
  readonly dataPath: string;
  readonly sessionCount: number;
}

/** Which file a recommendation belongs in. */
export enum RecommendationTarget {
  /** The agent's own instructions file: CLAUDE.md, AGENTS.md, GEMINI.md. */
  ContextFile = 'context_file',
  /** The durable notes file, where one exists. */
  MemoryFile = 'memory_file',
}

/** How sure we are, in words, because a bare 0.62 means nothing to a reader. */
export enum Confidence {
  /** Seen enough times, in enough sessions, to be a habit rather than a day. */
  Established = 'established',
  /** Seen repeatedly, but inside one session, so it may be one bad afternoon. */
  Likely = 'likely',
  /** At the evidence floor. Reported, and said to be thin. */
  Thin = 'thin',
}

/** Something worth telling the next session, and what earned it. */
export interface Recommendation {
  readonly target: RecommendationTarget;
  readonly heading: string;
  readonly body: string;
  readonly category: FailureCategory;
  readonly confidence: Confidence;
  /** How many failures say this, and across how many separate sessions. */
  readonly occurrences: number;
  readonly sessions: number;
  /** The bytes those failures put in a context window, which is the cost. */
  readonly wastedBytes: number;
}

/** The result of a pass. */
export interface AnalysisResult {
  readonly agent: string;
  readonly project: ProjectInfo;
  readonly sessions: number;
  readonly calls: number;
  readonly failures: number;
  readonly uncategorised: number;
  /**
   * Failures that ran inside a chained command line, where nothing records which of
   * its commands failed. Reported for the same reason as the count above: it bounds
   * how much of the result to believe, and a pass that could attribute a tenth of
   * what it read should say so rather than look thorough.
   */
  readonly unattributable: number;
  readonly recommendations: readonly Recommendation[];
  /** Sessions that could not be read at all, by path, so a zero is explainable. */
  readonly unreadable: readonly string[];
}

export function failureRate(result: AnalysisResult): number {
  return result.calls === 0 ? 0 : result.failures / result.calls;
}