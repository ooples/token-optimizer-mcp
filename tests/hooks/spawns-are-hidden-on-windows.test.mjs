/**
 * Every child process a hook starts must be hidden on Windows.
 *
 * The harvest worker is started with windowsHide, so it owns no console. Any child it then
 * spawns WITHOUT the flag is handed a brand-new visible one, and a blank black cmd.exe window
 * sits on the user's desktop until that child exits. That is what runHostCli did: measured, one
 * visible window per host-CLI harvest, and none once the flag was set.
 *
 * This is asserted against the source rather than observed, because a windowless CI runner
 * cannot see the window that is the whole defect.
 */

import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HOOKS_CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks-core');

/** The child_process bindings a module imported, so `pattern.exec(...)` is not mistaken for one. */
function spawnBindings(source) {
  const bindings = new Set();
  const imports = source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*['\"](?:node:)?child_process['\"]/g
  );
  for (const match of imports) {
    for (const clause of match[1].split(',')) {
      const name = clause.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) bindings.add(name);
    }
  }
  return bindings;
}

function callSiteCount(source, name) {
  const calls = source.match(new RegExp(String.raw`(?<![.\w$])${name}\s*\(`, 'g'));
  return calls ? calls.length : 0;
}

describe('hooks spawn children hidden on windows', () => {
  const files = readdirSync(HOOKS_CORE).filter((name) => name.endsWith('.mjs'));

  it('finds the hook sources to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes windowsHide to every child it starts', (file) => {
    const source = readFileSync(join(HOOKS_CORE, file), 'utf8');
    const bindings = spawnBindings(source);
    let calls = 0;
    for (const name of bindings) calls += callSiteCount(source, name);
    const hidden = (source.match(/windowsHide:\s*true/g) || []).length;
    expect({ file, calls, hidden }).toEqual({ file, calls, hidden: calls });
  });
});
