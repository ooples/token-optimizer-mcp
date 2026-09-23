import { describe, it, expect } from '@jest/globals';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import {
  CLIENT_HOOK_INSTALLS,
  hookInstallFor,
} from '../../hooks-core/capabilities.mjs';

/**
 * Every client that ships hooks must say where they land.
 *
 * The destinations lived as English inside scripts/generate-client-configs.mjs, so the doctor
 * could examine exactly two installs -- Claude Code's and Codex's -- and every other client fell
 * through to whatever was in Claude Code's plugin registry (#408). One fixed case does not stop
 * the eleventh integration arriving with no destination of its own, which is what this asserts:
 * the registry is checked against the directories that actually exist in the tree, so adding an
 * integration without declaring where it installs fails here rather than in a user's report.
 */

const ROOT = process.cwd();
const INTEGRATIONS = join(ROOT, 'integrations');

/** Every hooks/ directory we ship, as a repository-relative posix path. */
function shippedHookDirs(): string[] {
  const found: string[] = [];
  for (const client of readdirSync(INTEGRATIONS)) {
    // The Codex PLUGIN bundle is installed by Codex itself from the marketplace, so it has no
    // copy destination of its own; integrations/codex/hooks is the by-hand path and is covered.
    for (const candidate of ['hooks', join('.github', 'hooks')]) {
      const dir = join(INTEGRATIONS, client, candidate);
      if (existsSync(dir) && statSync(dir).isDirectory())
        found.push(
          join('integrations', client, candidate).split('\\').join('/')
        );
    }
  }
  return found;
}

describe('the hook destination registry covers what we ship', () => {
  it('has an entry for every integration that ships hooks', () => {
    const dirs = shippedHookDirs();
    // NON-VACUITY: an empty walk would satisfy every loop below without reading a thing.
    expect(dirs.length).toBeGreaterThanOrEqual(9);

    const sources = Object.values(CLIENT_HOOK_INSTALLS).map(
      (entry: { source: string }) => entry.source
    );
    for (const dir of dirs) expect(sources).toContain(dir);
  });

  it('names files that are really there', () => {
    for (const [client, entry] of Object.entries(CLIENT_HOOK_INSTALLS)) {
      const source = join(ROOT, (entry as { source: string }).source);
      expect([client, existsSync(source)]).toEqual([client, true]);
      const files = (entry as { entries: Record<string, string> }).entries;
      expect(Object.keys(files).length).toBeGreaterThan(0);
      for (const name of Object.values(files))
        expect([client, name, existsSync(join(source, name))]).toEqual([
          client,
          name,
          true,
        ]);
    }
  });

  it('either states a destination or says why there is none', () => {
    for (const [client, raw] of Object.entries(CLIENT_HOOK_INSTALLS)) {
      const entry = raw as {
        base: string | null;
        dir: string | null;
        why?: string;
      };
      if (entry.dir) {
        // A DESTINATION IS ONLY USABLE WITH ITS ROOT. The same relative path means a different
        // place depending on whether the client reads hooks per machine or per repository.
        expect([client, entry.base]).not.toEqual([client, null]);
        expect(['home', 'project']).toContain(entry.base);
        expect(entry.dir.startsWith('/')).toBe(false);
      } else {
        // Not a gap -- a refusal, and one that has to be argued rather than left blank, because a
        // plausible guess here reports a missing install to every user of that client.
        expect([client, String(entry.why || '').length > 20]).toEqual([
          client,
          true,
        ]);
      }
    }
  });

  it('is reachable by client id', () => {
    expect(hookInstallFor('CODEX')?.dir).toBe('.codex/hooks');
    expect(hookInstallFor('roo')).toBeNull();
    expect(hookInstallFor('')).toBeNull();
  });
});
