/**
 * `TOKEN_OPTIMIZER_WIKI_DISABLED=1` makes the graph inert without breaking it.
 *
 * WHY THIS EXISTS. A benchmark arm needs to isolate what the knowledge graph
 * costs when it can deliver nothing. Every THOL run gets a throwaway HOME, so
 * the graph starts empty on every run and its retrieval value is structurally
 * zero there -- what remains is pure overhead: SessionStart injection walking an
 * empty store, and Stop harvest writing findings nothing will read. Measuring
 * that needs an arm with the graph off and everything else identical.
 *
 * The obvious shortcut is wrong and is deliberately not used: pointing
 * TOKEN_OPTIMIZER_WIKI_DIR at an empty directory stops delivery but leaves
 * harvest WRITING, so the arm would measure something other than what it
 * claims.
 *
 * The gate sits at the storage layer -- `load`, `putNode`, `putEdge` -- because
 * that is the one choke point every higher-level path funnels through. Gating
 * the callers instead would mean finding all of them, and missing one would
 * leave the arm quietly writing.
 *
 * DEGRADES, NEVER THROWS. `putNode` still returns a well-formed id so callers
 * that chain on it keep working; they simply persist nothing.
 */

import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load, putNode, putEdge, wikiDisabled } from '../../hooks-core/wiki.mjs';

let dir;

const withDisabled = (value, fn) => {
  const had = Object.hasOwn(process.env, 'TOKEN_OPTIMIZER_WIKI_DISABLED');
  const prev = process.env.TOKEN_OPTIMIZER_WIKI_DISABLED;
  if (value === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DISABLED;
  else process.env.TOKEN_OPTIMIZER_WIKI_DISABLED = value;
  try {
    return fn();
  } finally {
    if (had) process.env.TOKEN_OPTIMIZER_WIKI_DISABLED = prev;
    else delete process.env.TOKEN_OPTIMIZER_WIKI_DISABLED;
  }
};

const fileNode = (key) => ({ kind: 'file', key, hash: 'abc123', bytes: 10 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wiki-disabled-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the switch itself', () => {
  test('is off unless explicitly set', () => {
    expect(withDisabled(undefined, wikiDisabled)).toBe(false);
    expect(withDisabled('', wikiDisabled)).toBe(false);
    expect(withDisabled('0', wikiDisabled)).toBe(false);
    expect(withDisabled('false', wikiDisabled)).toBe(false);
  });

  test('is on for the values a person would actually type', () => {
    expect(withDisabled('1', wikiDisabled)).toBe(true);
    expect(withDisabled('true', wikiDisabled)).toBe(true);
    expect(withDisabled('TRUE', wikiDisabled)).toBe(true);
  });
});

describe('enabled -- the control, so the tests below cannot pass vacuously', () => {
  test('a node is written and read back', () => {
    withDisabled(undefined, () => {
      const id = putNode(dir, fileNode('/tmp/a.ts'));
      expect(typeof id).toBe('string');
      expect(load(dir).nodes.size).toBe(1);
    });
  });
});

describe('disabled', () => {
  test('writes nothing to disk', () => {
    withDisabled('1', () => {
      putNode(dir, fileNode('/tmp/a.ts'));
      putEdge(dir, 'from-id', 'related', 'to-id');
    });
    // Not merely "no graph loads" -- nothing was persisted at all, which is what
    // makes this an overhead measurement rather than a delivery one.
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test('still returns a usable id, so callers that chain on it do not break', () => {
    const id = withDisabled('1', () => putNode(dir, fileNode('/tmp/a.ts')));
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('reads as empty even when a populated graph is sitting there', () => {
    // The graph is written with the switch OFF, then read with it ON. This is
    // the case that separates a real gate from one that only works because
    // nothing was ever stored.
    withDisabled(undefined, () => putNode(dir, fileNode('/tmp/a.ts')));
    expect(withDisabled(undefined, () => load(dir).nodes.size)).toBe(1);

    const loaded = withDisabled('1', () => load(dir));
    expect(loaded.nodes.size).toBe(0);
    expect(loaded.edges).toEqual([]);
  });
});
