/**
 * Compacting a command's output against its own previous run.
 *
 * WHY THIS IS NOT THE DANGEROUS VERSION OF DEDUP. Dropping every line a command
 * repeated is the obvious design and it destroys the one signal a debug loop
 * exists to carry: a test that fails IDENTICALLY twice has its failure elided,
 * and the model reads the silence as "fixed". That would be a silent change of
 * meaning, which is the defect class this wrapper has already produced nine of.
 *
 * The comparison that matters is not against the command's full output -- the
 * model never sees that, because the bound already drops the middle wholesale.
 * It is against WHAT WE SHIP TODAY: a head and a tail with everything between
 * them gone. Measured against that baseline, compaction is strictly better on
 * both axes at once:
 *
 *   the ENDING is untouched      the same trailing bytes survive verbatim, so
 *                                the summary line that says how many tests
 *                                failed is exactly as reliable as it is today
 *   the MIDDLE carries more      the head region is filled with lines this run
 *                                did NOT repeat, instead of whatever happened
 *                                to come first
 *
 * So the worst case is the current behaviour, and the common case shows strictly
 * more of what changed. A model can still be left knowing that N tests fail
 * without seeing each one -- but that is already true of the bound today, and
 * the remedy is unchanged: run the one test again.
 */

/** Bytes of the ending that are never eligible for elision. */
const DEFAULT_TAIL_SHARE = 0.5;

/** Line-splitting that survives CRLF, since half of these runs are on Windows. */
const splitLines = (text) => text.split(/\r?\n/);

/**
 * The form of a line used to decide whether it is the SAME line as before.
 *
 * A run stamps a duration on nearly everything it prints -- `PASS a.test.ts
 * (3 ms)` becomes `(4 ms)` next time -- so comparing raw text found almost
 * nothing in common between two runs of the same suite. Measured: a loop whose
 * consecutive runs were 98.2% identical once durations were normalised matched
 * on almost no lines without it, and compaction bought nothing at all.
 *
 * DURATIONS ONLY, NEVER BARE NUMBERS. Masking every digit would make
 * `Tests: 1 failed` and `Tests: 2 failed` the same line, and the second would be
 * dropped as a repeat -- inventing exactly the false "nothing changed" this
 * module is built to avoid. The mask is limited to a number immediately
 * followed by a time unit.
 *
 * The KEY is normalised; the line that gets EMITTED is always the original, so
 * the model still sees the real timings.
 */
const comparisonKey = (line) =>
  line
    .trimEnd()
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s|m|µs|us|ns)\b/gi, '<t>')
    .replace(/\d+(?:\.\d+)?\s*(?:seconds?|milliseconds?|minutes?)\b/gi, '<t>');

/**
 * Takes whole lines from the START of `text` while they fit in `maxBytes`.
 *
 * Whole lines, because a head cut mid-line leaves a fragment that reads as a
 * real line and can be mistaken for one -- `at Objec` is not a stack frame.
 */
function headLines(text, maxBytes) {
  if (maxBytes <= 0) return '';

  const out = [];
  let used = 0;

  for (const line of splitLines(text)) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (used + cost > maxBytes) break;
    out.push(line);
    used += cost;
  }

  return out.join('\n');
}

/** The last `maxBytes` of `text`, exactly as the shell's `tail -c` would. */
function tailBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';

  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(buffer.length - maxBytes).toString('utf8');
}

/**
 * The output to show for this run.
 *
 * `previous` is the previous run's output, or null/empty when there is none --
 * in which case this degrades to exactly the head-and-tail bound, so a first
 * run is never treated differently from today.
 */
export function compact(text, { previous = '', maxBytes = 8000 } = {}) {
  const source = String(text ?? '');
  const keepTail = Math.floor(maxBytes * DEFAULT_TAIL_SHARE);
  const ending = tailBytes(source, keepTail);

  // Everything the ending already covers is off limits: eliding a line there
  // would put the summary at risk, which is the one thing that must not happen.
  const bodyLength = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(ending, 'utf8');
  const body = Buffer.from(source, 'utf8').subarray(0, Math.max(0, bodyLength)).toString('utf8');

  const budget = maxBytes - Buffer.byteLength(ending, 'utf8');

  if (!previous) {
    const head = tailBytes(body, budget) === body ? body : headLines(body, budget);
    return head + ending;
  }

  const seen = new Set(splitLines(previous).map(comparisonKey));
  const bodyLines = splitLines(body);

  const fresh = [];
  let omitted = 0;
  for (const line of bodyLines) {
    // A blank line carries no information either way, and treating blanks as
    // "seen" would glue unrelated blocks together.
    if (line.trim() && seen.has(comparisonKey(line))) {
      omitted += 1;
      continue;
    }
    fresh.push(line);
  }

  if (!omitted) {
    const head = headLines(body, budget);
    return head + ending;
  }

  // TERSE ON PURPOSE. The notice is metadata and the fresh lines are the point,
  // but they compete for the same budget -- and a wordy version lost that
  // competition: at a 400-byte budget it left 24 bytes for the body and dropped
  // the single new failure line to make room for prose about dropping lines.
  // At the shipped 8,000 this never bit, which is exactly why it was worth
  // catching at a small one.
  const notice = `[token-optimizer: ${omitted} repeated lines omitted; ending intact]\n`;

  const head = headLines(fresh.join('\n'), budget - Buffer.byteLength(notice, 'utf8'));
  return notice + head + ending;
}
