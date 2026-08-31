/**
 * The two install paths must hook the same tools.
 *
 * There are two, and they are maintained separately:
 *
 *   hooks-core/wire.mjs WIRING   the SCRIPT install, which merges entries into
 *                                the user's settings.json
 *   plugin/hooks/hooks.json      the PLUGIN manifest Claude Code reads directly
 *
 * Nothing compared them. `npm run sync:hooks:check` verifies that the vendored
 * hook SOURCES match hooks-core, and says nothing about which tools each install
 * path registers -- so the two could disagree indefinitely and every gate stayed
 * green.
 *
 * That is not hypothetical: adding WebFetch/WebSearch to WIRING alone changed
 * nothing for anyone installing the plugin, which is the common path. A hook
 * that is never invoked is indistinguishable from a hook that decides to do
 * nothing, and this project has already shipped one of those.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WIRING } from '../../hooks-core/wire.mjs';

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'plugin', 'hooks', 'hooks.json'), 'utf8')
);

/** The matcher the plugin manifest registers for one event. */
const manifestMatcher = (event) => {
  const entries = manifest.hooks?.[event];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return entries[0].matcher ?? null;
};

const wiringFor = (event) => WIRING.find((w) => w.event === event);

describe('the script install and the plugin manifest agree', () => {
  it.each(WIRING.map((w) => [w.event]))(
    'registers %s in both paths',
    (event) => {
      expect(Object.keys(manifest.hooks)).toContain(event);
    }
  );

  it('hooks the same tools on PreToolUse, which is where routing happens', () => {
    // The one that actually bit: WIRING listed WebFetch and WebSearch while the
    // manifest did not, so plugin installs never saw a web call at all.
    expect(manifestMatcher('PreToolUse')).toBe(wiringFor('PreToolUse').matcher);
  });

  it('hooks the same tools on PostToolUse, which is where capture happens', () => {
    expect(manifestMatcher('PostToolUse')).toBe(
      wiringFor('PostToolUse').matcher
    );
  });

  it('covers the web tools, which were invisible to both paths', () => {
    // Stated separately from the equality above, because two paths that agree
    // on the WRONG list also satisfy that test. 4,499 recorded tool outcomes on
    // the measuring machine contained zero web calls, in sessions that made
    // them, and web research is 48.6% of the THOL battery's cost.
    const matcher = manifestMatcher('PreToolUse');
    expect(matcher).toContain('WebFetch');
    expect(matcher).toContain('WebSearch');
  });
});
