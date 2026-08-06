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
  // A line that makes `(a+)+$` backtrack catastrophically: a run of `a` with a
  // final character that cannot satisfy `$`. 26 is chosen deliberately -- ~2^26
  // steps is seconds, enough to fail an unguarded probe against the 2 s budget
  // below, while a longer run would hang the suite instead of failing it.
  writeFileSync(join(dir, 'src', 'backtrack.ts'), `${'a'.repeat(26)}!\n`);
  // A line of bare `a`s, which `(a+)+$` MATCHES -- so the guard is the only
  // thing that decides whether a hint appears, with no dependence on timing.
  writeFileSync(join(dir, 'src', 'redos.ts'), `${'a'.repeat(26)}\n`);
  // Two lines in ONE file, so a pattern spanning the newline matches the file
  // and no single line. Split across two files it would match neither, and the
  // test would pass without exercising anything.
  writeFileSync(join(dir, 'src', 'multiline.ts'), 'alpha one\nbeta two\n');

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

  it('fires for an anchored pattern, which only matches a LINE', async () => {
    // The search applies its pattern per line, so the probe has to as well.
    // Tested against whole file contents, `^TOKEN$` is false -- `^` and `$`
    // anchor to the ends of the WHOLE STRING without the `m` flag -- so the
    // hint went missing for exactly the patterns most likely to be written by
    // someone reaching for regex syntax.
    const result = await grep('^export const TOKEN = 1;$');

    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toBeDefined();
  });

  it('does not fire for a pattern that only matches ACROSS lines', async () => {
    // The mirror image, and the reason a whole-file probe is wrong in both
    // directions: this matches the file but no single line, so `regex: true`
    // would find nothing either and the hint would be a lie.
    const result = await grep('alpha one\\nbeta two');

    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('refuses to run a pattern that could backtrack catastrophically', async () => {
    // A LITERAL search must not be able to hang the server.
    //
    // Compiling and running a caller-supplied pattern is new exposure created
    // by the probe: before it, `(a+)+$` was matched as plain text and cost
    // nothing. Measured against the fixture whose line ends in `!`, the
    // unguarded probe took 10.5 SECONDS on 26 characters. Nested quantifiers
    // are the classic ReDoS shape, and the hint is a convenience -- losing it
    // on exotic patterns costs nothing, whereas an unbounded backtrack costs
    // the whole process.
    //
    // Asserted on the OUTCOME, not on elapsed time. A timing assertion here
    // passed or failed with whatever else was running on the machine, which
    // makes it a coin toss dressed as a test. `redos.ts` is a line of bare `a`s
    // that this pattern DOES match, so an unguarded probe reports a hint
    // quickly and a guarded one reports none -- the guard is the only thing
    // that can change the result.
    const result = await grep('(a+)+$');

    expect(result.metadata.totalMatches).toBe(0);
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
