/**
 * Parsing for `wmic ... /format:csv`.
 *
 * Lives in utils because two unrelated tools shell out to wmic and BOTH got the
 * column mapping wrong in the same way. Splitting it out also means it can be
 * tested without a Windows host, which matters here: every CI job runs
 * ubuntu-latest, so these Windows branches had never been executed by a test
 * even once, which is exactly how both defects survived a green pipeline.
 *
 * TWO THINGS MAKE THE NAIVE PARSE WRONG:
 *
 * 1. WMIC EMITS COLUMNS ALPHABETICALLY, not in the order requested, and
 *    prepends `Node`. Asking for `ProcessId,Name,CommandLine,HandleCount,
 *    ThreadCount,WorkingSetSize,KernelModeTime,UserModeTime` returns
 *
 *      Node,CommandLine,HandleCount,KernelModeTime,Name,ProcessId,ThreadCount,UserModeTime,WorkingSetSize
 *
 *    Indexing by request order is therefore wrong for any field set whose
 *    alphabetical order differs from it -- which is most of them. Measured on a
 *    real table, one caller read `parseInt('explorer.exe')` as the pid (0 for
 *    every process), KernelModeTime as the name, and the hostname as the
 *    command.
 *
 * 2. A COMMAND LINE CONTAINS COMMAS -- 119 of 553 rows on one ordinary desktop.
 *    Those rows split into MORE fields than the header, so a `parts.length < n`
 *    guard never catches them; they silently shift every column after
 *    CommandLine.
 *
 * The fix for both is to read the header rather than assume it, and to treat
 * CommandLine as the one variable-width column: everything left of it is
 * counted from the start, everything right of it from the end, and whatever
 * remains in the middle is the command line, rejoined.
 */

/** The one column that can contain commas. */
const VARIABLE_WIDTH_COLUMN = 'CommandLine';

/**
 * Parse WMIC CSV into rows keyed by the header's own column names.
 *
 * @param stdout Raw `wmic ... /format:csv` output.
 * @returns One record per data row; malformed rows are dropped, never guessed at.
 */
export function parseWmicCsvRows(
  stdout: string
): Array<Record<string, string>> {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // WMIC prints a blank line or two before the header; the header is the first
  // line that mentions Node, which every /format:csv result carries.
  const headerIndex = lines.findIndex((l) => l.startsWith('Node,'));
  if (headerIndex === -1) return [];

  const columns = lines[headerIndex].split(',').map((c) => c.trim());
  const width = columns.length;
  const cmdIndex = columns.indexOf(VARIABLE_WIDTH_COLUMN);

  const rows: Array<Record<string, string>> = [];

  for (const line of lines.slice(headerIndex + 1)) {
    const parts = line.split(',');

    let values: string[];
    if (parts.length === width) {
      values = parts;
    } else if (cmdIndex !== -1 && parts.length > width) {
      // Extra fields can only have come from commas inside the command line.
      // Anchor the fixed columns to both ends and let the middle absorb them.
      const trailing = width - cmdIndex - 1;
      values = [
        ...parts.slice(0, cmdIndex),
        parts.slice(cmdIndex, parts.length - trailing).join(','),
        ...parts.slice(parts.length - trailing),
      ];
    } else {
      // Too few fields, or too many with no column that could hold a comma.
      // Dropped rather than mapped into a record that would read plausibly and
      // be wrong.
      continue;
    }

    const row: Record<string, string> = {};
    for (let i = 0; i < width; i++) row[columns[i]] = values[i];
    rows.push(row);
  }

  return rows;
}

/**
 * `yyyymmddHHMMSS.ffffff±UUU` -> epoch milliseconds, or null if unparseable.
 *
 * The suffix is an offset in MINUTES from UTC, not hours -- `-240` is UTC-4.
 */
export function parseWmiDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d+)$/.exec(
    value?.trim() ?? ''
  );
  if (!m) return null;

  const [, y, mo, d, h, mi, s, frac, offset] = m;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(Number(`0.${frac}`) * 1000)
  );
  return utc - Number(offset) * 60_000;
}

/**
 * CPU percentage on the same definition `ps aux` uses: CPU time consumed
 * divided by wall-clock time alive.
 *
 * Windows exposes only cumulative counters, so one sample cannot yield an
 * instantaneous percentage -- but a lifetime average is exactly what ps reports
 * too, which makes the two platforms comparable rather than merely both
 * populated.
 *
 * NOT clamped to 100. A process spread across many cores accumulates CPU time
 * faster than wall-clock; ps reports that honestly, and 2,653% for a 64-thread
 * job is the reading that distinguishes it from a single-threaded one.
 *
 * @param cpu100ns Kernel + user time, in 100-nanosecond ticks.
 * @param creationDate WMI datetime, e.g. `20260719223604.916473-240`.
 * @param now Epoch ms to measure against; injectable so tests are not clock-dependent.
 */
export function lifetimeCpuPercent(
  cpu100ns: number,
  creationDate: string,
  now: number
): number {
  const started = parseWmiDate(creationDate);
  if (started === null) return 0;

  const lifetimeSeconds = (now - started) / 1000;
  if (!(lifetimeSeconds > 0)) return 0;

  return (cpu100ns / 1e7 / lifetimeSeconds) * 100;
}

/** Reads a column as a finite number, or null when it is absent or not numeric. */
export function numericField(
  row: Record<string, string>,
  column: string
): number | null {
  const raw = row[column];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
