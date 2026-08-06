import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * The regex hint has to be NARROW, or it is worse than nothing.
 *
 * `pattern` is matched literally unless `regex: true`, so `a|b` finds nothing
 * and the caller receives a result that cannot be told apart from a thorough
 * search of a tree that genuinely lacks the term:
 *
 *     { success: true, metadata: { totalMatches: 0, filesSearched: 7 } }
 *
 * Found by being taken in by it twice in one session -- searching this
 * repository's workflows for `npm test|test:ci|npm run build` returned that,
 * and the zero was read as "CI never runs tests", which is false.
 *
 * The wire tests in tests/integration cover the headline case. These cover the
 * boundaries, because the failure mode of a hint is crying wolf: one that fires
 * on ordinary empty results trains the reader to skip it, and then it is not
 * there for the case it was built for.
 */

let dir: string;
let cache: CacheEngine;
let tool: SmartGrepTool;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-hint-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const TOKEN = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'const plain = 2;\n');

  cache = new CacheEngine(join(dir, 'cache'), 10);
  tool = new SmartGrepTool(cache, new TokenCounter(), new MetricsCollector());
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    // temp dir goes anyway
  }
  rmSync(dir, { recursive: true, force: true });
});

const grep = (pattern: string, extra = {}) =>
  tool.grep(pattern, { path: dir, useCache: false, ...extra });

describe('the regex hint', () => {
  it('fires when a literal zero hides a regex match', async () => {
    const result = await grep('TOKEN|nothing-here');

    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toBeDefined();
  });

  it('survives JSON, since that is where the caller reads it', async () => {
    // The counts field on this same result object was a Map that serialised to
    // {}. A hint that exists in-process and not over the wire would repeat that
    // defect in the very field added to prevent it.
    const result = await grep('TOKEN|nothing-here');
    const overTheWire = JSON.parse(JSON.stringify(result));

    expect(typeof overTheWire.hint).toBe('string');
  });

  it('stays silent when the term is genuinely absent', async () => {
    const result = await grep('absent-one|absent-two');

    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('stays silent when the pattern has no regex syntax', async () => {
    // Escaping changed nothing, so literal and regex mean the same thing here
    // and there is no alternative reading to offer.
    const result = await grep('nosuchterm');

    expect(result.hint).toBeUndefined();
  });

  it('stays silent when the literal search succeeded', async () => {
    const result = await grep('export const');

    expect(result.metadata.totalMatches).toBeGreaterThan(0);
    expect(result.hint).toBeUndefined();
  });

  it('stays silent when the pattern is not valid regex either', async () => {
    // `regex: true` would throw rather than help, so suggesting it would send
    // the caller somewhere worse than where they are.
    const result = await grep('TOKEN[');

    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('stays silent when the caller already asked for regex', async () => {
    // Nothing to point out: the pattern was read the way it looks, and zero
    // means zero.
    const result = await grep('TOKEN|nothing-here', { regex: true });

    expect(result.metadata.totalMatches).toBeGreaterThan(0);
    expect(result.hint).toBeUndefined();
  });

  it('does not depend on which file happens to be read first', async () => {
    // The probe is a RegExp tested against whole file contents. Built with the
    // `g` flag it would carry lastIndex from one file to the next and start
    // mid-content, so the hint would appear or vanish with directory order.
    // Two files, only the second of which can match.
    const first = await grep('TOKEN|nothing-here');
    const second = await grep('TOKEN|nothing-here');

    expect(first.hint).toBeDefined();
    expect(second.hint).toEqual(first.hint);
  });
});
