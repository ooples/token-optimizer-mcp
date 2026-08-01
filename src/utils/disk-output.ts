/**
 * Parsing for the disk-usage commands smart_system_metrics shells out to.
 *
 * Split out so it can be tested without a Windows host. Every CI job runs
 * ubuntu-latest, so the `win32` branch had never been executed by a test -- the
 * same blind spot that let the wmic process-column defects survive a green
 * pipeline (see utils/wmic-csv.ts).
 */

export interface DiskUsage {
  path: string;
  total: number;
  used: number;
  free: number;
  usagePercent: number;
}

/** Rounds to two decimals, matching what the tool has always reported. */
const pct = (used: number, total: number): number =>
  Math.round((used / total) * 100 * 100) / 100;

/**
 * Parse `wmic logicaldisk get size,freespace,caption`.
 *
 * Columns come back alphabetically -- Caption, FreeSpace, Size -- which for
 * this field set happens to equal the requested order, so the indices are
 * right. The defects were elsewhere:
 *
 *   THE REQUESTED DRIVE WAS IGNORED. The row was chosen with
 *   `lines.find(l => l.includes('C:'))`, so every path handed to the tool came
 *   back with the system drive. On a machine with C: (23 GB free) and F:
 *   (487 GB free), asking about F: reported C:. Callers pass a LIST of paths
 *   precisely because they expect one answer per path.
 *
 *   A DRIVE WITH NO MEDIA reports blank Size and FreeSpace -- an empty card
 *   reader or optical drive. `parseInt('')` is NaN, which flowed into `used`
 *   and a NaN usagePercent that nothing rejected.
 *
 * @param output Raw command output.
 * @param path The path whose drive is wanted; a path with no drive letter takes
 *   the first drive listed, which preserves the behaviour of the `/` default.
 */
export function parseWindowsDiskOutput(
  output: string,
  path: string
): DiskUsage | null {
  const lines = output.split('\n').filter((l) => l.trim());
  const drive = /^([A-Za-z]:)/.exec(path)?.[1]?.toUpperCase();

  const dataLine = lines.find((l) => {
    const caption = l.trim().split(/\s+/)[0]?.toUpperCase();
    if (!caption?.endsWith(':')) return false; // skips the header
    return drive ? caption === drive : true;
  });
  if (!dataLine) return null;

  const parts = dataLine.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const free = parseInt(parts[1], 10);
  const total = parseInt(parts[2], 10);
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0)
    return null;

  const used = total - free;
  return { path: parts[0], total, used, free, usagePercent: pct(used, total) };
}

/**
 * Parse `df -k <path>`.
 *
 * df wraps onto a second line when the device name is long, which is common for
 * mapped volumes and container overlays. Taking `lines[1]` blindly then read a
 * line holding only the device name, failed the field-count guard and returned
 * null -- reporting no disk at all rather than the disk. The numeric row is now
 * located by content instead of by position.
 */
export function parseUnixDiskOutput(
  output: string,
  path: string
): DiskUsage | null {
  const lines = output.split('\n').filter((l) => l.trim());

  // Skip the header, then take the first row that actually carries the numbers.
  const dataLine = lines.slice(1).find((l) => {
    const parts = l.trim().split(/\s+/);
    return parts.length >= 5 && parts.some((p) => /^\d+%$/.test(p));
  });
  if (!dataLine) return null;

  const parts = dataLine.trim().split(/\s+/);
  // A wrapped row begins with the numbers; an unwrapped one begins with the
  // device. Anchor on the percentage column, which is always fourth from the
  // filesystem's numbers.
  const pctIndex = parts.findIndex((p) => /^\d+%$/.test(p));
  if (pctIndex < 3) return null;

  const total = parseInt(parts[pctIndex - 3], 10) * 1024;
  const used = parseInt(parts[pctIndex - 2], 10) * 1024;
  const free = parseInt(parts[pctIndex - 1], 10) * 1024;
  const usagePercent = parseFloat(parts[pctIndex]);

  if (
    !Number.isFinite(total) ||
    !Number.isFinite(used) ||
    !Number.isFinite(free)
  )
    return null;
  if (!Number.isFinite(usagePercent)) return null;

  return { path, total, used, free, usagePercent };
}
