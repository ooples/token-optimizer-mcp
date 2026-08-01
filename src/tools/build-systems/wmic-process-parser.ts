/**
 * Parsing for `wmic process get ... /format:csv`.
 *
 * Split out of smart-processes.ts so it can be tested without a Windows host.
 * Every CI job runs ubuntu-latest, so the Windows branch of the process tool
 * had never once been executed by the test suite -- which is how the mapping
 * below stayed wrong through a green pipeline.
 *
 * TWO THINGS MAKE THE NAIVE PARSE WRONG:
 *
 * 1. WMIC EMITS COLUMNS ALPHABETICALLY, not in the order requested. Asking for
 *    `ProcessId,Name,UserModeTime,KernelModeTime,WorkingSetSize,CreationDate,
 *    CommandLine` produces
 *
 *      Node,CommandLine,CreationDate,KernelModeTime,Name,ProcessId,UserModeTime,WorkingSetSize
 *
 *    Indexing by request order read the command line as the name, the process
 *    name as the CPU figure (NaN, so every process reported 0%), the user time
 *    as the memory (explorer.exe came out as 414,398 MB) and the hostname as
 *    the command.
 *
 * 2. A COMMAND LINE CONTAINS COMMAS -- 119 of 553 rows on one ordinary desktop.
 *    Those rows split into more fields than expected and shifted every column
 *    after CommandLine, and the only guard (`parts.length < 5`) let them
 *    through because they had MORE fields, not fewer.
 *
 * Both are fixed by anchoring to the END of the row: the trailing six values
 * are all comma-free, so counting from the right is stable however many commas
 * the command line holds, and everything between the node name and that tail
 * is the command line, rejoined.
 */

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  command: string;
  user: string;
}

/** The columns this parser expects, in the order WMIC actually emits them. */
export const WMIC_PROCESS_COLUMNS =
  'ProcessId,Name,UserModeTime,KernelModeTime,WorkingSetSize,CreationDate,CommandLine';

/** How many trailing columns are guaranteed free of commas. */
const TAIL_COLUMNS = 6;

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
 * instantaneous percentage -- but a lifetime average is exactly what ps
 * reports too, which makes the two platforms comparable rather than merely
 * both populated.
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

/**
 * Parse WMIC CSV output into processes, skipping the header and any row whose
 * trailing block is not numeric.
 *
 * @param stdout Raw `wmic ... /format:csv` output.
 * @param now Epoch ms used for the CPU lifetime average.
 */
export function parseWmicProcessCsv(
  stdout: string,
  now: number = Date.now()
): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  for (const line of stdout.split('\n')) {
    const row = line.trim();
    if (!row || !row.includes(',')) continue;

    const parts = row.split(',');
    // Node plus the six requested columns.
    if (parts.length < TAIL_COLUMNS + 1) continue;

    const [creationDate, kernelTime, name, processId, userTime, workingSet] =
      parts.slice(-TAIL_COLUMNS);

    const pid = Number(processId);
    const kernel = Number(kernelTime);
    const user = Number(userTime);
    const bytes = Number(workingSet);

    // Doubles as the header check and as validation that this row's tail really
    // is the numeric block. A misaligned row fails it and is dropped rather
    // than contributing a fabricated process -- the header line fails it
    // because `ProcessId` is not a number.
    if (!Number.isFinite(pid) || !Number.isFinite(kernel)) continue;
    if (!Number.isFinite(user) || !Number.isFinite(bytes)) continue;
    if (!name) continue;

    processes.push({
      pid,
      name,
      cpu: lifetimeCpuPercent(kernel + user, creationDate, now),
      memory: bytes / 1024 / 1024,
      command: parts.slice(1, -TAIL_COLUMNS).join(',') || name,
      user: 'current', // Win32_Process exposes the owner only via a per-process call.
    });
  }

  return processes;
}
