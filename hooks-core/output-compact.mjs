/**
 * Compacting a tool's output AFTER it ran, before the model reads it.
 *
 * WHY HERE. Every byte of a tool result is re-read on every later call of the
 * session: in a 10-agent run, 477k characters of shell output entered context
 * and were re-read about 15x on average, while the router passed all 185 Bash
 * calls through untouched. Bounding by rewriting the COMMAND (rewrite.mjs) has
 * to refuse whole families -- heredocs, redirects, `cd`, pipelines it cannot
 * prove safe -- because wrapping changes what a command means. Claude Code's
 * PostToolUse `updatedToolOutput` replaces the RESULT instead (verified on
 * 2.1.302 for Bash, Read and Grep), so the command runs exactly as written and
 * only what reaches the context changes.
 *
 * NOTHING IS LOST. The full output is stored content-addressed (expand.mjs
 * capture) and the compacted text names the file, so any agent -- subagents
 * included, with or without our MCP tools -- recovers any line with one Read.
 *
 * WHAT IS NEVER TOUCHED: output under OUTPUT_COMPACT_MIN_BYTES; error output of
 * a failed call beyond its own bound; a read-like command's output up to
 * READ_EXACT_BYTES (an edit needs the exact text, and an Edit built from a
 * folded read fails and costs a re-read); any line that names a failure, which is
 * the signal a debug loop exists to carry.
 */
import { capture, artifactPath } from './expand.mjs';
import { shellStages, shellStatements } from './shell-split.mjs';

/** Below this an output is left exactly as it is. */
export const OUTPUT_COMPACT_MIN_BYTES = 6000;
/** What a compacted non-read output aims for. */
export const OUTPUT_BUDGET_BYTES = 6000;
/** A read-like command's output is byte-exact up to this size. */
export const READ_EXACT_BYTES = 24000;
/** A line shape repeated at least this often is folded to a few examples. */
const FOLD_MIN_REPEATS = 8;
/** Examples of a folded shape kept verbatim: first ones and the last. */
const FOLD_KEEP_FIRST = 2;

const OFF = /^(0|false|no|off)$/i;
export function outputCompactEnabled(env = process.env) {
  return !OFF.test(String(env.TOKEN_OPTIMIZER_OUTPUT_COMPACT ?? '').trim());
}

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');

/** ANSI colour and cursor escapes carry nothing a model reads. */
export const stripAnsi = (text) =>
  String(text).replace(
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g,
    ''
  );

/** A progress bar redrawn with \r: only the final state of each line is real. */
export const collapseCarriageReturns = (text) =>
  String(text)
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r$/, '').split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');

/**
 * Lines that carry the verdict of a run. Never folded, never dropped.
 *
 * Deliberately broad: the cost of keeping a line that was not a failure is a few
 * bytes, the cost of dropping one that was is a re-run at full context size.
 */
