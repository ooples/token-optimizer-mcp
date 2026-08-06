/**
 * A mistyped argument must be REFUSED, not dropped.
 *
 * This exists because of a real wrong answer: `smart_grep` was called with
 * `filePattern` (its actual option is `files`). Zod strips unknown keys and the
 * schema is `.passthrough()`, so the parameter vanished, the tool searched all
 * 17 files instead of the 1 requested, and the result LOOKED filtered --
 * `filesSearched: 17` was the only tell. A silently ignored filter produces a
 * confident wrong answer, which is strictly worse than an error.
 */
import { describe, it, expect } from '@jest/globals';
import {
  createToolArgumentChecker,
  nearestKnownField,
  type ToolDefinitionLike,
} from '../../src/server/tool-arguments.js';

/** Mirrors the real smart_grep definition closely enough to be meaningful. */
const TOOLS: ToolDefinitionLike[] = [
  {
    name: 'smart_grep',
    inputSchema: {
      required: ['pattern'],
      properties: {
        pattern: {},
        cwd: {},
        files: {},
        caseSensitive: {},
        regex: {},
        extensions: {},
        includeContext: {},
        contextBefore: {},
        contextAfter: {},
        limit: {},
        filesWithMatches: {},
        count: {},
      },
    },
  },
  {
    name: 'smart_read',
    inputSchema: {
      required: ['path'],
      properties: { path: {}, diffMode: {}, maxSize: {} },
    },
  },
  // Tools that publish no properties take an open options bag.
  { name: 'cache_audit', inputSchema: { required: [], properties: {} } },
  { name: 'no_schema_at_all' },
];

const checker = createToolArgumentChecker(TOOLS);

describe('assertKnownFields', () => {
  it('rejects the parameter that actually caused a wrong answer', () => {
    expect(() =>
      checker.assertKnownFields('smart_grep', {
        pattern: 'x',
        filePattern: 'VideoFlow.cs',
      })
    ).toThrow(/does not accept filePattern/);
  });

  it('points at the real option instead of only refusing', () => {
    // `filePattern` contains `pattern`, so that is the honest suggestion --
    // the caller still has to pick `files`, but the message names a real field
    // and lists the full set rather than sending them to the schema.
    expect(() =>
      checker.assertKnownFields('smart_grep', {
        pattern: 'x',
        filePattern: 'y',
      })
    ).toThrow(/did you mean pattern\?/);
    expect(() =>
      checker.assertKnownFields('smart_grep', {
        pattern: 'x',
        filePattern: 'y',
      })
    ).toThrow(/Accepted: caseSensitive, contextAfter/);
  });

  it('accepts every parameter the tool advertises', () => {
    expect(() =>
      checker.assertKnownFields('smart_grep', {
        pattern: 'x',
        cwd: 'C:/repo',
        files: ['a.cs'],
        regex: true,
        includeContext: true,
        contextBefore: 2,
        contextAfter: 1,
        limit: 10,
      })
    ).not.toThrow();
  });

  it('names each near-miss field, not just the first', () => {
    let message = '';
    try {
      checker.assertKnownFields('smart_grep', {
        pattern: 'x',
        filePattern: 1,
        contextBefor: 2, // one character short of contextBefore
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/filePattern/);
    expect(message).toMatch(/contextBefor/);
  });

  it('allows an undeclared option that is NOT a near miss', () => {
    // The published schemas are incomplete: an audit found 22 tools reading
    // options they never advertise -- smart_grep really does honour wholeWord,
    // skipBinary and ignore. Refusing those would break working calls to enforce
    // a contract the implementation does not have, so only typos are refused.
    expect(() =>
      checker.assertKnownFields('smart_grep', {
        pattern: 'x',
        wholeWord: true,
        skipBinary: true,
        maxMatchesPerFile: 3,
      })
    ).not.toThrow();
  });

  it('leaves open options bags alone', () => {
    // No declared vocabulary means nothing to check against; refusing here
    // would break the audit tools, which legitimately take a free-form bag.
    expect(() =>
      checker.assertKnownFields('cache_audit', { anything: true })
    ).not.toThrow();
    expect(() =>
      checker.assertKnownFields('no_schema_at_all', { anything: true })
    ).not.toThrow();
  });

  it('tolerates absent and empty arguments', () => {
    expect(() =>
      checker.assertKnownFields('smart_grep', undefined)
    ).not.toThrow();
    expect(() => checker.assertKnownFields('smart_grep', {})).not.toThrow();
  });

  it('does not fire for a tool it has never heard of', () => {
    expect(() =>
      checker.assertKnownFields('not_a_tool', { whatever: 1 })
    ).not.toThrow();
  });
});

describe('nearestKnownField', () => {
  const known = new Set(['pattern', 'cwd', 'files', 'limit', 'contextBefore']);

  it('prefers a contained name over edit distance', () => {
    expect(nearestKnownField('filePattern', known)).toBe('pattern');
    expect(nearestKnownField('contextBeforeLines', known)).toBe(
      'contextBefore'
    );
  });

  it('catches a single-character slip', () => {
    expect(nearestKnownField('patern', known)).toBe('pattern');
    expect(nearestKnownField('limits', known)).toBe('limit');
  });

  it('declines to guess when nothing is close', () => {
    // A confident wrong guess reads worse than no guess at all.
    expect(nearestKnownField('zzzzzzzzzzzz', known)).toBeNull();
  });

  it('returns null for an empty vocabulary', () => {
    expect(nearestKnownField('anything', new Set())).toBeNull();
  });
});

describe('assertRequiredFields', () => {
  it('still rejects a missing required field', () => {
    expect(() => checker.assertRequiredFields('smart_grep', {})).toThrow(
      /smart_grep requires pattern/
    );
  });

  it('accepts a call that supplies it', () => {
    expect(() =>
      checker.assertRequiredFields('smart_grep', { pattern: 'x' })
    ).not.toThrow();
  });

  it('treats null as missing', () => {
    expect(() =>
      checker.assertRequiredFields('smart_read', { path: null })
    ).toThrow(/requires path/);
  });
});
