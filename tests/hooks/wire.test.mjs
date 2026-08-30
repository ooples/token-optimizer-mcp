/**
 * Wiring hooks into someone else's settings file.
 *
 * These are regression tests for a bug that shipped: the installer overwrote
 * the entire settings file when `jq` was absent, and replaced the whole `hooks`
 * object when it was present. Either way every hook the user had configured was
 * destroyed, silently, by a tool whose uninstaller promises it never touches
 * anything it did not write.
 *
 * So the properties here are: additive, idempotent, and reversible to exactly
 * the state we found.
 */

import {
  wire,
  unwire,
  wiredEntries,
  wirePlan,
  WIRING,
  MARKER,
  OWNERSHIP_FLAG,
} from '../../hooks-core/wire.mjs';

const HOOKS = '/home/me/.claude-global/hooks/token-optimizer';

/** A settings file with the user's own hooks and their own unrelated keys. */
const userSettings = () => ({
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /home/me/my-own-hook.mjs' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    // An event this product never registers, so it can stand for "untouched".
    // Stop used to play that role and no longer can: WIRING was missing
    // PostToolUse and Stop entirely, which left script installs with no capture
    // and no harvest, and adding them back made Stop a touched event.
    Notification: [{ hooks: [{ type: 'command', command: 'echo notified' }] }],
  },
  theme: 'dark',
  permissions: { allow: ['Bash(git:*)'] },
});

describe('wiring is additive', () => {
  test('every event we need is wired', () => {
    const out = wire({}, HOOKS);
    expect(Object.keys(out.hooks).sort()).toEqual(WIRING.map((w) => w.event).sort());
  });

  test('SessionStart is among them, since that is where the policy is delivered', () => {
    // The installer this replaces wired four events and not this one, so the
    // standing policy and the project briefing never arrived.
    expect(WIRING.map((w) => w.event)).toContain('SessionStart');
    expect(JSON.stringify(wire({}, HOOKS).hooks.SessionStart)).toContain('session-start.mjs');
  });

  test('a user hook on the same event survives, in its original position', () => {
    const out = wire(userSettings(), HOOKS);
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('node /home/me/my-own-hook.mjs');
    expect(out.hooks.PreToolUse).toHaveLength(2);
  });

  test('events we do not touch are left exactly as they were', () => {
    const out = wire(userSettings(), HOOKS);
    expect(out.hooks.Notification).toEqual(userSettings().hooks.Notification);
  });

  test("a user's own entry on an event we DO wire survives beside ours", () => {
    // The other half of "additive", and the half that matters more now that
    // Stop is wired: the user already had a Stop hook, and installing must not
    // cost them it.
    const out = wire(userSettings(), HOOKS);

    expect(JSON.stringify(out.hooks.Stop)).toContain('echo done');
    expect(JSON.stringify(out.hooks.Stop)).toContain('stop.mjs');
  });

  test('unrelated settings keys are preserved', () => {
    const out = wire(userSettings(), HOOKS);
    expect(out.theme).toBe('dark');
    expect(out.permissions).toEqual({ allow: ['Bash(git:*)'] });
  });

  test('the input object is not mutated', () => {
    const before = userSettings();
    wire(before, HOOKS);
    expect(before.hooks.PreToolUse).toHaveLength(1);
  });

  test('the command carries the marker, which is what makes it findable later', () => {
    expect(JSON.stringify(wire({}, HOOKS).hooks.PreToolUse)).toContain(MARKER);
  });
});

describe('wiring is idempotent', () => {
  test('running the installer twice leaves one set of entries, not two', () => {
    const once = wire(userSettings(), HOOKS);
    const twice = wire(once, HOOKS);
    expect(wiredEntries(twice)).toHaveLength(wiredEntries(once).length);
  });

  test('and still only one of the user\'s', () => {
    const twice = wire(wire(userSettings(), HOOKS), HOOKS);
    expect(twice.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes(MARKER))).toHaveLength(1);
  });

  test('re-wiring to a new location replaces the old entry rather than stacking', () => {
    const moved = wire(wire({}, HOOKS), '/somewhere/else/token-optimizer');
    expect(moved.hooks.PreToolUse).toHaveLength(1);
    expect(JSON.stringify(moved.hooks.PreToolUse)).toContain('/somewhere/else/');
  });

  test('an entry of ours that has MOVED in the array is still recognised as ours', () => {
    // Identified by what it runs, not by where it sits: an entry someone else
    // added at our old index is not ours, and ours is still ours if it moved.
    const wired = wire(userSettings(), HOOKS);
    wired.hooks.PreToolUse.reverse();
    expect(wiredEntries(wire(wired, HOOKS))).toHaveLength(WIRING.length);
  });
});

