import { describe, it, expect } from '@jest/globals';
import { join } from 'node:path';
import { shellProfiles } from '../../src/scripts/managed-shell.mjs';

/**
 * A Windows profile with no Documents folder has no PowerShell profile to
 * activate. Before, this threw after the hooks were already wired. The
 * install then skipped command activation and routing, and exited 1.
 */
describe('Windows shell profiles', () => {
  const env = {};

  it('names no profile, and does not throw, when Documents resolves to nothing', () => {
    expect(
      shellProfiles(env, { platform: 'win32', documents: () => '' })
    ).toEqual([]);
  });

  it('names both PowerShell profiles under a resolved Documents folder', () => {
    const docs = join('C:', 'Users', 'someone', 'Documents');
    expect(
      shellProfiles(env, { platform: 'win32', documents: () => docs })
    ).toEqual([
      join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ]);
  });

  it('still honours an explicit profile list before asking Windows', () => {
    const asked = () => {
      throw new Error('must not be asked');
    };
    expect(
      shellProfiles(
        { TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify(['x.ps1']) },
        { platform: 'win32', documents: asked }
      )
    ).toEqual(['x.ps1']);
  });
});
