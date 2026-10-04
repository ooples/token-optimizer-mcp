import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmartEnv } from '../../../src/tools/configuration/smart-env.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A TOKEN OPTIMIZER THAT COST MORE THAN THE FILE IT SUMMARISED.
 *
 * Every row carried the variable's line number and the character count of its
 * value. Measured on the bench's 48-variable fixture those two numbers were
 * 242 of 538 tokens -- 45% of the whole report -- and they turned a +39.0%
 * reading against the file into -10.9%. Both answer "where is it", a question
 * about editing the file rather than about what is configured in it, so they
 * are now what the caller asks for when editing is what they are doing.
 */
describe('a variable list answers what is set, not where', () => {
  let root: string;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let envPath: string;

  const VARS = [
    'NODE_ENV=production',
    'PORT=3000',
    'DATABASE_URL=postgres://x',
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'env-locations-'));
    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
    envPath = join(root, '.env');
    writeFileSync(envPath, VARS.join('\n') + '\n');
  });

  afterEach(() => {
    cache.close();
    rmSync(root, { recursive: true, force: true });
  });

  const analyze = (includeLocations?: boolean) =>
    new SmartEnv(cache, counter, new MetricsCollector()).run(
      includeLocations === undefined
        ? { envFile: envPath, force: true }
        : { envFile: envPath, force: true, includeLocations }
    );

  it('names every variable and nothing else by default', async () => {
    const result = await analyze();

    expect(result.parsed?.columns).toEqual(['key']);
    expect(result.parsed?.rows).toEqual([
      ['NODE_ENV'],
      ['PORT'],
      ['DATABASE_URL'],
    ]);
  });

  it('reports the line and the value length when asked', async () => {
    const result = await analyze(true);

    expect(result.parsed?.columns).toEqual(['key', 'line', 'length']);
    // The lines are the file's own, and the lengths are of the values the
    // response deliberately does not carry: `production` is 10 characters.
    expect(result.parsed?.rows).toEqual([
      ['NODE_ENV', 1, 10],
      ['PORT', 2, 4],
      ['DATABASE_URL', 3, 12],
    ]);
  });

  it('costs fewer tokens by default than it does when asked', async () => {
    // THE POINT OF THE CHANGE, ASSERTED RATHER THAN ASSUMED. A shape that was
    // cheaper in the comment and not on the wire would leave the defect in
    // place with a reassuring note on top of it.
    const lean = counter.count(JSON.stringify(await analyze())).tokens;
    const located = counter.count(JSON.stringify(await analyze(true))).tokens;

    expect(lean).toBeLessThan(located);
  });

  it('does not serve the located shape to a default call from cache', async () => {
    /*
     * THE CACHE OUTLIVES THE RELEASE THAT CHANGED THE SHAPE. The key is built
     * from the file digest and the options, and `includeLocations` is absent
     * from a default call's options -- so without the response version in the
     * key, a home directory holding an entry for this file would go on being
     * served three-column rows by a build that no longer produces them, with
     * no error and no way to tell.
     */
    const located = await new SmartEnv(
      cache,
      counter,
      new MetricsCollector()
    ).run({
      envFile: envPath,
      includeLocations: true,
    });
    expect(located.parsed?.columns).toEqual(['key', 'line', 'length']);

    const lean = await new SmartEnv(cache, counter, new MetricsCollector()).run(
      {
        envFile: envPath,
      }
    );
    expect(lean.parsed?.columns).toEqual(['key']);
  });
});
