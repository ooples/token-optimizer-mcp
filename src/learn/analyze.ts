/**
 * Turning failures into something worth writing down.
 *
 * THE HARD PART IS NOT FINDING FAILURES, IT IS REFUSING MOST OF THEM. A tool call
 * that failed once taught the session that made it and nothing more; a rule written
 * from it is noise in an instructions file forever. So a pattern has to repeat
 * before it is reported, the report says how thin the evidence is, and two whole
 * categories are deliberately dropped:
 *
 *   - a failing test or build is the work, not a habit. Nobody needs to be told
 *     that their tests were red last week, and a rule saying so would be obeyed by
 *     not running them.
 *   - an uncategorised failure has no rule to write. It is counted and reported as
 *     uncategorised,
    unattributable, which is honest, instead of being folded into a neighbour to
 *     make the output look richer.
 */

import { homedir } from 'node:os';
import {
  AnalysisResult,
  Confidence,
  FailureCategory,
  ProjectInfo,
  Recommendation,
  RecommendationTarget,
  SessionData,
  SubjectKind,
  ToolCall,
} from './models.js';

/** Below this, a pattern is an anecdote. */
export const MIN_OCCURRENCES = 3;

/** At or above this many separate sessions, it is a habit rather than a bad day. */
export const ESTABLISHED_SESSIONS = 3;

/** Categories that describe work rather than a habit, and are never rules. */
const NOT_A_RULE: ReadonlySet<FailureCategory> = new Set([
  FailureCategory.TestFailure,
  FailureCategory.BuildFailure,
  FailureCategory.SyntaxError,
  FailureCategory.Unknown,
]);

/** The home directory, replaced with ~ so a written rule is not a username leak. */
function tidy(text: string): string {
  const home = homedir();
  if (home.length === 0) return text;
  const forward = home.replace(/\\/g, '/');
  return text.split(home).join('~').split(forward).join('~');
}

/**
 * What a failure is ABOUT, as a key patterns can be counted against.
 *
 * The subject itself is too specific -- twelve missing files in one directory are
 * one fact about the directory, not twelve facts. The grouping per category is
 * therefore different on purpose: a path groups by its parent, a command groups by
 * the program being run, and a search pattern is its own group because a pattern
 * that never matches is the fact.
 */
export function groupKey(call: ToolCall): string {
  const subject = call.subject.trim();
  // The tool is the fact when it rejected its own arguments, and it is all there is
  // when the call named nothing.
  if (call.category === FailureCategory.InvalidArguments) return call.name;
  if (subject.length === 0 || call.subjectKind === SubjectKind.None)
    return call.name;
  if (call.subjectKind === SubjectKind.Command) {
    // WHATEVER THE OUTPUT SAID, the unit is the command. A "file not found" from a
    // shell call names a path the call never mentioned -- it is inside the output --
    // so grouping by the subject's parent directory would group by the directory the
    // command was typed in: one group per session, and a rule from none.
    return program(subject);
  }
  if (call.subjectKind === SubjectKind.Pattern) return subject.slice(0, 80);
  if (call.subjectKind === SubjectKind.Url) return subject.slice(0, 120);
  switch (call.category) {
    case FailureCategory.FileNotFound:
    case FailureCategory.IsDirectory:
    case FailureCategory.PermissionDenied:
      return parent(subject);
    default:
      return subject.slice(0, 200);
  }
}

/** `&&`, `;`, `|` -- where one statement of a command line ends and the next starts. */
const SEPARATOR = /^(?:&&|\|\||[;|&])$/;
/** The same, run together with the word before it, as in `Pop-Location;`. */
const ENDS_STATEMENT = /[;&|]$/;
/** Things that run another program, and are never the program that failed. */
const LAUNCHERS = new Set([
  'sudo',
  'time',
  'env',
  'npx',
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'exec',
  '/c',
  '/k',
  '--',
]);
/** Words whose whole statement is a preamble, not the command being judged. */
const PREAMBLE = new Set([
  'cd',
  'chdir',
  'pushd',
  'popd',
  'set-location',
  'sl',
  'export',
  'set',
]);
/** A shell assignment: `FOO=bar`, `$f=...`, `$env:X=1`. */
/**
 * `FOO=1 cmd` -- an environment prefix, which is one word and not a statement.
 *
 * Reading it as a statement, which is what a single pattern for both forms did,
 * discarded the rest of `sudo -E env FOO=1 python script.py` and left nothing this
 * could name, so the whole line became the key and grouped with nothing.
 */
const PREFIX_ASSIGNMENT = /^[A-Za-z_][\w.:]*=/;
/** `$x = 1` -- a statement that runs no program, so the statement goes. */
const SHELL_VARIABLE = /^\$/;
/**
 * Flags that take the next word, so the next word is not the subcommand.
 *
 * `git -C x rev-parse HEAD` reported `git x` without this: a key that is one
 * directory's spelling rather than the command, and so a group of one.
 */
