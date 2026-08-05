import { describe, it, expect } from '@jest/globals';
import {
  parseCsvWithHeader,
  splitCsvLine,
} from '../../src/utils/csv-with-header.js';

/**
 * `schtasks /query /fo CSV /v` starts with HostName, not TaskName, and the
 * parser indexed from zero. Measured on this machine: smart_cron returned 404
 * jobs, every one named "SUPER-COMPUTER", none matching a real task -- and
 * because the system-task filter tests the name against '\Microsoft', which a
 * hostname never starts with, the filter that hides ~270 Microsoft tasks could
 * never fire. There are 24 real tasks.
 *
 * Reading the header instead of assuming it also survives the two things that
 * vary in the field: a locale that renames columns, and a schtasks version that
 * adds one.
 */

const SCHTASKS = [
  '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run"',
  '"SUPER-COMPUTER","\\Adobe Acrobat Update Task","8/2/2026 1:00:00 PM","Ready","Interactive/Background","8/1/2026 1:00:01 PM","0","Adobe Systems Incorporated","C:\\Program Files\\AdobeARM.exe"',
  '"SUPER-COMPUTER","\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready","Interactive/Background","7/30/2026 3:00:00 AM","0","Microsoft","defrag.exe"',
].join('\n');

describe('CSV with a header row', () => {
  const rows = parseCsvWithHeader(SCHTASKS);

  it('keys every column by its own name', () => {
    expect(rows[0].taskname).toBe('\\Adobe Acrobat Update Task');
    expect(rows[0].hostname).toBe('SUPER-COMPUTER');
    expect(rows[0].status).toBe('Ready');
    expect(rows[0].author).toBe('Adobe Systems Incorporated');
    expect(rows[0]['task to run']).toBe('C:\\Program Files\\AdobeARM.exe');
  });

  it('does not confuse the host name with the task name', () => {
    // Index 0 is HostName under /v. Reading it as the task name made every job
    // identical and disabled the \Microsoft filter entirely.
    expect(rows[0].taskname).not.toBe(rows[0].hostname);
    expect(rows.every((r) => r.taskname !== 'SUPER-COMPUTER')).toBe(true);
  });

  it('preserves the leading backslash the \\Microsoft filter depends on', () => {
    expect(rows[1].taskname.startsWith('\\Microsoft')).toBe(true);
  });

  it('strips the quoting', () => {
    expect(rows[0].taskname).not.toContain('"');
    expect(rows[0]['last result']).toBe('0');
  });

  it('skips a repeated header, which schtasks emits per folder', () => {
    const withRepeat = [
      SCHTASKS.split('\n')[0],
      SCHTASKS.split('\n')[1],
      SCHTASKS.split('\n')[0], // header again
      SCHTASKS.split('\n')[2],
    ].join('\n');

    const parsed = parseCsvWithHeader(withRepeat);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((r) => r.taskname)).toEqual([
      '\\Adobe Acrobat Update Task',
      '\\Microsoft\\Windows\\Defrag\\ScheduledDefrag',
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseCsvWithHeader('')).toEqual([]);
  });
});

describe('splitCsvLine', () => {
  it('keeps a comma inside a quoted field', () => {
    expect(splitCsvLine('"a,b","c"')).toEqual(['a,b', 'c']);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(splitCsvLine('"say ""hi""","x"')).toEqual(['say "hi"', 'x']);
  });

  it('keeps empty fields in place', () => {
    // Dropping them would shift every later column -- the exact failure this
    // whole module exists to prevent.
    expect(splitCsvLine('"a","","c"')).toEqual(['a', '', 'c']);
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});