const SIGNAL =
  /\b(error|errors|failed|failure|failures|fail|exception|traceback|panic|fatal|assert(?:ion)?|denied|refused|cannot|can't|unable|not found|undefined|segmentation|timed? ?out|killed|abort(?:ed)?)\b|^E\s|^\s*>\s|^\s*at\s\S+[:(]|^\s*File "|FAILED|ERROR|✕|✗|×/i;

/** Summary lines at the end of a run: kept verbatim, always. */
const SUMMARY =
  /^\s*(=+.*=+|Tests?:|Test Suites:|Ran \d+ tests?|\d+ (passed|failed)|OK\b|FAILED\b|Build (succeeded|FAILED)|\d+ Warning\(s\)|\d+ Error\(s\)|Time:)/i;

/** The shape of a line, for spotting a block of near-identical ones: numbers masked. */
const shapeOf = (line) =>
  line
    .trimEnd()
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ');

/**
 * A machine-generated line no structural compressor can shrink: minified code,
 * base64, source maps: 300+ characters, under 6% spaces, not JSON-shaped.
 */
export function isDenseLine(line) {
  if (line.length < 300 || line.includes('\t')) return false;
  const t = line.trim();
  if (/^[[{]/.test(t) && /[\]}],?$/.test(t)) return false;
  let spaces = 0;
  for (const ch of line) if (ch === ' ') spaces++;
  return spaces / line.length < 0.06;
}

/** Longest signal line kept whole even when dense; longer ones are elided like any other. */
const SIGNAL_LINE_MAX = 2000;

const elideDense = (line) =>
  `${line.slice(0, 160)}…[${line.length - 240} chars elided]…${line.slice(-80)}`;

/** Names worth reporting from lines that were dropped, so the model can judge whether to look. */
function namesIn(lines, limit = 5) {
  const errors = new Set();
  const files = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(
      /\b([A-Z][A-Za-z]*(?:Error|Exception|Warning))\b/g
    ))
      errors.add(m[1]);
    // A start boundary and a length cap keep this linear: unanchored, `[\w./\\-]+`
    // retried from every position of a long path-character run (733 ms on 32k chars).
    for (const m of l.matchAll(
      /(?<![\w./\\-])[\w./\\-]{1,200}\.(?:py|ts|tsx|js|mjs|cs|go|rs|java|kt|rb|php|cpp|c|h)\b/g
    ))
      files.add(m[0]);
    if (errors.size >= limit && files.size >= limit) break;
  }
  return {
    errors: [...errors].slice(0, limit),
    files: [...files].slice(0, limit),
  };
}

/** `path(line,col): error|warning CODE: message [project::TargetFramework=x]` */
const MSBUILD_DIAGNOSTIC = /\(\d{1,9},\d{1,9}\): (?:error|warning) [A-Za-z]{1,20}\d{1,9}:/;

/** The line without its trailing ` [project...]`, or null when it has none. */
function withoutProjectSuffix(line) {
  const end = line.trimEnd();
  const open = end.lastIndexOf(' [');
  return end.endsWith(']') && open > 0 ? end.slice(0, open).trimEnd() : null;
}

/**
 * MSBuild prints each diagnostic once per project and target framework, the
 * copies differing only in the trailing `[project::TargetFramework=x]`. A
 * multi-targeted build of 8 errors is 32 lines, and a budget that keeps every
 * error line can still run out on the copies. Map: index of the first copy ->
 * how many later copies it stands for; index of each later copy -> 0.
 */
function msbuildRepeats(lines) {
  const first = new Map();
  const repeats = new Map();
  lines.forEach((line, i) => {
    if (line.length > SIGNAL_LINE_MAX || !MSBUILD_DIAGNOSTIC.test(line)) return;
    const key = withoutProjectSuffix(line);
    if (key === null) return;
    const at = first.get(key);
    if (at === undefined) {
      first.set(key, i);
      return;
    }
    repeats.set(at, (repeats.get(at) ?? 0) + 1);
    repeats.set(i, 0);
  });
  return repeats;
}

/**
 * Lossless-in-meaning reduction: progress redraws, colour, dense lines, and
 * blocks of the same line shape folded to examples plus a count.
 */
