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
 * READ_EXACT_BYTES (an edit needs the exact text: HeadRoom keeps file reads
 * byte-exact for the same reason); any line that names a failure, which is
 * the signal a debug loop exists to carry.
 */
import { createHash } from 'node:crypto';
import { capture, artifactPath } from './expand.mjs';

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
  String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');

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
const SUMMARY = /^\s*(=+.*=+|Tests?:|Test Suites:|Ran \d+ tests?|\d+ (passed|failed)|OK\b|FAILED\b|Build (succeeded|FAILED)|\d+ Warning\(s\)|\d+ Error\(s\)|Time:)/i;

/** The shape of a line, for spotting a block of near-identical ones: numbers masked. */
const shapeOf = (line) =>
  line
    .trimEnd()
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ');

/**
 * A machine-generated line no structural compressor can shrink: minified code,
 * base64, source maps. HeadRoom 0.41 (#3685, dense_line_elider.py) uses the same
 * predicate -- 300+ characters, under 6% spaces, not JSON-shaped.
 */
export function isDenseLine(line) {
  if (line.length < 300 || line.includes('\t')) return false;
  const t = line.trim();
  if (/^[[{]/.test(t) && /[\]}],?$/.test(t)) return false;
  let spaces = 0;
  for (const ch of line) if (ch === ' ') spaces++;
  return spaces / line.length < 0.06;
}

const elideDense = (line) =>
  `${line.slice(0, 160)}…[${line.length - 240} chars elided]…${line.slice(-80)}`;

/** Names worth reporting from lines that were dropped, so the model can judge whether to look. */
function namesIn(lines, limit = 5) {
  const errors = new Set();
  const files = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(/\b([A-Z][A-Za-z]*(?:Error|Exception|Warning))\b/g)) errors.add(m[1]);
    for (const m of l.matchAll(/[\w./\\-]+\.(?:py|ts|tsx|js|mjs|cs|go|rs|java|kt|rb|php|cpp|c|h)\b/g)) files.add(m[0]);
    if (errors.size >= limit && files.size >= limit) break;
  }
  return { errors: [...errors].slice(0, limit), files: [...files].slice(0, limit) };
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
  const seen = new Map();
  const out = [];
  let folded = 0;
  lines.forEach((line, i) => {
    const s = shapeOf(line);
    const n = counts.get(s) ?? 0;
    if (n < FOLD_MIN_REPEATS) {
      out.push(isDenseLine(line) ? elideDense(line) : line);
      return;
    }
    const k = (seen.get(s) ?? 0) + 1;
    seen.set(s, k);
    if (k <= FOLD_KEEP_FIRST || i === lastIndex.get(s)) {
      out.push(line);
      if (k === FOLD_KEEP_FIRST) out.push(`  [… ${n - FOLD_KEEP_FIRST - 1} more lines like the above …]`);
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

/** A command whose output IS the content of a file: an edit may need it byte-exact. */
export function isReadLikeCommand(command) {
  const first = String(command ?? '')
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim().replace(/^(?:cd\s+\S+\s*)$/, ''))
    .filter(Boolean)
    .pop() ?? '';
  return /^(cat|type|head|tail|less|more|bat|nl|Get-Content|gc)\b|^sed\s+-n\b|^git\s+(show|cat-file\s+-p)\b|^awk\s+'NR/.test(first);
}

/**
 * The compacted text for one output, or null when it should reach the model
 * unchanged.
 *
 * @param {string} text
 * @param {{ command?: string, budget?: number }} options
 */
export function compactText(text, { command = '', budget = OUTPUT_BUDGET_BYTES } = {}) {
  const source = String(text ?? '');
  const size = bytes(source);
  if (size < OUTPUT_COMPACT_MIN_BYTES) return null;
  const readLike = isReadLikeCommand(command);
  if (readLike && size <= READ_EXACT_BYTES) return null;
  // A read is cut, never folded: folding would change lines an edit must match.
  const folded = readLike ? { text: collapseCarriageReturns(stripAnsi(source)), folded: 0 } : foldOutput(source);
  const limit = readLike ? READ_EXACT_BYTES : budget;
  const selected = readLike ? headOnly(folded.text, limit) : selectWithinBudget(folded.text, limit);
  const result = selected.text;
  // Not worth a pointer: under a tenth saved is noise against the notice itself.
  if (bytes(result) > size * 0.9) return null;
  return { text: result, readLike, folded: folded.folded, dropped: selected.dropped, originalBytes: size };
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
  return { text: out.join('\n'), dropped: lines.slice(i), firstDroppedLine: i + 1 };
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
  const how = readLike ? `full text: Read ${path} (use offset/limit for exact lines)` : `full output: Read ${path}`;
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
export function compactToolResponse({ tool, input, response, dir, sessionId = null }) {
  if (!response || typeof response !== 'object' || !dir) return null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (response.isImage) return null;
    const command = String(input?.command ?? '');
    const out = compactText(response.stdout, { command });
    const err = compactText(response.stderr, { command: '' });
    if (!out && !err) return null;
    const replaced = { ...response };
    for (const [key, done] of [['stdout', out], ['stderr', err]]) {
      if (!done) continue;
      const ref = capture(dir, response[key], { tool, command, sessionId, shape: key });
      if (!ref) return null;
      replaced[key] = `${done.text}\n${notice({ ...done, path: artifactPath(dir, ref) })}`;
    }
    return replaced;
  }
  if (tool === 'Grep' && typeof response.content === 'string') {
    const done = compactText(response.content, { command: '' });
    if (!done) return null;
    const ref = capture(dir, response.content, { tool, command: input?.pattern ?? null, sessionId, shape: 'grep' });
    if (!ref) return null;
    return { ...response, content: `${done.text}\n${notice({ ...done, path: artifactPath(dir, ref) })}` };
  }
  return null;
}

/** Stable identity for tests and telemetry. */
export const responseDigest = (response) =>
  createHash('sha256').update(JSON.stringify(response ?? null)).digest('hex').slice(0, 12);
