import { describe, it, expect } from '@jest/globals';
import {
  parseWmicProcessCsv,
  parseWmiDate,
  lifetimeCpuPercent,
} from '../../../src/tools/build-systems/wmic-process-parser.js';

/**
 * The Windows process path was wrong in every field but `pid`, and stayed wrong
 * through a fully green pipeline -- because every CI job runs ubuntu-latest, so
 * `getWindowsProcesses` had never been executed by a test even once.
 *
 * These run anywhere. The fixture is hand-built from the format measured on a
 * real machine rather than a captured dump, so no real command lines (which
 * carry paths, tokens and flags) are committed.
 *
 * The two defects being pinned:
 *
 *   1. WMIC emits columns ALPHABETICALLY, not in request order. Indexing by the
 *      order requested read CommandLine as the name, Name as the CPU figure
 *      (NaN -> 0 for every process, which is what made a default cpuThreshold
 *      filter the whole table away), UserModeTime as the memory (explorer.exe
 *      as 414,398 MB) and the hostname as the command.
 *
 *   2. Command lines contain commas -- 119 of 553 rows on one desktop -- which
 *      shifted every later column. The old guard `parts.length < 5` did not
 *      catch them because those rows have MORE fields, not fewer.
 */

const HEADER =
  'Node,CommandLine,CreationDate,KernelModeTime,Name,ProcessId,UserModeTime,WorkingSetSize';

/** UTC offset +000 keeps the fixture free of local-timezone dependence. */
const CREATED = '20260720000000.000000+000';
const CREATED_MS = Date.UTC(2026, 6, 20, 0, 0, 0, 0);
/** Ten seconds of wall-clock life, so CPU percentages are exact. */
const NOW = CREATED_MS + 10_000;

const rows = [
  // 5s of CPU over 10s alive -> 50%. Working set 320.5 MB.
  String.raw`HOST,C:\WINDOWS\Explorer.EXE,${CREATED},20000000,explorer.exe,15748,30000000,336076800`,
  // A command line with FOUR commas in it -- the row that used to be shredded.
  String.raw`HOST,"C:\Program Files\app.exe" --type=gpu --enable=a,b,c,d --quiet,${CREATED},10000000,app.exe,777,10000000,10485760`,
  // 80s of CPU over 10s alive -> 800%: a genuinely parallel process.
  String.raw`HOST,C:\bin\builder.exe,${CREATED},400000000,builder.exe,999,400000000,1048576`,
].join('\n');

const FIXTURE = `${HEADER}\n${rows}\n`;

describe('wmic CSV parsing', () => {
  const parsed = parseWmicProcessCsv(FIXTURE, NOW);

  it('skips the header and returns one entry per data row', () => {
    expect(parsed).toHaveLength(3);
    expect(parsed.map((p) => p.pid)).toEqual([15748, 777, 999]);
  });

  it('reads the process NAME, not the command line', () => {
    // The old mapping produced 'C:\WINDOWS\Explorer.EXE' here.
    expect(parsed[0].name).toBe('explorer.exe');
    expect(parsed.map((p) => p.name)).toEqual(['explorer.exe', 'app.exe', 'builder.exe']);
  });

  it('reads memory from WorkingSetSize, not UserModeTime', () => {
    expect(parsed[0].memory).toBeCloseTo(336076800 / 1024 / 1024, 3);
    // What the old mapping reported for this row -- off by four orders of
    // magnitude, and the reason a 100 MB threshold passed everything.
    expect(parsed[0].memory).not.toBeCloseTo(30000000 / 1024 / 1024, 0);
  });

  it('reads the command line, not the node name', () => {
    // Every process used to report the HOSTNAME as its command.
    expect(parsed[0].command).not.toBe('HOST');
    expect(parsed[0].command).toBe(String.raw`C:\WINDOWS\Explorer.EXE`);
  });

  it('keeps a command line that contains commas intact', () => {
    // Four commas inside the quoted argument; every one used to shift the
    // columns after it and corrupt name, pid and memory for the whole row.
    expect(parsed[1].command).toBe(
      String.raw`"C:\Program Files\app.exe" --type=gpu --enable=a,b,c,d --quiet`
    );
    // The tail is still read correctly despite them.
    expect(parsed[1].pid).toBe(777);
    expect(parsed[1].name).toBe('app.exe');
    expect(parsed[1].memory).toBeCloseTo(10485760 / 1024 / 1024, 3);
  });

  it('computes CPU as cputime/realtime, like ps', () => {
    // 5 CPU-seconds over 10 wall-seconds.
    expect(parsed[0].cpu).toBeCloseTo(50, 6);
    // Not the old value: parseInt('explorer.exe') is NaN, coerced to 0, for
    // every process on the machine.
    expect(parsed[0].cpu).not.toBe(0);
  });

  it('does not clamp CPU at 100% for a multi-core process', () => {
    // 80 CPU-seconds over 10 wall-seconds. Clamping made this identical to a
    // single-threaded process, hiding exactly what a process list is read for.
    expect(parsed[2].cpu).toBeCloseTo(800, 6);
  });

  it('drops a row whose trailing block is not numeric rather than inventing one', () => {
    const corrupt = `${HEADER}\nHOST,cmd,${CREATED},notanumber,x.exe,notapid,0,0\n`;
    expect(parseWmicProcessCsv(corrupt, NOW)).toHaveLength(0);
  });

  it('returns nothing for empty output instead of a fabricated process', () => {
    expect(parseWmicProcessCsv('', NOW)).toEqual([]);
    expect(parseWmicProcessCsv(`${HEADER}\n`, NOW)).toEqual([]);
  });
});

describe('WMI datetime parsing', () => {
  it('reads the fixed-width fields', () => {
    expect(parseWmiDate('20260720023604.916473+000')).toBe(Date.UTC(2026, 6, 20, 2, 36, 4, 916));
  });

  it('treats the suffix as MINUTES from UTC, not hours', () => {
    // -240 is UTC-4, so the same wall-clock reading is four hours later in UTC.
    const utc = parseWmiDate('20260720023604.000000+000')!;
    const minus4 = parseWmiDate('20260720023604.000000-240')!;
    expect(minus4 - utc).toBe(4 * 60 * 60 * 1000);
  });

  it('returns null for anything it cannot read', () => {
    expect(parseWmiDate('')).toBeNull();
    expect(parseWmiDate('not-a-date')).toBeNull();
    expect(parseWmiDate('2026072002360')).toBeNull();
  });
});

describe('lifetime CPU percentage', () => {
  it('is zero when the creation date is unusable rather than NaN', () => {
    expect(lifetimeCpuPercent(1e9, 'garbage', NOW)).toBe(0);
  });

  it('is zero for a process that has not yet aged, rather than Infinity', () => {
    expect(lifetimeCpuPercent(1e9, CREATED, CREATED_MS)).toBe(0);
    expect(Number.isFinite(lifetimeCpuPercent(1e9, CREATED, CREATED_MS))).toBe(true);
  });
});
