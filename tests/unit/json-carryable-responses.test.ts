import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmartDependenciesTool } from '../../src/tools/code-analysis/smart-dependencies.js';
import { SmartEnv } from '../../src/tools/configuration/smart-env.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * Two defects an in-process test would never have seen, because both only
 * appear once the answer crosses the JSON boundary an MCP client sits behind.
 *
 * 1. smart_dependencies returned its graph as a `Map`, and
 *    `JSON.stringify(new Map([...]))` is `{}`. Every response carried
 *    `"graph": {}` no matter what was found -- while the metadata beside it
 *    correctly reported analyzedFiles 4, externalDependencies 2 and
 *    internalDependencies 3. The analysis was right and only the payload was
 *    lost, which is exactly why nothing looked broken from inside.
 *
 * 2. smart_env returned the VALUE of every variable, so DB_PASSWORD,
 *    JWT_SECRET and STRIPE_KEY all left the machine on a single call, and
 *    `checkSecurity: true` made no difference.
 */

describe('responses survive JSON', () => {
  let root: string;
  let cache: CacheEngine;
  let counter: TokenCounter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'json-carry-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  describe('smart_dependencies graph', () => {
    beforeEach(() => {
      writeFileSync(join(root, 'src', 'a.ts'), `export const a = 1;\n`);
      writeFileSync(join(root, 'src', 'b.ts'), `export const b = 2;\n`);
      writeFileSync(
        join(root, 'src', 'index.ts'),
        `import { a } from './a.js';\nimport { b } from './b.js';\nexport const total = a + b;\n`
      );
    });

    const analyze = () =>
      new SmartDependenciesTool(cache, counter, new MetricsCollector()).analyze(
        {
          cwd: root,
          useCache: false,
        }
      );

    it('survives a JSON round-trip with its content intact', async () => {
      const result = await analyze();

      // The defect in one line: this used to be `{}`.
      const roundTripped = JSON.parse(JSON.stringify(result));

      expect(roundTripped.graph).toBeDefined();
      expect(Array.isArray(roundTripped.graph.nodes)).toBe(true);
      expect(roundTripped.graph.nodes.length).toBe(3);
    });

    it('carries the edges that actually exist', async () => {
      const result = JSON.parse(JSON.stringify(await analyze()));

      // index.ts imports a and b. Two edges, from index.
      expect(result.graph.edges.length).toBe(2);
      expect(
        result.graph.edges.every((e: { from: string }) =>
          e.from.includes('index')
        )
      ).toBe(true);
    });

    it('agrees with its own metadata', async () => {
      const result = JSON.parse(JSON.stringify(await analyze()));

      // The metadata was right all along; the payload is what went missing.
      expect(result.graph.nodes.length).toBe(result.metadata.totalFiles);
      expect(result.graph.edges.length).toBe(
        result.metadata.internalDependencies
      );
    });

    it('reports a token count describing the data it actually sent', async () => {
      const result = JSON.parse(JSON.stringify(await analyze()));

      // The count was computed on the compact form, which was then discarded in
      // favour of the Map -- so it described something the caller never got.
      const actual = counter.count(JSON.stringify(result.graph)).tokens;
      expect(Math.abs(actual - result.metadata.tokenCount)).toBeLessThan(
        actual * 0.5 + 5
      );
    });
  });

  describe('smart_env values', () => {
    const SECRETS = {
      DB_PASSWORD: 'CANARY_password_hunter2_correct',
      JWT_SECRET: 'CANARY_jwt_aaaabbbbccccddddeeee',
      PUBLIC_URL: 'https://example.com',
    };

    let envPath: string;

    beforeEach(() => {
      envPath = join(root, '.env');
      writeFileSync(
        envPath,
        Object.entries(SECRETS)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n'
      );
    });

    const analyze = (checkSecurity = false) =>
      new SmartEnv(cache, counter, new MetricsCollector()).run({
        envFile: envPath,
        force: true,
        checkSecurity,
      });

    it('never returns a variable value', async () => {
      const text = JSON.stringify(await analyze());

      const canaries = Object.values(SECRETS).filter((v) =>
        v.startsWith('CANARY')
      );
      // Asserted before the loop. A fixture whose values stopped being canaries
      // leaves the guarded loop iterating zero times, asserting nothing, and
      // reporting that no secret leaked.
      expect(canaries.length).toBeGreaterThan(0);
      for (const value of canaries) expect(text).not.toContain(value);
    });

    it('still returns every variable NAME, which is the useful part', async () => {
      const text = JSON.stringify(await analyze());

      for (const key of Object.keys(SECRETS)) expect(text).toContain(key);
    });

    it('redacts under checkSecurity too, where the risk is highest', async () => {
      // The security path is the one that reads values most closely, and it
      // used to echo them into its own issue messages as well.
      const text = JSON.stringify(await analyze(true));

      // The NAMES must survive -- that is the useful half, and it proves the
      // security path actually produced a response. A run that failed and
      // returned an error object satisfies both absences below.
      for (const key of Object.keys(SECRETS)) expect(text).toContain(key);
      expect(text).not.toContain('CANARY_password_hunter2_correct');
      expect(text).not.toContain('CANARY_jwt_aaaabbbbccccddddeeee');
    });

    it('keeps the length, so "is it set" is still answerable', async () => {
      const result = await analyze();
      const dbPassword = result.parsed?.find((v) => v.key === 'DB_PASSWORD');

      expect(dbPassword?.value).toBe('[redacted]');
      expect(dbPassword?.length).toBe(SECRETS.DB_PASSWORD.length);
    });
  });
});
