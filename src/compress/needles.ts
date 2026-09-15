/**
 * Rows that must survive an elision whatever their shape.
 *
 * WHY SHAPE ALONE IS NOT ENOUGH. The array engine decides what to keep from
 * key structure: a row carrying a key most rows lack, or missing one most rows
 * have, is kept. That works when the special record announces itself with an
 * `error` or `uuid` field, and fails completely when every row has the same two
 * keys and the signal lives in the VALUES.
 *
 * Measured on HeadRoom's own agentic-conversation fixture: 48 rows, all of them
 * `{content, role}`, so zero rows were flagged anomalous, the engine kept three
 * head rows and elided the other forty-five, and every needle went with them --
 * 0 of 12 UUIDs and 0 of 1 error markers survived a 99.6% reduction. A number
 * like that is not compression, it is data loss with a pointer.
 *
 * So content is inspected too. These are deliberately narrow patterns: an
 * identifier someone could search for, and the vocabulary of something having
 * gone wrong. Both are the things a reader came back for.
 */

/** A v4-shaped identifier, which is what a caller greps for. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The vocabulary of failure.
 *
 * Word-bounded, so `errors: 0` in a summary line does not pin a row, and
 * case-sensitive on the SHOUTED forms because a log level is upper case while
 * prose saying "error" casually is not.
 */
const TROUBLE =
  /\b(ERROR|CRITICAL|FATAL|SEVERE|PANIC)\b|\b(?:Exception|Traceback|stack trace|stacktrace)\b/;

/** A token long enough to be an identifier rather than a word. */
const LONG_HEX = /\b[0-9a-f]{16,}\b/i;

/**
 * Does this row carry something a reader would come back for?
 *
 * Applied to the row's serialised text rather than its keys, because the whole
 * point is to catch signal that structure cannot see.
 */
export function carriesNeedle(row: unknown): boolean {
  let text: string;
  try {
    text = typeof row === 'string' ? row : (JSON.stringify(row) ?? '');
  } catch {
    // A row that cannot be serialised cannot be inspected, and guessing would
    // be worse than declining: it stays eligible for elision.
    return false;
  }
  if (!text) return false;
  return UUID.test(text) || TROUBLE.test(text) || LONG_HEX.test(text);
}

/**
 * Indices of rows that must be kept.
 *
 * BOUNDED, because a rule that can keep everything is not a rule. If most of
 * the array looks like a needle then the array is made of needles, the term has
 * stopped discriminating, and honouring it would simply disable compression --
 * the failure mode this engine already has at the other extreme, where a
 * heterogeneous array flags every row as anomalous and nothing is ever elided.
 *
 * Above the share, the earliest rows win. They are the ones a reader reaches
 * first and the ones an elision marker's line range makes it easiest to recover
 * around.
 */
export function needleRows(
  rows: readonly unknown[],
  maxShare = 0.25
): Set<number> {
  const found: number[] = [];
  rows.forEach((row, index) => {
    if (carriesNeedle(row)) found.push(index);
  });
  const cap = Math.max(1, Math.floor(rows.length * maxShare));
  return new Set(found.slice(0, cap));
}

/**
 * One representative index per distinct shape, in first-seen order.
 *
 * THE OTHER HALF OF THE SAME DEFECT. `anomalousRows` asks whether a row departs
 * from a single common key set, which presumes the array HAS one. HeadRoom's
 * database-rows fixture is three interleaved tables -- users, transactions,
 * metrics -- sharing only `id`, so every one of its 300 rows counted as
 * anomalous, the keep set swallowed the array, and nothing was elided at all:
 * 25.7% against their 60.0%, and the whole gap was a rule that had stopped
 * discriminating.
 *
 * Grouping by shape keeps what the anomaly rule was protecting -- one example
 * of every structure present -- without keeping all of them.
 */
export function shapeRepresentatives(
  rows: readonly unknown[],
  perShape = 1
): Set<number> {
  const seen = new Map<string, number>();
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const signature = Object.keys(row as Record<string, unknown>)
      .sort()
      .join(',');
    const count = seen.get(signature) ?? 0;
    if (count < perShape) {
      keep.add(index);
      seen.set(signature, count + 1);
    }
  });
  return keep;
}