describe('unwiring restores what we found', () => {
  test('our entries go and theirs stay', () => {
    const out = unwire(wire(userSettings(), HOOKS));
    expect(out.hooks.PreToolUse).toEqual(userSettings().hooks.PreToolUse);
    expect(out.hooks.Stop).toEqual(userSettings().hooks.Stop);
  });

  test('an event that was only ours has its key removed, not left empty', () => {
    // Leaving `"SessionStart": []` behind is litter that says we were here.
    const out = unwire(wire({}, HOOKS));
    expect(out.hooks).toBeUndefined();
  });

  test('a settings file with no hooks at all is returned unchanged', () => {
    expect(unwire({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });

  test('wire then unwire is the identity on the user\'s settings', () => {
    expect(unwire(wire(userSettings(), HOOKS))).toEqual(userSettings());
  });

  test('non-array hook values are passed through rather than dropped', () => {
    const odd = { hooks: { Weird: { not: 'an array' } } };
    expect(unwire(odd).hooks.Weird).toEqual({ not: 'an array' });
  });
});

describe('the plan says what it will do before it does it', () => {
  test('it counts what is preserved as well as what is added', () => {
    const plan = wirePlan(userSettings(), HOOKS);
    expect(plan.adding).toBe(WIRING.length);
    // DERIVED from the fixture, not hardcoded. This was `2` and broke the
    // moment a third user hook was added to userSettings() -- a literal here
    // asserts the fixture rather than the behaviour.
    const userEntries = Object.values(userSettings().hooks).reduce(
      (n, arr) => n + arr.length,
      0
    );
    expect(plan.preserving).toBe(userEntries);
    expect(plan.replacing).toBe(0);
  });

  test('on a re-run it reports replacing rather than adding', () => {
    const plan = wirePlan(wire(userSettings(), HOOKS), HOOKS);
    expect(plan.replacing).toBe(WIRING.length);
    expect(plan.adding).toBe(0);
  });
});


describe('a hook that merely mentions us is not ours', () => {
  // Ownership was `JSON.stringify(entry).includes('token-optimizer')`, which
  // reads the whole entry -- matcher included -- so installing DELETED a user's
  // own hooks for naming us. Verified against the pre-fix code: both of the
  // first two below were gone after a single `wire()`.
  const DIR = '/home/u/.claude/token-optimizer/hooks';

  const theirs = () => ({
    hooks: {
      // Someone logging optimizer calls names us in the MATCHER.
      PostToolUse: [
        {
          matcher: 'mcp__.*token-optimizer.*',
          hooks: [{ type: 'command', command: 'node ~/scripts/log-optimizer.mjs' }],
        },
      ],
      Stop: [
        // Carries the marker, but is not a file we install.
        { hooks: [{ type: 'command', command: 'node ~/scripts/token-optimizer-report.mjs' }] },
        // Shares a filename with one of ours, but is not in our directory.
        { hooks: [{ type: 'command', command: 'node ~/my/stop.mjs' }] },
        // Reproduces our whole layout -- a `token-optimizer` directory holding
        // a file we also ship -- which is why ownership cannot rest on the path
        // shape alone, and why what we install carries an explicit flag.
        { hooks: [{ type: 'command', command: 'node "/workspace/token-optimizer/stop.mjs"' }] },
        // Borrowed our name for a directory of their own. `token-optimizer`
        // must be a path SEGMENT, not a substring, or this is claimed as ours.
        { hooks: [{ type: 'command', command: 'node ~/token-optimizer-backup/stop.mjs' }] },
        // Names one of our files as an ARGUMENT it merely passes along, which a
        // scan of the whole command string reads as if it were the script.
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/hooks/token-optimizer-report.mjs" --template "/hooks/stop.mjs"',
            },
          ],
        },
      ],
    },
  });

  test.each([
    ['a hook whose matcher names us', 'log-optimizer.mjs'],
    ['a script of theirs whose name contains ours', 'token-optimizer-report.mjs'],
    ['a script of theirs sharing one of our filenames', '~/my/stop.mjs'],
    ['a directory of theirs laid out exactly like ours', '/workspace/token-optimizer/stop.mjs'],
    ['a directory of theirs that borrowed our name', 'token-optimizer-backup/stop.mjs'],
    ['one of our filenames passed as an argument', 'token-optimizer-report.mjs'],
  ])('installing preserves %s', (_label, fragment) => {
    expect(JSON.stringify(wire(theirs(), DIR))).toContain(fragment);
  });

  test('and uninstalling preserves them too', () => {
    const removed = unwire(wire(theirs(), DIR));

    expect(wiredEntries(removed)).toHaveLength(0);
    for (const fragment of [
      'log-optimizer.mjs',
      'token-optimizer-report.mjs',
      '~/my/stop.mjs',
      'token-optimizer-backup/stop.mjs',
      '/workspace/token-optimizer/stop.mjs',
    ]) {
      expect(JSON.stringify(removed)).toContain(fragment);
    }
  });

  test('while ours are still recognised, so a re-install does not stack', () => {
    expect(wiredEntries(wire(theirs(), DIR))).toHaveLength(5);
    expect(wiredEntries(wire(wire(theirs(), DIR), DIR))).toHaveLength(5);
  });
});


describe('what we install says so, rather than being recognised by its path', () => {
  const DIR = '/home/u/.claude-global/hooks/token-optimizer';

  test('every entry we write carries the ownership flag', () => {
    const out = wire({}, DIR);

    for (const { event } of WIRING) {
      expect(JSON.stringify(out.hooks[event])).toContain(OWNERSHIP_FLAG);
    }
  });

  test('an entry written before the flag existed is still removable', () => {
    // Dropping the path rule outright would strand every hook an earlier
    // version installed, so it survives -- narrowed to the directory the
    // installers actually build, which is what excludes a user's own
    // `/workspace/token-optimizer/stop.mjs`.
    const legacy = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node "/home/u/.claude-global/hooks/token-optimizer/stop.mjs"',
              },
            ],
          },
        ],
      },
    };

    expect(wiredEntries(legacy)).toHaveLength(1);
    expect(wiredEntries(unwire(legacy))).toHaveLength(0);
  });
});