const VALUE_FLAGS = new Set([
  '-c',
  '-h',
  '-r',
  '-w',
  '-z',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--namespace',
  '--repo',
  '--host',
  '--context',
  '--config',
  '--prefix',
  '--workspace',
  '--project',
]);
/** Programs whose subcommand is the fact, so that `git push` is not `git`. */
const SUBCOMMANDED = new Set([
  'npm',
  'git',
  'dotnet',
  'gh',
  'cargo',
  'docker',
  'pnpm',
  'yarn',
]);

/**
 * The program a command line runs, past the things that wrap one.
 *
 * THE WRAPPERS MATTER MORE THAN THEY LOOK HERE. Almost every command an agent runs
 * begins `cd <somewhere> &&`, and reading the first word of the line reports that
 * `cd` failed a hundred times -- one worthless rule standing exactly where a dozen
 * real ones were, and the grouping is the whole value of the pass. So a leading
 * directory change or assignment is stepped over with the rest of its statement,
 * launchers are stepped over word by word, and what is left is what actually ran.
 */
function program(command: string): string {
  const words = command.replace(/^["']/, '').split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    const bare = word
      .replace(/^.*[\\/]/, '')
      .toLowerCase()
      .replace(/[;&|]+$/, '');
    if (bare.length === 0 || SEPARATOR.test(word)) {
      index += 1;
      continue;
    }
    if (PREFIX_ASSIGNMENT.test(word)) {
      index += 1;
      continue;
    }
    if (PREAMBLE.has(bare) || SHELL_VARIABLE.test(word)) {
      // The whole statement goes, not one word: `cd "C:\a b" && npm test` would
      // otherwise leave the second half of a quoted path standing as the program.
      index = endOfStatement(words, index);
      continue;
    }
    if (LAUNCHERS.has(bare) || bare.startsWith('-')) {
      index += 1;
      continue;
    }
    if (hasSeparator(words, index)) {
      // WHICH OF FIVE STATEMENTS FAILED IS NOT RECORDED ANYWHERE. A transcript keeps
      // the line that was run and the code it exited with, so for `cd X; git grep a;
      // Select-String b` the failure belongs to one of three commands and nothing
      // says which. Naming the first one produced exactly that: sixteen "git grep
      // keeps failing" attributions whose quoted evidence was another command's
      // successful output. So a chained line is grouped as unattributable, and the
      // key deliberately does not look like a program name, which is what stops a
      // rule being written from it downstream.
      return CHAINED;
    }
    if (SUBCOMMANDED.has(bare)) {
      const sub = wordAfter(words, index + 1);
      if (sub === null) return bare;
      if (bare === 'npm' && (sub === 'run' || sub === 'run-script')) {
        const script = wordAfter(words, index + 2);
        return script === null ? `${bare} ${sub}` : `${bare} run ${script}`;
      }
      return `${bare} ${sub}`;
    }
    return bare;
  }
  // Nothing ran that this can name -- a bare shell expression, most likely. Kept
  // verbatim rather than guessed at: a wrong name here becomes a wrong rule, and a
  // key this specific simply does not recur often enough to be reported.
  return command.slice(0, 60);
}

/** The key a command line gets when it ran several commands and one of them failed. */
export const CHAINED = '(a chained command line)';

/** Is there another statement after this word? */
function hasSeparator(words: readonly string[], from: number): boolean {
  for (let index = from; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (SEPARATOR.test(word) || ENDS_STATEMENT.test(word)) {
      // Trailing punctuation on the last word is a terminator, not another command.
      return words.slice(index + 1).some((rest) => rest.trim().length > 0);
    }
  }
  return false;
}

/** The index just past the next statement separator. */
function endOfStatement(words: readonly string[], from: number): number {
  for (let index = from; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (SEPARATOR.test(word)) return index + 1;
    if (ENDS_STATEMENT.test(word)) return index + 1;
  }
  return words.length;
}

/** The next real word, skipping flags, and nothing past the end of the statement. */
function wordAfter(words: readonly string[], from: number): string | null {
  for (let index = from; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (SEPARATOR.test(word) || ENDS_STATEMENT.test(word)) return null;
    if (VALUE_FLAGS.has(word.toLowerCase())) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word.toLowerCase();
  }
  return null;
}

/** The directory a path is in, which is what a group of missing files shares. */
function parent(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const cut = normalised.lastIndexOf('/');
  return cut <= 0 ? normalised : normalised.slice(0, cut);
}

interface Group {
  readonly category: FailureCategory;
  readonly kind: SubjectKind;
  readonly key: string;
  readonly calls: ToolCall[];
  readonly sessions: Set<string>;
  readonly tools: Set<string>;
}

/**
 * The categories whose own wording already names a program rather than a path.
 *
 * Everything else, when the subject is a command line, goes through commandRule().
 */
const NAMES_THE_PROGRAM = new Set([
  FailureCategory.CommandNotFound,
  FailureCategory.ExitCode,
  FailureCategory.Timeout,
  FailureCategory.OutOfMemory,
  FailureCategory.UserRejected,
  FailureCategory.InvalidArguments,
]);

/**
 * What a repeatedly failing command earns, with the three refusals that keep this
 * from being noise.
 *
 * Measured against real transcripts this branch is where most findings arrive, and
 * where most of them have to be turned away:
 *   - a key that is not a program name came from a shell one-liner, and the shape of
 *     a line nobody will type twice is not a lesson about a project.
 *   - a failing build or test is the work, not a habit (see NOT_A_RULE above).
 *   - a failure that said nothing is, more often than not, an empty result: grep,
 *     git grep and Select-String all exit 1 when they match nothing. Reporting
 *     sixteen successful searches as a fault is worse than silence, because someone
 *     would act on it.
 */
function commandRule(
  group: Group,
  key: string,
  example: string
): { heading: string; body: string } | null {
  if (!PROGRAM_KEY.test(key)) return null;
  if (BUILDS_OR_TESTS.has(key)) return null;
  if (example.length === 0 || /^exit code \d+\.?$/i.test(example)) return null;
  // A JSON DOCUMENT IS NOT EVIDENCE. A code-mode tool hands back its whole reply as
  // JSON, and quoting the first 200 characters of it produced `exec` failed 50
  // times. The first said: "{"type": "message", "id": "msg_0d61..." -- a true count
  // beside a quotation that says nothing a reader can act on.
  if (/^[[{]/.test(example)) return null;
  return {
    heading: 'Commands that keep failing',
    body:
      `\`${key}\` failed ${group.calls.length} times. The first said: "${example}". ` +
      `Check what it needs on this machine before spending another call on it.`,
  };
}

/** A command name, optionally with a subcommand or two -- not a line of shell. */
const PROGRAM_KEY = /^[a-z][\w.+-]*(?: [\w.+-]+){0,2}$/;
/** Commands whose failure is the work failing, so never a rule about the project. */
const BUILDS_OR_TESTS = new Set([
  'make',
  'msbuild',
  'jest',
  'pytest',
  'tsc',
  'npm test',
  'npm run build',
  'npm run test',
  'dotnet build',
  'dotnet test',
  'cargo build',
  'cargo test',
  'go build',
  'go test',
]);

/** Categories whose wording says the key IS a file, a directory or a host. */
const NAMES_A_RESOURCE = new Set([
  FailureCategory.FileNotFound,
  FailureCategory.IsDirectory,
  FailureCategory.PermissionDenied,
  FailureCategory.FileTooLarge,
  FailureCategory.StringNotFound,
  FailureCategory.NoMatches,
  FailureCategory.ConnectionError,
]);

/** The sentence each category earns, given what the failures had in common. */
function advise(group: Group): { heading: string; body: string } | null {
  const key = tidy(group.key);
  const tools = [...group.tools].sort().join(', ');
  const example = tidy(group.calls[0]?.detail ?? '');
  // A COMMAND IS NOT A FILE, however the output was categorised. "`git grep` was
  // read or written 16 times and does not exist" is what the path wordings below
  // produce when the subject is a command line, so everything a shell ran is worded
  // as what it is, and the category survives only as the message quoted from it.
  if (
    group.kind === SubjectKind.Command &&
    !NAMES_THE_PROGRAM.has(group.category)
  ) {
    return commandRule(group, key, example);
  }
  // AND A TOOL NAME IS NOT A RESOURCE. With no subject recorded, the key is the tool
  // that was called, so the wordings below assert something plainly false of it:
  // "`exec` was read or written 9 times and does not exist" is what a real run
  // produced. Which path was missing is not known here, so there is no rule to write.
  if (group.kind === SubjectKind.None && NAMES_A_RESOURCE.has(group.category)) {
    return null;
  }
  switch (group.category) {
    case FailureCategory.InvalidArguments:
      return {
        heading: 'Tools called with arguments they do not take',
        body:
          `\`${key}\` rejected its own arguments ${group.calls.length} times: "${example}". ` +
          `Read its schema once instead of paying a call to be told again.`,
      };
    case FailureCategory.FileNotFound:
      return {
        heading: 'Paths that are not there',
        body:
          `\`${key}\` was read or written ${group.calls.length} times and does not exist. ` +
          `List the directory before reading from it.`,
      };
    case FailureCategory.CommandNotFound:
      return {
        heading: 'Not installed on this machine',
        body:
          `\`${key}\` is not on PATH here (${group.calls.length} failed calls). ` +
          `Use what this machine has, or install it once and say so.`,
      };
    case FailureCategory.PermissionDenied:
      return {
        heading: 'Refused by the system',
        body: `\`${key}\` cannot be written by this user (${group.calls.length} times): ${example}`,
      };
    case FailureCategory.FileTooLarge:
      return {
        heading: 'Files too big to read whole',
        body:
          `\`${key}\` is too large to read in one call (${group.calls.length} attempts). ` +
          `Read it in ranges, or search it instead.`,
      };
    case FailureCategory.IsDirectory:
      return {
        heading: 'Directories read as files',
        body: `\`${key}\` is a directory; ${tools} was pointed at it ${group.calls.length} times.`,
      };
    case FailureCategory.StringNotFound:
      return {
        heading: 'Edits that did not match',
        body:
          `${group.calls.length} edits to \`${key}\` failed because the text to replace was not ` +
          `there. Read the exact lines before editing them.`,
      };
    case FailureCategory.NoMatches:
      return {
        heading: 'Searches that never match',
        body: `\`${key}\` matched nothing, ${group.calls.length} times. It is not in this project.`,
      };
    case FailureCategory.Timeout:
      return {
        heading: 'Commands that run out of time',
        body:
          `\`${key}\` timed out ${group.calls.length} times. Give it a longer budget or a ` +
          `smaller scope -- rerunning it unchanged costs the same wait again.`,
      };
    case FailureCategory.OutOfMemory:
      return {
        heading: 'Commands that run out of memory',
        body: `\`${key}\` was killed for memory ${group.calls.length} times: ${example}`,
      };
    case FailureCategory.ModuleNotFound:
      return {
        heading: 'Imports that are not installed',
        body: `${group.calls.length} calls failed on a missing module: ${example}`,
      };
    case FailureCategory.ConnectionError:
      return {
        heading: 'Network that is not reachable',
        body: `\`${key}\` could not be reached ${group.calls.length} times: ${example}`,
      };
    case FailureCategory.UserRejected:
      return {
        heading: 'Refused when asked',
        body:
          `\`${key}\` was declined ${group.calls.length} times. Proposing it again spends a ` +
          `turn to be told no.`,
      };
    case FailureCategory.ExitCode:
      return commandRule(group, key, example);
    default:
      return null;
  }
}

function confidenceOf(group: Group): Confidence {
  if (group.sessions.size >= ESTABLISHED_SESSIONS)
    return Confidence.Established;
  if (group.calls.length >= MIN_OCCURRENCES * 2) return Confidence.Likely;
  return Confidence.Thin;
}

/** Analyse one project's sessions. */
export function analyse(
  agent: string,
  project: ProjectInfo,
  sessions: readonly SessionData[],
  unreadable: readonly string[] = []
): AnalysisResult {
  const groups = new Map<string, Group>();
  let failures = 0;
  let calls = 0;
  let uncategorised = 0;
  let unattributable = 0;
  for (const session of sessions) {
    calls += session.totalCalls;
    for (const call of session.calls) {
      failures += 1;
      if (call.category === FailureCategory.Unknown) uncategorised += 1;
      if (NOT_A_RULE.has(call.category)) continue;
      const subject = groupKey(call);
      if (subject === CHAINED) {
        unattributable += 1;
        continue;
      }
      const key = `${call.category}::${subject}`;
      const group: Group = groups.get(key) ?? {
        category: call.category,
        kind: call.subjectKind,
        key: subject,
        calls: [],
        sessions: new Set<string>(),
        tools: new Set<string>(),
      };
      group.calls.push(call);
      group.sessions.add(session.sessionId);
      group.tools.add(call.name);
      groups.set(key, group);
    }
  }

  const recommendations: Recommendation[] = [];
  for (const group of groups.values()) {
    if (group.calls.length < MIN_OCCURRENCES) continue;
    const advice = advise(group);
    if (advice === null) continue;
    recommendations.push({
      target: RecommendationTarget.ContextFile,
      heading: advice.heading,
      body: advice.body,
      category: group.category,
      confidence: confidenceOf(group),
      occurrences: group.calls.length,
      sessions: group.sessions.size,
      wastedBytes: group.calls.reduce((sum, call) => sum + call.outputBytes, 0),
    });
  }
  // Ranked by what they cost, not by how often they happened: twenty cheap "no
  // matches" lines waste less of a context window than three failures that each
  // pasted a megabyte of build output into it.
  recommendations.sort(
    (a, b) => b.wastedBytes - a.wastedBytes || b.occurrences - a.occurrences
  );

  return {
    agent,
    project,
    sessions: sessions.length,
    calls,
    failures,
    uncategorised,
    unattributable,
    recommendations,
    unreadable,
  };
}
