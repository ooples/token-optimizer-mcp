/**
 * Parsing for the Windows `net user` and `net localgroup` listings.
 *
 * Split out so it runs on a Linux CI runner -- every job here is ubuntu-latest,
 * so these branches had never been executed by a test, which is the same blind
 * spot that produced the wmic defects (see utils/wmic-csv.ts).
 *
 * BOTH LISTINGS WERE SPLIT ON WHITESPACE, which is wrong for both, though only
 * one of them failed visibly:
 *
 *   `net localgroup` prints ONE NAME PER LINE, prefixed with `*`. Splitting on
 *   whitespace turned `*Device Owners` into `*Device` and `Owners` and looked up
 *   each as a group. Measured on an ordinary desktop: 6 of 15 groups returned,
 *   and `Users` appeared TWICE -- once genuinely and once as the trailing token
 *   of `*Distributed COM Users`. Every multi-word group was lost, and the `*`
 *   was never stripped.
 *
 *   `net user` prints THREE FIXED-WIDTH COLUMNS of 25 characters. Splitting on
 *   whitespace happens to work until a username contains a space, at which
 *   point one account silently becomes two lookups that both fail. It is parsed
 *   by column here so the coincidence is not load-bearing.
 */

/** Width of each column in `net user` output. */
const NET_USER_COLUMN_WIDTH = 25;

/**
 * The rows between the `---` rule and the trailing status line.
 *
 * `net` localises its messages, so the terminator is matched on the rule and on
 * running out of content rather than on the English "The command completed
 * successfully." -- which the previous code tested for with a substring check
 * that a localised Windows would never match.
 */
function listingRows(stdout: string): string[] {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const ruleIndex = lines.findIndex((l) => l.includes('---'));
  if (ruleIndex === -1) return [];

  const rows: string[] = [];
  for (const line of lines.slice(ruleIndex + 1)) {
    if (!line.trim()) continue;
    // The status line is the only unindented sentence, and it ends with a
    // period; group and user names never do.
    if (/\.\s*$/.test(line.trim())) break;
    rows.push(line);
  }
  return rows;
}

/** Account names from `net user`, read as fixed-width columns. */
export function parseNetUserList(stdout: string): string[] {
  const names: string[] = [];

  for (const row of listingRows(stdout)) {
    for (let i = 0; i < row.length; i += NET_USER_COLUMN_WIDTH) {
      const name = row.slice(i, i + NET_USER_COLUMN_WIDTH).trim();
      if (name) names.push(name);
    }
  }

  return dedupe(names);
}

/** Group names from `net localgroup`: one per line, `*`-prefixed. */
export function parseNetLocalGroupList(stdout: string): string[] {
  const names: string[] = [];

  for (const row of listingRows(stdout)) {
    // The whole line is ONE name. Only the leading marker comes off.
    const name = row.trim().replace(/^\*/, '').trim();
    if (name) names.push(name);
  }

  return dedupe(names);
}

/**
 * Case-insensitive, order-preserving.
 *
 * Deduplication is not cosmetic here: the previous parser emitted `Users`
 * twice, and each duplicate cost another `net localgroup <name>` subprocess to
 * fetch details that were already known.
 */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
