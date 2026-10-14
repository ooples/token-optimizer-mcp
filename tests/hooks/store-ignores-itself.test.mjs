/**
 * Every per-project store the plugin creates ignores itself in git (#500).
 *
 * Only the graph write used to drop the marker, so a session whose first write
 * was a metrics record left metrics.jsonl and evidence.jsonl unignored -- and
 * they were committed into a user repository inside three unrelated PRs. Each
 * store is exercised here through its OWN writer, with no graph write first,
 * because that ordering is exactly the one that escaped.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record } from '../../hooks-core/metrics.mjs';
import { recordAuthoredContent } from '../../hooks-core/authored.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'to-ignore-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ignoresEverything = (dir) => {
  const marker = join(dir, '.gitignore');
  return (
    existsSync(marker) &&
    readFileSync(marker, 'utf8')
      .split(/\r?\n/)
      .some((line) => line.trim() === '*')
  );
};

describe('a store directory ignores itself (#500)', () => {
  it('when its first write is a metrics record, not a graph write', () => {
    const dir = join(root, '.token-optimizer', 'wiki');
    record(dir, { type: 'probe', at: 1 });
    expect(existsSync(join(dir, 'metrics.jsonl'))).toBe(true);
    expect(ignoresEverything(dir)).toBe(true);
  });

  it('for the authored-content store', () => {
    const file = join(root, 'src', 'a.ts');
    recordAuthoredContent(root, 'session-1', file, 'export const a = 1;\n');
    const dir = join(root, '.token-optimizer', 'authored');
    expect(existsSync(dir)).toBe(true);
    expect(ignoresEverything(dir)).toBe(true);
  });

  it('never writes the marker into the parent, which may be the user repository', () => {
    const dir = join(root, 'store');
    record(dir, { type: 'probe', at: 1 });
    expect(ignoresEverything(dir)).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});

describe('a configured store that the user owns is never ignored wholesale (#497 review)', () => {
  it('writes no marker into a pre-existing directory outside .token-optimizer', () => {
    // TOKEN_OPTIMIZER_WIKI_DIR can name the user's own repository root.
    record(root, { type: 'probe', at: 1 });
    expect(existsSync(join(root, 'metrics.jsonl'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});
