import { describe, it, expect } from '@jest/globals';
import {
  parseNetUserList,
  parseNetLocalGroupList,
} from '../../src/utils/net-command-output.js';

/**
 * Both Windows listings were split on whitespace. `net localgroup` prints one
 * name per line, so that shredded every multi-word group: measured on an
 * ordinary desktop, smart_user returned 6 of 15 groups and listed `Users`
 * twice -- once genuinely, once as the trailing token of
 * `*Distributed COM Users`.
 *
 * These fixtures are real command output, so they run on the Linux CI runners
 * that are the only kind this project has -- which is why no test had ever
 * executed this code.
 */

const NET_LOCALGROUP = [
  '',
  'Aliases for \\\\SUPER-COMPUTER',
  '',
  '-'.repeat(79),
  '*Administrators',
  '*Device Owners',
  '*Distributed COM Users',
  '*docker-users',
  '*Users',
  'The command completed successfully.',
  '',
].join('\n');

const NET_USER = [
  '',
  'User accounts for \\\\SUPER-COMPUTER',
  '',
  '-'.repeat(79),
  'Administrator            cheat                    DefaultAccount           ',
  'Guest                    WDAGUtilityAccount       ',
  'The command completed successfully.',
  '',
].join('\n');

describe('net localgroup', () => {
  const groups = parseNetLocalGroupList(NET_LOCALGROUP);

  it('returns every group, including multi-word names', () => {
    expect(groups).toEqual([
      'Administrators',
      'Device Owners',
      'Distributed COM Users',
      'docker-users',
      'Users',
    ]);
  });

  it('keeps a multi-word name whole instead of splitting it into tokens', () => {
    // Was: '*Device' and 'Owners', neither of which is a group.
    expect(groups).toContain('Device Owners');
    expect(groups).not.toContain('Owners');
    expect(groups).not.toContain('*Device');
  });

  it('strips the leading marker', () => {
    expect(groups.every((g) => !g.startsWith('*'))).toBe(true);
  });

  it('does not list a group twice', () => {
    // 'Users' used to appear both genuinely and as the last token of
    // 'Distributed COM Users' -- and each duplicate cost another subprocess.
    const lowered = groups.map((g) => g.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it('excludes the trailing status line', () => {
    expect(groups.some((g) => /command completed/i.test(g))).toBe(false);
  });
});

describe('net user', () => {
  it('reads the three fixed-width columns', () => {
    expect(parseNetUserList(NET_USER)).toEqual([
      'Administrator',
      'cheat',
      'DefaultAccount',
      'Guest',
      'WDAGUtilityAccount',
    ]);
  });

  it('keeps an account name that contains a space', () => {
    // Splitting on whitespace turned one account into two failed lookups and
    // dropped it silently. Column widths are 25.
    const withSpace = [
      '-'.repeat(79),
      'Guest Account            cheat                    ',
      'The command completed successfully.',
    ].join('\n');

    expect(parseNetUserList(withSpace)).toEqual(['Guest Account', 'cheat']);
  });

  it('excludes the trailing status line', () => {
    expect(
      parseNetUserList(NET_USER).some((u) => /command completed/i.test(u))
    ).toBe(false);
  });
});

describe('both listings', () => {
  it('return nothing when the rule line is absent', () => {
    expect(parseNetUserList('some error text')).toEqual([]);
    expect(parseNetLocalGroupList('')).toEqual([]);
  });
});
