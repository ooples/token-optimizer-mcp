import { describe, it, expect } from '@jest/globals';
import { wire, unwire, wiredEntries } from '../../hooks-core/wire.mjs';

/**
 * Install must be reversible, and uninstall must actually reverse it.
 *
 * `unwire` was written, documented as the uninstall path -- "leaves the file as
 * it found it rather than leaving litter that says we were here" -- and tested,
 * and then nothing called it. `uninstall --apply` printed "remove these by hand,
 * so we never rewrite your settings" and stopped, which left the product fully
 * switched on: the hooks stayed in settings.json and kept intercepting every
 * tool call, now possibly pointing at files the same command had just deleted.
 *
 * The asymmetry was the real defect. An installer willing to WRITE a settings
 * file and unwilling to write it on the way out is not being careful, it is a
 * one-way door.
 */
describe('the settings round trip', () => {
  const SOMEONE_ELSES = {
    model: 'opus',
    env: { SOME_USER_VAR: 'keep-me' },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node /somebody/elses/hook.mjs' },
          ],
        },
      ],
    },
  };

  const HOOKS_DIR = '/somewhere/token-optimizer/hooks';

  it('wiring adds our hooks and keeps everything else', () => {
    const wired = wire(SOMEONE_ELSES, HOOKS_DIR);

    expect(wired.model).toBe('opus');
    expect(wired.env.SOME_USER_VAR).toBe('keep-me');
    expect(wiredEntries(wired).length).toBeGreaterThan(0);

    const foreign = wired.hooks.PreToolUse.flatMap(
      (e: { hooks?: Array<{ command?: string }> }) =>
        (e.hooks || []).map((h) => h.command)
    );
    expect(foreign).toContain('node /somebody/elses/hook.mjs');
  });

  it('unwiring gives back exactly what was there before', () => {
    const wired = wire(SOMEONE_ELSES, HOOKS_DIR);
    const restored = unwire(wired);

    // The whole point: byte-for-byte the original, not merely "close".
    expect(restored).toEqual(SOMEONE_ELSES);
    expect(wiredEntries(restored)).toEqual([]);
  });

  it('wiring twice then unwiring once is still clean', () => {
    // Re-running the installer must not leave a second copy that survives
    // removal.
    const twice = wire(wire(SOMEONE_ELSES, HOOKS_DIR), HOOKS_DIR);
    expect(unwire(twice)).toEqual(SOMEONE_ELSES);
  });

  it('leaves no empty event keys behind', () => {
    // A settings file with `"PreCompact": []` in it still says we were here.
    const bare = {};
    const restored = unwire(wire(bare, HOOKS_DIR)) as {
      hooks?: Record<string, unknown>;
    };
    for (const [event, entries] of Object.entries(restored.hooks || {})) {
      expect(Array.isArray(entries) && entries.length === 0).toBe(false);
      expect(event).toBeTruthy();
    }
  });

  it('never removes a hook that is not ours, even in an event we also use', () => {
    const shared = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'node /their/reader.mjs' }],
          },
        ],
      },
    };
    const restored = unwire(wire(shared, HOOKS_DIR)) as typeof shared;
    expect(restored).toEqual(shared);
  });
});