export function foldOutput(text) {
  const lines = collapseCarriageReturns(stripAnsi(text)).split('\n');
  const counts = new Map();
  for (const l of lines) {
    if (!l.trim() || SIGNAL.test(l) || SUMMARY.test(l)) continue;
    const s = shapeOf(l);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const lastIndex = new Map();
  lines.forEach((l, i) => lastIndex.set(shapeOf(l), i));
  const repeats = msbuildRepeats(lines);
  const seen = new Map();
  const out = [];
  let folded = 0;
  lines.forEach((line, i) => {
    const r = repeats.get(i);
    if (r === 0) {
      folded++;
      return;
    }
    if (r) {
      out.push(`${line}  [+${r} more: same diagnostic in other projects/target frameworks]`);
      return;
    }
    const s = shapeOf(line);
    const n = counts.get(s) ?? 0;
    if (n < FOLD_MIN_REPEATS) {
      // A compiler error with a long path has almost no spaces, so it reads as
      // dense -- but its middle is the message. Signal lines stay whole unless
      // they are genuinely huge (a minified bundle that happens to say "error").
      const keepWhole = line.length <= SIGNAL_LINE_MAX && (SIGNAL.test(line) || SUMMARY.test(line));
      out.push(isDenseLine(line) && !keepWhole ? elideDense(line) : line);
      return;
    }
    const k = (seen.get(s) ?? 0) + 1;
    seen.set(s, k);
    if (k <= FOLD_KEEP_FIRST || i === lastIndex.get(s)) {
      out.push(line);
      if (k === FOLD_KEEP_FIRST)
        out.push(
          `  [… ${n - FOLD_KEEP_FIRST - 1} more lines like the above …]`
        );
    } else folded++;
  });
  return { text: out.join('\n'), folded };
}

/**
 * Fit `text` into `budget` bytes: a head, every signal line with its following
 * context, the summary lines, and the tail. Returns the kept text and what was
 * dropped.
 */
export function selectWithinBudget(text, budget) {
  if (bytes(text) <= budget) return { text, dropped: [] };
  const lines = text.split('\n');
  const keep = new Array(lines.length).fill(false);
  let used = 0;
  const take = (i) => {
    if (i < 0 || i >= lines.length || keep[i]) return true;
    const cost = bytes(lines[i]) + 1;
    if (used + cost > budget) return false;
    keep[i] = true;
    used += cost;
    return true;
  };
  // The ending first: the summary of a run lives there.
  const tailShare = Math.floor(budget * 0.25);
  for (let i = lines.length - 1, t = 0; i >= 0 && t < tailShare; i--) {
    if (!take(i)) break;
    t += bytes(lines[i]) + 1;
  }
  // Every signal and summary line, with two lines of context after it.
  for (let i = 0; i < lines.length; i++) {
    if (SIGNAL.test(lines[i]) || SUMMARY.test(lines[i])) {
      if (!take(i)) break;
      take(i + 1);
      take(i + 2);
    }
  }
  // Then the head, as far as the budget goes.
  for (let i = 0; i < lines.length; i++) if (!take(i)) break;
  const out = [];
  const dropped = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push(`  [… ${gap} lines omitted …]`);
      gap = 0;
      out.push(l);
    } else {
      gap++;
      dropped.push(l);
    }
  });
  if (gap) out.push(`  [… ${gap} lines omitted …]`);
  return { text: out.join('\n'), dropped };
}

/**
 * A stage that prints a file's content. `git show` only as `<rev>:<path>`: a
 * bare `git show <commit>` prints a commit and its diff, which is a log.
 */
