/**
 * A command that failed behind a pipe.
 *
 * WHY. `npm test 2>&1 | tail -20` exits with tail's status, which is 0, so the
 * client records success: Claude Code sets no `is_error`, writes no `Exit code
 * N`, and fires PostToolUse with `success: true`. Agents pipe through a filter
 * on most long runs -- to save tokens -- so the loop guard counted a red test
 * run as progress and derive could read it as the green half of a
 * failed-then-succeeded lesson about the command.
 *
 * A POSITIVE ALLOWLIST, for the reason transcript.mjs gives for its own: a
 * false failure invents a lesson. Three things must all hold.
 *
 *   1. The exit status is masked: a pipeline whose LAST stage is a filter, and
 *      no `pipefail`. A runner's own exit reaches the client otherwise, and an
 *      unmasked command needs no inference.
 *   2. The pipeline's FIRST stage is a build or test runner. `cat notes.md |
 *      head` may print "error TS2322:" from the file; that is content, not a
 *      run failing.
 *   3. The output carries a runner's failure summary -- a count above zero, a
 *      "Build FAILED", a traceback header -- never a bare word like "error",
 *      which passing runs print all the time.
 */

import { shellStatements } from './shell-split.mjs';

/** Last stages that replace the runner's exit status with their own. */
const FILTERS = new Set([
  'tail', 'head', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'cut', 'sort',
  'uniq', 'wc', 'less', 'more', 'tee', 'cat', 'jq', 'tr', 'column', 'findstr',
  'select-object', 'select-string', 'where-object', 'out-string', 'out-host',
  'format-table', 'format-list', 'measure-object', 'select', 'sls', 'where',
]);

/** First stages whose failure summaries the signatures below recognise. */
const RUNNERS = new Set([
  'npm', 'npm.cmd', 'npx', 'npx.cmd', 'yarn', 'pnpm', 'bun', 'deno', 'node',
  'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'pytest', 'python', 'python3',
  'py', 'tox', 'nox', 'uv', 'poetry', 'cargo', 'go', 'dotnet', 'msbuild', 'make',
  'cmake', 'ctest', 'mvn', 'gradle', 'gradlew', 'ant', 'rake', 'bundle', 'rspec',
  'mix', 'swift', 'xcodebuild', 'php', 'phpunit', 'composer', 'ruby', 'java',
  'javac', 'gcc', 'g++', 'clang', 'clang++', 'zig', 'bazel', 'nx', 'turbo',
]);

/** [name, pattern]: each a runner's own statement that the run failed. */
const SIGNATURES = [
  ['jest', /^Tests:\s+(?:\d+ \w+, )*[1-9]\d* failed\b/m],
  ['jest-suites', /^Test Suites:\s+[1-9]\d* failed\b/m],
  ['vitest', /^\s*Tests?\s+[1-9]\d* failed\b/m],
  ['mocha', /^\s*[1-9]\d* failing\s*$/m],
  ['pytest', /^=+ (?:.*, )?[1-9]\d* (?:failed|errors?)\b.*\bin [\d.]+s\b.*=+\s*$/m],
  ['pytest-failed', /^(?:FAILED|ERROR) \S+::\S+/m],
  ['tsc', /\berror TS\d{4,5}:/],
  ['npm', /^npm (?:ERR!|error) /m],
  ['msbuild', /^\s*Build FAILED\.?\s*$/m],
  ['msbuild-errors', /^\s*[1-9]\d* Error\(s\)\s*$/m],
  ['msbuild-error', /\): error [A-Z]{2,}\d{3,}:/],
  ['dotnet-test', /^\s*Failed!\s+-\s+Failed:\s+[1-9]/m],
  ['cargo', /^error(?:\[E\d{4}\])?: /m],
  ['cargo-test', /^test result: FAILED\b/m],
  ['go-test', /^--- FAIL: /m],
  ['go-pkg', /^FAIL\s+\S+\s+[\d.]+s\s*$/m],
  ['traceback', /^Traceback \(most recent call last\):/m],
  ['make', /^make(?:\[\d+\])?: \*\*\* /m],
  ['eslint', /✖ \d+ problems? \([1-9]\d* errors?/],
  ['maven-gradle', /^(?:\[ERROR\] )?BUILD FAILURE\s*$|^FAILURE: Build failed\b/m],
  ['rspec', /^\d+ examples?, [1-9]\d* failures?\b/m],
  ['not-found', /: command not found\s*$|is not recognized as (?:the name of a cmdlet|an internal or external command)/m],
];

/** The program a pipeline stage runs: env assignments, paths and `.exe` stripped. */
function program(stage) {
  const words = String(stage).trim().split(/\s+/);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  // `&` and `.` are PowerShell's call operators; the program is the next word.
  if (words[index] === '&' || words[index] === '.') index += 1;
  const word = (words[index] || '').replace(/^["']|["']$/g, '');
  return word.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

/**
 * Whether a runner's exit status is hidden behind a filter somewhere in the
 * command.
 */
export function maskedRunner(command) {
  if (typeof command !== 'string' || !command.includes('|')) return false;
  if (/\bpipefail\b/.test(command)) return false;
  let statements;
  try {
    statements = shellStatements(command);
  } catch {
    return false;
  }
  return statements.some(
    (stages) =>
      stages.length >= 2 &&
      FILTERS.has(program(stages[stages.length - 1])) &&
      RUNNERS.has(program(stages[0]))
  );
}

/** The first runner failure summary in `output`, as `{ signature, line }`, or null. */
export function failureInOutput(output) {
  if (typeof output !== 'string' || !output) return null;
  for (const [signature, pattern] of SIGNATURES) {
    const match = pattern.exec(output);
    if (!match) continue;
    const start = output.lastIndexOf('\n', match.index) + 1;
    const end = output.indexOf('\n', match.index);
    const line = output.slice(start, end < 0 ? undefined : end).trim().slice(0, 200);
    return { signature, line };
  }
  return null;
}
