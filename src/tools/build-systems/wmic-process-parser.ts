/**
 * Turns `wmic process get ... /format:csv` into ProcessInfo records.
 *
 * The column-order and embedded-comma hazards -- and why the naive parse was
 * wrong in four of five fields -- are documented in utils/wmic-csv.ts, which
 * two separate tools now share because both got the same mapping wrong. This
 * file only maps parsed columns onto the shape smart_processes returns.
 */

import {
  parseWmicCsvRows,
  lifetimeCpuPercent,
  numericField,
} from '../../utils/wmic-csv.js';

export { parseWmiDate, lifetimeCpuPercent } from '../../utils/wmic-csv.js';

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  command: string;
  user: string;
}

/**
 * The columns to request. WMIC reorders them alphabetically regardless, which
 * is precisely why the parser reads the header instead of assuming one.
 */
export const WMIC_PROCESS_COLUMNS =
  'ProcessId,Name,UserModeTime,KernelModeTime,WorkingSetSize,CreationDate,CommandLine';

/**
 * @param stdout Raw `wmic ... /format:csv` output.
 * @param now Epoch ms used for the CPU lifetime average.
 */
export function parseWmicProcessCsv(
  stdout: string,
  now: number = Date.now()
): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  for (const row of parseWmicCsvRows(stdout)) {
    const pid = numericField(row, 'ProcessId');
    const bytes = numericField(row, 'WorkingSetSize');
    const kernel = numericField(row, 'KernelModeTime');
    const user = numericField(row, 'UserModeTime');
    const name = row.Name;

    // A row missing any of these is dropped rather than contributing a process
    // with invented fields.
    if (pid === null || bytes === null || kernel === null || user === null)
      continue;
    if (!name) continue;

    processes.push({
      pid,
      name,
      cpu: lifetimeCpuPercent(kernel + user, row.CreationDate ?? '', now),
      memory: bytes / 1024 / 1024,
      command: row.CommandLine || name,
      user: 'current', // Win32_Process exposes the owner only via a per-process call.
    });
  }

  return processes;
}