const READ_STAGE =
  /^(cat|type|head|tail|less|more|bat|nl|Get-Content|gc)\b|^sed\s+-n\b|^git\s+show\s+(?:-\S+\s+)*(?:[^\s:-][^\s:]*)?:\S|^git\s+cat-file\s+-p\b|^awk\s+(-F\s*('[^']*'|"[^"]*"|\S+)\s+)?'(NR|\{)/i;
/**
 * A stage that narrows its input to line ranges or reformats every line
 * (numbering, `cut -c`, an `awk` action with no pattern), so a read stays a
 * read: `sed -n 9990,10340p f | cat -n | awk '{...print}' | cut -c1-200` is a
 * numbered view of a file an edit is built from, not a log. An awk PATTERN
 * (`awk '/x/'`) filters like grep and is not here. Also kept: a substitution
 * (`sed 's/^/    /'`), a per-line ForEach-Object, and an INVERSE grep -- the
 * recorded shape is `sed -n 40,270p X.cs | grep -v <doc-comment pattern>`, a
 * file read with its blank or comment lines removed; 32 such reads were folded
 * before this was here.
 */
const RANGE_STAGE =
  /^(head|tail|nl|more|cat\s+-n)\b|^sed\s+-n\s+['"]?\d+(,\d+)?p(;\d+(,\d+)?p)*['"]?\s*$|^(Select-Object|select)\s+(-(First|Last|Skip|Index)\s+\(?[\d,.]+\)?\s*)+$|^awk\s+(-F\s*('[^']*'|"[^"]*"|\S+)\s+)?'(NR|\{)|^cut\s+-c\s*\d*-?\d*\s*$|^sed\s+(-E\s+)?['"]s(.).*\2['"]\s*$|^(ForEach-Object|%)\s*(-Begin\s*\{[^}]*\}\s*-Process\s*)?\{/i;

/** `grep -v X` / `grep -vE X` / `Select-String -NotMatch X`: drops lines, never adds any. */
function isInverseFilter(stage) {
  const words = stage.split(/\s+/);
  if (/^Select-String$|^sls$/i.test(words[0])) return words.some((w) => /^-NotMatch$/i.test(w));
  if (words[0] !== 'grep') return false;
  for (const w of words.slice(1)) {
    if (!w.startsWith('-')) return false;
    if (/^-[A-Za-z]*v[A-Za-z]*$/.test(w)) return true;
  }
  return false;
}

const isRangeStage = (stage) => RANGE_STAGE.test(stage) || isInverseFilter(stage);

/**
 * The pipeline stages of the statement the command's output ends with,
 * cd/Set-Location skipped: the PowerShell tool and multi-line Bash calls put
 * `cd x` and the read on separate lines. `$x = ` and a leading `(` are dropped,
 * since PowerShell `$x = Get-Content f` and `(Get-Content f)[0..80]` read the same.
 */
function lastStatementStages(command) {
  return statementStages(command).pop() ?? [];
}

/** Every statement's stages, cd/Set-Location statements dropped, `$x = ` and `(` stripped. */
function statementStages(command) {
  return shellStatements(command)
    .filter((stages) => !(stages.length === 1 && /^(cd|Set-Location|sl|pushd|Push-Location)\s+\S+$/i.test(stages[0])))
    .map((stages) => stages.map((s) => s.replace(/^\$[\w:]+\s*=\s*/, '').replace(/^\(+/, '')).filter(Boolean));
}

/**
 * A command whose output IS the content of a file: an edit may need it byte-exact.
 *
 * JUDGED BY THE STAGE THAT PRODUCES THE OUTPUT, not the last one. This used to
 * test only the final pipeline stage, so `grep -rn X . | head -200`,
 * `git log | head -100` and `dotnet test | tail -60` all counted as file reads
 * and passed byte-exact up to READ_EXACT_BYTES -- a search, a log and a test run
 * treated as source an edit is built from. Replayed over the local transcripts
 * (bench/field/compaction-replay.mjs) that was 87 outputs over 6 KB and ~207k
 * tokens let through whole. A pipeline is a read only when its FIRST stage
 * reads and every later stage merely cuts a line range out of it.
 *
 * ANY STATEMENT, NOT ONLY THE LAST. Every statement's output reaches the model,
 * so `cat a.cs; grep -n X b.cs | head` puts a.cs in context as surely as a bare
 * `cat a.cs`. Judging only the trailing grep folded 160 sub-24 KB file reads in
 * the replayed corpus as if they were search hits.
 */
export function isReadLikeCommand(command) {
  return statementStages(command).some(
    (stages) =>
      stages.length > 0 &&
      READ_STAGE.test(stages[0]) &&
      !LOG_TARGET.test(stages[0]) &&
      !writesStdout(stages[0]) &&
      stages.slice(1).every(isRangeStage)
  );
}

/**
 * A read of a log file is not a read an edit is built from. Byte-exact up to
 * READ_EXACT_BYTES and then cut head-first, `cat ci.log` kept 24 KB of
 * progress and dropped the failure at the end; as a log it is selected around
 * its verdict lines instead.
 */
// `.output` is where Claude Code writes a background task's stdout.
const LOG_TARGET = /\.(log|out|output|err|trx)['"]?(\s|$)/i;

/**
 * A stage whose stdout goes to a file prints nothing: `cat > f <<'EOF'` writes
 * f, so it is not a read, and the output of whatever runs next is not file
 * content. 550 recorded commands of this shape kept ~106k tokens byte-exact.
 * Quoted text is ignored (`sed 's/a>b/'`), and so are `2>`, `2>&1` and `>&2`.
 */
function writesStdout(stage) {
  const bare = stage.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  return /(?:^|[^0-9>])>>?(?!&)\s*\S/.test(bare);
}

/** A build or test run's output is compacted from this size, not OUTPUT_COMPACT_MIN_BYTES. */
export const BUILD_LOG_MIN_BYTES = 2000;
/** What a compacted build/test log under OUTPUT_COMPACT_MIN_BYTES keeps besides its verdict lines. */
export const BUILD_LOG_BUDGET_BYTES = 1200;

/** A pipeline stage that runs a build or a test runner (its first word is the program). */
const BUILD_STAGE =
  /^(dotnet(\.exe)?\s+(build|test|msbuild|pack|publish)|msbuild(\.exe)?|npm(\.cmd)?\s+(test|t|run\s+[\w:-]*(build|test|lint|check|typecheck)[\w:-]*)|npx(\.cmd)?\s+(tsc|jest|eslint|vitest)|jest|vitest|tsc|pytest|python3?\s+-m\s+pytest|cargo\s+(build|test|check|clippy)|go\s+(build|test|vet)|mvn|\.?[\\/]?gradlew?|ctest|cmake\s+--build|make)(\s|$)/i;

/**
 * A command that builds or runs tests, in any statement of it.
 *
 * WHY A LOWER THRESHOLD FOR THESE. Replayed over the local transcripts
 * (bench/field/compaction-replay.mjs), 2,968 build/test results came to 408k
 * tokens and 6 KB caught only 17 of them: an MSBuild, jest or pytest run piped
 * through `tail -60` lands at 2-6 KB and is mostly restore/compile progress
 * around one verdict line -- which an agent re-reads on every later call.
 */
export function isBuildOrTestCommand(command) {
  // Judged by the PROGRAM each pipeline stage runs, never by a word anywhere in
  // the command: `grep make notes.txt`, `cat a | grep jest` and
  // `git commit -m "make it work"` print searches and text, and the build
  // budget would fold them lossily.
  return shellStages(command)
    .map((s) =>
      s
        // `FOO=1 npm test`, `$env:X='1'`, `(dotnet test)`, `& "C:\b\build.ps1"`.
        .replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')
        .replace(/^[(&]+\s*/, '')
    )
    .some(
      (stage) =>
        BUILD_STAGE.test(stage) ||
        // A build script runs as the program itself or as a shell's script argument.
        /^(?:(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*?(?:-File\s+)?|(?:ba|z)?sh\s+|cmd(?:\.exe)?\s+\/c\s+)?['"]?(?:\S*[\\/])?build\.(ps1|sh|cmd)['"]?(\s|$)/i.test(
          stage
        )
    );
}

/**
 * Bytes selectWithinBudget spends on verdicts: every signal/summary line and
 * the two lines it keeps after each.
 */
function verdictBytes(text) {
  const lines = String(text).split('\n');
  const keep = new Set();
  lines.forEach((l, i) => {
    if (SIGNAL.test(l) || SUMMARY.test(l)) for (const j of [i, i + 1, i + 2]) if (j < lines.length) keep.add(j);
  });
  let n = 0;
  for (const j of keep) n += bytes(lines[j]) + 1;
  return n;
}

/**
 * The compacted text for one output, or null when it should reach the model
 * unchanged.
 *
 * @param {string} text
 * @param {{ command?: string, budget?: number }} options
 */
export function compactText(
  text,
  { command = '', budget = OUTPUT_BUDGET_BYTES } = {}
) {
  const source = String(text ?? '');
  const size = bytes(source);
  if (size < OUTPUT_COMPACT_MIN_BYTES) {
    // Only a build/test log is compacted below the general floor, and only
    // around its verdict. Selection spends up to a quarter of the budget on the
    // tail before it reaches the verdict lines, so the budget is sized for the
    // verdicts to fit after that: a small budget cuts progress noise, never a
    // failure line.
    if (size < BUILD_LOG_MIN_BYTES || !isBuildOrTestCommand(command) || isReadLikeCommand(command))
      return null;
    const verdicts = verdictBytes(collapseCarriageReturns(stripAnsi(source)));
    budget = Math.min(budget, BUILD_LOG_BUDGET_BYTES + Math.ceil(verdicts / 0.75));
  }
  const readLike = isReadLikeCommand(command);
  if (readLike && size <= READ_EXACT_BYTES) return null;
  // A read is cut, never folded: folding would change lines an edit must match.
  const folded = readLike
    ? { text: collapseCarriageReturns(stripAnsi(source)), folded: 0 }
    : foldOutput(source);
  const limit = readLike ? READ_EXACT_BYTES : budget;
  const selected = readLike
    ? headOnly(folded.text, limit)
    : selectWithinBudget(folded.text, limit);
  const result = selected.text;
  // Not worth a pointer: under a tenth saved is noise against the notice itself.
  if (bytes(result) > size * 0.9) return null;
  return {
    text: result,
    readLike,
    folded: folded.folded,
    dropped: selected.dropped,
    originalBytes: size,
  };
}

/** A read past the exact cap: the first part of the file, whole lines, and a pointer. */
function headOnly(text, limit) {
  const lines = text.split('\n');
  const out = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const cost = bytes(lines[i]) + 1;
    if (used + cost > limit) break;
    out.push(lines[i]);
    used += cost;
  }
  return {
    text: out.join('\n'),
    dropped: lines.slice(i),
    firstDroppedLine: i + 1,
  };
}

/** The pointer line appended to a compacted output. Terse: it competes with content for the budget. */
function notice({ originalBytes, folded, dropped, readLike, path }) {
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  const parts = [`[token-optimizer: ${kb(originalBytes)} output compacted`];
  if (folded) parts.push(`${folded} repetitive lines folded`);
  if (dropped?.length) {
    const { errors, files } = namesIn(dropped);
    let d = `${dropped.length} lines omitted`;
    if (errors.length) d += ` (mentioning ${errors.join(', ')})`;
    else if (files.length) d += ` (from ${files.join(', ')})`;
    parts.push(d);
  }
  const how = readLike
    ? `full text: Read ${path} (use offset/limit for exact lines)`
    : `full output: Read ${path}`;
  return `${parts.join('; ')}; ${how}]`;
}

/**
 * The replacement for a Claude Code tool_response, or null to leave it alone.
 *
 * Shapes (Claude Code 2.1.302): Bash {stdout, stderr, interrupted, isImage,
 * noOutputExpected}; Grep {mode, numFiles, filenames, content, numLines,
 * totalLines}. Read is not compacted here: Claude Code already pages it, and a
 * Read is the one result an edit is built from.
 *
 * @param {{ tool: string, input: object, response: object, dir: string, sessionId?: string }} call
 */
export function compactToolResponse({
  tool,
  input,
  response,
  dir,
  sessionId = null,
}) {
  if (!response || typeof response !== 'object' || !dir) return null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (response.isImage) return null;
    const command = String(input?.command ?? '');
    // A shell search prints the same `path:line:text` the Grep tool does, and
    // gets the same lossless grouping first (see isShellSearchCommand). Not
    // when another statement reads a file: grouped output is compacted as a
    // search, which would fold that file's lines (`cat a.cs; grep -n X b.cs`).
    const grouped =
      typeof response.stdout === 'string' && isShellSearchCommand(command) && !isReadLikeCommand(command)
        ? groupGrepByFile(response.stdout)
        : null;
    const out = compactText(grouped ?? response.stdout, { command: grouped ? '' : command });
    const err = compactText(response.stderr, { command: '' });
    if (!out && !err) return grouped ? { ...response, stdout: grouped } : null;
    const replaced = grouped ? { ...response, stdout: grouped } : { ...response };
    for (const [key, done] of [
      ['stdout', out],
      ['stderr', err],
    ]) {
      if (!done) continue;
      const ref = capture(dir, response[key], {
        tool,
        command,
        sessionId,
        shape: key,
      });
      if (!ref) return null;
      replaced[key] =
        `${done.text}\n${notice({ ...done, path: artifactPath(dir, ref) })}`;
    }
    return replaced;
  }
  if ((tool === 'Agent' || tool === 'Task') && Array.isArray(response.content)) {
    const lean = leanHandoff(response, { dir, sessionId, tool });
    if (lean) return lean;
    return null;
  }
  if (tool === 'Grep' && typeof response.content === 'string') {
    // Lossless first: each file's path once instead of on every line.
    const grouped = groupGrepByFile(response.content);
    const done = compactText(grouped ?? response.content, { command: '' });
    if (!done) return grouped ? { ...response, content: grouped } : null;
    const ref = capture(dir, response.content, {
      tool,
      command: input?.pattern ?? null,
      sessionId,
      shape: 'grep',
    });
    if (!ref) return null;
    return {
      ...response,
      content: `${done.text}\n${notice({ ...done, path: artifactPath(dir, ref) })}`,
    };
  }
  return null;
}

/**
 * A shell command whose output is search hits: the last statement starts with
 * grep/rg/ag/git grep/Select-String/findstr, whatever it is piped into.
 *
 * WHY. Agents search through the shell far more than through the Grep tool:
 * 4,234 shell searches for 1.50M tokens in the local transcripts against a
 * handful of Grep calls, and grouping applied to none of them. Grouping only
 * rewrites lines shaped `path:N:` (and their `path-N-` context), so a search
 * piped into `wc -l` or `sort | uniq -c` passes through untouched.
 */
export function isShellSearchCommand(command) {
  // Any stage, not only the first: `git ls-files | xargs grep -n X` and
  // PowerShell's `Get-ChildItem -Recurse | Select-String X` print the same
  // `path:N:text`. Grouping is lossless and leaves non-hit lines alone, so a
  // stage that searches its input (`cat a | grep x`) costs nothing.
  return lastStatementStages(command).some((stage) =>
    /^(?:xargs\s+(?:-\S+\s+)*)?(grep|egrep|fgrep|rg|ag|git\s+(?:-C\s+\S+\s+)?grep|Select-String|sls|findstr)\b/i.test(
      stage
    )
  );
}

/** Below this a Grep result is left exactly as it is. */
export const GREP_GROUP_MIN_CHARS = 1000;
const GREP_GROUP_HEADER = '[grouped by file: each path once, then its line:text]';

/**
 * A content-mode Grep result with each file's path stated once, as `rg
 * --heading` prints it, instead of on every line. Lossless: every line number
 * and every matched or context line is kept verbatim.
 *
 * WHY. Claude Code prints `path:line:text` for each hit, and a path is often a
 * third of the line. On the exploration benchmark, grouping took Grep results
 * to 79.8% of their size (223k to 178k characters over 87 results), and every
 * later call of the agent re-reads them.
 *
 * SAFE ON ANY PATH. A path is taken only from a match line (`path:N:`), and the
 * lines after it are folded only while they start with that exact path and a
 * line number -- so a path with `-12-` in it, a drive letter, or a context line
 * before a file's first match is never mis-split; such a line passes verbatim.
 * Null when nothing would shrink by a tenth.
 */
/**
 * A "path" that is really the front of a clock time. `gh run view --log` piped
 * into Select-String prints `job<TAB>step<TAB>2026-10-16T13:56:14Z ...`, which
 * reads as path `...T13`, line 56 -- grouping it splits every timestamp and
 * hides the log line behind a bogus header. A real path has no tab and does not
 * end in an hour.
 */
const isClockPrefix = (path) => path.includes('\t') || /(?:^|\s|\d{2}T)\d{1,2}$/.test(path);

export function groupGrepByFile(text) {
  const source = String(text ?? '');
  if (source.length < GREP_GROUP_MIN_CHARS) return null;
  const out = [GREP_GROUP_HEADER];
  let path = null;
  for (const line of source.split('\n')) {
    if (path !== null && (line.startsWith(`${path}:`) || line.startsWith(`${path}-`))) {
      const rest = line.slice(path.length + 1);
      if (/^\d+[:-]/.test(rest)) {
        out.push(rest);
        continue;
      }
    }
    // Bounded, so a long line is scanned in linear time (regex-linearity.test.mjs).
    const m = /^([^\n]{1,400}?):(\d{1,9}):/.exec(line);
    if (m && !isClockPrefix(m[1])) {
      path = m[1];
      out.push(path, line.slice(path.length + 1));
      continue;
    }
    // `--` between context groups keeps the current file; anything else ends it.
    if (line !== '--') path = null;
    out.push(line);
  }
  const grouped = out.join('\n');
  return grouped.length <= source.length * 0.9 ? grouped : null;
}

/** A worker's report longer than this reaches its caller as a lean handoff. */
export const HANDOFF_MIN_CHARS = 4000;
/** What the caller reads in place of a long report. */
export const HANDOFF_BUDGET = 2400;

/**
 * OPT-IN (TOKEN_OPTIMIZER_LEAN_HANDOFF=1), and it also needs Agent|Task in the
 * PostToolUse matcher, which the shipped wiring leaves out (wire.mjs): across
 * the benchmarks no worker report reached HANDOFF_MIN_CHARS, so the hook on
 * every subagent completion was latency for nothing.
 */
export function leanHandoffEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.TOKEN_OPTIMIZER_LEAN_HANDOFF ?? '').trim());
}

