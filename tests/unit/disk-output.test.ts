import { describe, it, expect } from '@jest/globals';
import {
  parseWindowsDiskOutput,
  parseUnixDiskOutput,
} from '../../src/utils/disk-output.js';

/**
 * smart_system_metrics takes a LIST of disk paths and answers one per path.
 * On Windows it answered with the system drive every time, because the row was
 * chosen with `lines.find(l => l.includes('C:'))`. Measured on a machine with
 * two drives, asking about F: (487 GB free) reported C: (23 GB free).
 *
 * The `win32` branch had never been executed by a test, because every CI job
 * runs ubuntu-latest -- the same blind spot behind the wmic process defects.
 * These fixtures are real command output, so they run anywhere.
 */

const WMIC_TWO_DRIVES = [
  'Caption  FreeSpace     Size           ',
  'C:       23141736448   940228734976   ',
  'F:       487745335296  1059126767616  ',
].join('\n');

describe('windows disk output', () => {
  it('answers for the drive that was asked about', () => {
    const f = parseWindowsDiskOutput(WMIC_TWO_DRIVES, 'F:\\data');

    // Was: C:'s numbers, for every path.
    expect(f?.path).toBe('F:');
    expect(f?.total).toBe(1059126767616);
    expect(f?.free).toBe(487745335296);
  });

  it('still answers correctly for the system drive', () => {
    const c = parseWindowsDiskOutput(WMIC_TWO_DRIVES, 'C:\\Users\\someone');

    expect(c?.path).toBe('C:');
    expect(c?.total).toBe(940228734976);
    expect(c?.free).toBe(23141736448);
  });

  it('gives different answers for different drives', () => {
    const c = parseWindowsDiskOutput(WMIC_TWO_DRIVES, 'C:\\');
    const f = parseWindowsDiskOutput(WMIC_TWO_DRIVES, 'F:\\');

    expect(c?.path).not.toBe(f?.path);
    expect(c?.free).not.toBe(f?.free);
  });

  it('computes usage from the drive it reported', () => {
    const f = parseWindowsDiskOutput(WMIC_TWO_DRIVES, 'F:\\');
    // (1059126767616 - 487745335296) / 1059126767616 = 53.95%
    expect(f?.usagePercent).toBeCloseTo(53.95, 2);
  });

  it('falls back to the first drive when the path has no drive letter', () => {
    // The tool's default diskPaths is ['/'], which has no letter on Windows.
    const d = parseWindowsDiskOutput(WMIC_TWO_DRIVES, '/');
    expect(d?.path).toBe('C:');
  });

  it('returns null for a drive with no media rather than NaN', () => {
    // An empty card reader or optical drive reports blank Size and FreeSpace.
    // parseInt('') is NaN, which used to flow straight into usagePercent.
    const output = [
      'Caption  FreeSpace  Size',
      'D:                        ',
    ].join('\n');
    expect(parseWindowsDiskOutput(output, 'D:\\')).toBeNull();
  });

  it('returns null when the requested drive is absent', () => {
    expect(parseWindowsDiskOutput(WMIC_TWO_DRIVES, 'Z:\\')).toBeNull();
  });
});

describe('unix disk output', () => {
  const DF = [
    'Filesystem     1K-blocks      Used Available Use% Mounted on',
    '/dev/sda1      102687672  61374416  36062516  63% /',
  ].join('\n');

  it('reads the usual single-line row', () => {
    const d = parseUnixDiskOutput(DF, '/');

    expect(d?.total).toBe(102687672 * 1024);
    expect(d?.used).toBe(61374416 * 1024);
    expect(d?.free).toBe(36062516 * 1024);
    expect(d?.usagePercent).toBe(63);
  });

  it('reads a row df wrapped because the device name is long', () => {
    // Common for mapped volumes and container overlays. Taking lines[1] blindly
    // read the device name alone, failed the field-count guard, and reported no
    // disk at all rather than the disk.
    const wrapped = [
      'Filesystem                                  1K-blocks      Used Available Use% Mounted on',
      '/dev/mapper/a-very-long-volume-group-name-here',
      '                                            102687672  61374416  36062516  63% /',
    ].join('\n');

    const d = parseUnixDiskOutput(wrapped, '/');

    expect(d).not.toBeNull();
    expect(d?.total).toBe(102687672 * 1024);
    expect(d?.usagePercent).toBe(63);
  });

  it('keeps the path it was asked about', () => {
    expect(parseUnixDiskOutput(DF, '/var/log')?.path).toBe('/var/log');
  });

  it('returns null when there is no data row', () => {
    expect(
      parseUnixDiskOutput(
        'Filesystem 1K-blocks Used Available Use% Mounted on',
        '/'
      )
    ).toBeNull();
    expect(parseUnixDiskOutput('', '/')).toBeNull();
  });
});
