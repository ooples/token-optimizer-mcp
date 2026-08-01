import { describe, it, expect } from '@jest/globals';
import { parseWmicCsvRows, numericField } from '../../src/utils/wmic-csv.js';

/**
 * Two separate tools shell out to wmic, and BOTH indexed the CSV by the order
 * they requested the fields in. WMIC emits columns alphabetically behind a
 * `Node` column, so both were reading the wrong values -- and neither was ever
 * executed by a test, because every CI job runs ubuntu-latest.
 *
 * These fixtures use the exact headers the two callers produce, taken from real
 * output, so the alphabetical reordering is reproduced rather than described.
 * Values are synthetic: real command lines carry paths and tokens.
 */

/** What `smart_process` asks for, as wmic actually returns it. */
const PROCESS_HEADER =
  'Node,CommandLine,CreationDate,HandleCount,KernelModeTime,Name,ProcessId,ThreadCount,UserModeTime,WorkingSetSize';

describe('wmic CSV rows are keyed by the header, not by request order', () => {
  it('maps every column to its own name', () => {
    const csv = [
      PROCESS_HEADER,
      String.raw`HOST,C:\WINDOWS\Explorer.EXE,20260720000000.000000+000,7407,318334375000,explorer.exe,15748,485,435746406250,336814080`,
    ].join('\n');

    const [row] = parseWmicCsvRows(csv);

    // The old mapping read parts[4] as the pid ('explorer.exe' -> NaN -> 0),
    // parts[3] as the name, parts[0] as the command and parts[1] as handles.
    expect(row.ProcessId).toBe('15748');
    expect(row.Name).toBe('explorer.exe');
    expect(row.CommandLine).toBe(String.raw`C:\WINDOWS\Explorer.EXE`);
    expect(row.HandleCount).toBe('7407');
    expect(row.ThreadCount).toBe('485');
    expect(row.WorkingSetSize).toBe('336814080');
    expect(row.KernelModeTime).toBe('318334375000');
    expect(row.UserModeTime).toBe('435746406250');
  });

  it('survives a command line full of commas', () => {
    // 119 of 553 rows on one desktop split into more fields than the header.
    const csv = [
      PROCESS_HEADER,
      String.raw`HOST,"C:\app.exe" --enable=a,b,c,d --also=e,f,20260720000000.000000+000,10,20,app.exe,777,4,30,1048576`,
    ].join('\n');

    const [row] = parseWmicCsvRows(csv);

    expect(row.CommandLine).toBe(String.raw`"C:\app.exe" --enable=a,b,c,d --also=e,f`);
    // Everything after the command line is still read correctly.
    expect(row.Name).toBe('app.exe');
    expect(row.ProcessId).toBe('777');
    expect(row.WorkingSetSize).toBe('1048576');
    expect(row.HandleCount).toBe('10');
  });

  it('handles a header where CommandLine is not the first data column', () => {
    // Proves the anchoring is driven by the header rather than by a fixed
    // assumption about where the variable-width column sits.
    const csv = [
      'Node,Caption,CommandLine,Name,ProcessId',
      'HOST,Some Caption,a.exe --x=1,2,3,a.exe,42',
    ].join('\n');

    const [row] = parseWmicCsvRows(csv);

    expect(row.Caption).toBe('Some Caption');
    expect(row.CommandLine).toBe('a.exe --x=1,2,3');
    expect(row.Name).toBe('a.exe');
    expect(row.ProcessId).toBe('42');
  });

  it('drops a short row rather than shifting every column into it', () => {
    const csv = [PROCESS_HEADER, 'HOST,onlytwo'].join('\n');
    expect(parseWmicCsvRows(csv)).toEqual([]);
  });

  it('drops an over-wide row when no column could hold a comma', () => {
    const csv = ['Node,Name,ProcessId', 'HOST,a.exe,1,extra'].join('\n');
    expect(parseWmicCsvRows(csv)).toEqual([]);
  });

  it('returns nothing when there is no header at all', () => {
    expect(parseWmicCsvRows('')).toEqual([]);
    expect(parseWmicCsvRows('some error text\n')).toEqual([]);
  });

  it('skips the blank lines wmic prints before the header', () => {
    const csv = ['', '  ', PROCESS_HEADER, 'HOST,c,20260720000000.000000+000,1,2,n.exe,9,3,4,5'].join(
      '\n'
    );
    const rows = parseWmicCsvRows(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].ProcessId).toBe('9');
  });
});

describe('numericField', () => {
  const row = { A: '42', B: '', C: 'explorer.exe', D: '0' };

  it('reads a number', () => {
    expect(numericField(row, 'A')).toBe(42);
    expect(numericField(row, 'D')).toBe(0);
  });

  it('returns null rather than 0 for anything unusable', () => {
    // `parseInt(...) || 0` was the old idiom, and it is why a non-numeric
    // column silently became a valid-looking pid of 0 for 175 of 200 processes.
    expect(numericField(row, 'B')).toBeNull();
    expect(numericField(row, 'C')).toBeNull();
    expect(numericField(row, 'missing')).toBeNull();
  });
});