/** A line a caller acts on: a file:line citation, a figure, a heading, a verdict. */
const CITATION = /(?<![\w./\\-])[\w./\\-]{1,200}\.\w{1,12}:\d+/;
// A bare number is not a signal: narration is full of them ("step 12").
const REPORT_SIGNAL =
  /\b\d[\d_,.]{0,20}\s?(?:%|ms|s|KB|MB|GB|tokens?|passed|failed|errors?|files?|lines?|tests?)\b|^#{1,4}\s|^\s*(?:[-*]|\d+\.)\s+\*\*|\b(?:PASS|FAIL|fixed|root cause|answer|result|blocked|error)\b/i;

/**
 * Lean handoffs: a subagent's long report, as its caller receives it.
 *
 * A worker's final report enters its caller's context in full and is re-read
 * on every one of the caller's later calls -- the caller being the agent with
 * the largest context in the run. Kept: the opening (where a report puts its
 * conclusion), every line that cites a file:line, a figure, a heading or a
 * verdict, and the ending; the full report one Read away in the artifact store.
 * Opt-in: see leanHandoffEnabled.
 */
export function leanHandoff(response, { dir, sessionId = null, tool = 'Agent' }) {
  if (!leanHandoffEnabled()) return null;
  const text = response.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  if (text.length <= HANDOFF_MIN_CHARS) return null;
  const lines = text.split('\n');
  const keep = new Array(lines.length).fill(false);
  let used = 0;
  const take = (i) => {
    if (i < 0 || i >= lines.length || keep[i]) return true;
    if (used + lines[i].length + 1 > HANDOFF_BUDGET) return false;
    keep[i] = true;
    used += lines[i].length + 1;
    return true;
  };
  // The opening, where a report states its conclusion.
  for (let i = 0, n = 0; i < lines.length && n < HANDOFF_BUDGET * 0.35; i++) {
    if (!take(i)) break;
    n += lines[i].length + 1;
  }
  // The ending, then every line a caller acts on.
  for (let i = lines.length - 1, n = 0; i >= 0 && n < HANDOFF_BUDGET * 0.15; i--) {
    if (!take(i)) break;
    n += lines[i].length + 1;
  }
  // Citations first -- they are what a caller acts on -- then the other signals.
  for (const re of [CITATION, REPORT_SIGNAL])
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && !take(i)) break;
  // A report in a few long lines keeps too little to act on: it goes through whole.
  if (used < HANDOFF_BUDGET / 2) return null;
  const ref = capture(dir, text, { tool, command: null, sessionId, shape: 'handoff' });
  if (!ref) return null;
  const out = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push(`  [… ${gap} lines …]`);
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push(`  [… ${gap} lines …]`);
  const notice = `[lean handoff: ${text.length} characters reported, the lines above kept; the full report: Read ${artifactPath(dir, ref)}]`;
  return { ...response, content: [{ type: 'text', text: `${out.join('\n')}\n${notice}` }] };
}
