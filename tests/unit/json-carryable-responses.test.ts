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

    it('sends no count a reader could take off the graph', async () => {
      const result = JSON.parse(JSON.stringify(await analyze()));

      // This used to assert that the counts AGREED with the graph, because
      // for a while they were the only part of the answer that was right.
      // Now the graph travels and they do not: every one of them was a
      // length over rows in the same response, and one -- the external count
      // -- was a length over a graph that had been filtered out of it.
      expect(result.metadata.totalFiles).toBeUndefined();
      expect(result.metadata.analyzedFiles).toBeUndefined();
      expect(result.metadata.internalDependencies).toBeUndefined();
      expect(result.metadata.externalDependencies).toBeUndefined();

      // And the reader loses nothing: both figures are still there to take.
      expect(result.graph.nodes.length).toBe(3);
      expect(result.graph.edges.length).toBe(2);
    });

    it('states what it analysed in a mode that sends no graph', async () => {
      // THE SCOPE OF THAT SILENCE, pinned from the other side. `circular`
      // answers with findings and no graph, so there is nothing for a caller
      // to count and the metadata is the only statement of how much was
      // walked. A blanket removal of these counts would land here.
      const result = JSON.parse(
        JSON.stringify(
          await new SmartDependenciesTool(
            cache,
            counter,
            new MetricsCollector()
          ).analyze({ cwd: root, useCache: false, mode: 'circular' })
        )
      );

      expect(result.graph).toBeUndefined();
      expect(result.metadata.totalFiles).toBe(3);
    });

    it('reports no token count at all, having nothing it could count', async () => {
      /*
       * THIS TEST ASKED FOR A COUNT THAT COULD NOT EXIST.
       *
       * It was written against a `tokenCount` computed on a compact form the
       * tool then discarded in favour of the Map -- a figure describing
       * something the caller never got, which is the defect this file is
       * about. It was then re-pointed at the payload, within 50% plus 5, and
       * that is as close as it could ever be: what a caller pays for is this
       * object serialised with the report text and the transport metadata
       * built around it after the tool returns, so no field in here is it.
       *
       * The three tests above pin that the payload is the graph. What the
       * payload costs is counted once, at the wire. So the assertion is that
       * the tool publishes no such figure under any of the names this fleet
       * has used for one.
       */
      const result = JSON.parse(JSON.stringify(await analyze()));

      const NAMES = [
        'tokenCount',
        'originalTokenCount',
        'tokensSaved',
        'savedTokens',
        'compressionRatio',
      ];
      const found: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (NAMES.includes(key)) found.push(key);
          walk(value);
        }
      };
      walk(result);
      expect(found).toEqual([]);
      // THE POSITIVE CONTROLS: the walk descends into a reply of this shape,
      // and the reply really is the graph analysis under test.
      walk({ metadata: { tokenCount: 1 } });
      expect(found).toEqual(['tokenCount']);
      expect(result.graph.nodes.length).toBe(3);
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

    it('answers "is it set" without reporting a length', async () => {
      /*
       * THE QUESTION SURVIVED THE COLUMN THAT USED TO ANSWER IT. `length` was
       * 45% of this report's tokens and is now opt-in, so set-ness is read off
       * the `empty` list instead -- which names only the variables the flag is
       * true of, and so costs nothing in the normal case where none are.
       */
      const result = await analyze();

      expect(result.parsed?.rows.map((r) => r[0])).toContain('DB_PASSWORD');
      expect(result.parsed?.empty ?? []).not.toContain('DB_PASSWORD');
    });

    it('still reports an exact length to a caller who asks for one', async () => {
      const result = await new SmartEnv(
        cache,
        counter,
        new MetricsCollector()
      ).run({ envFile: envPath, force: true, includeLocations: true });
      const columns = result.parsed?.columns ?? [];
      const row = result.parsed?.rows.find((r) => r[0] === 'DB_PASSWORD');

      // The column is found by NAME, not by position: a reordered table then
      // fails here instead of quietly asserting a line number against a length.
      expect(row).toBeDefined();
      expect(row?.[columns.indexOf('length')]).toBe(SECRETS.DB_PASSWORD.length);
    });

    it('has no value field for a value to be returned in', async () => {
      // BOTH SHAPES. The redaction used to be a placeholder written OVER the
      // value, so every path that built a response had to remember to apply it;
      // a shape with no value field cannot leak one by a path that forgets, and
      // the wider shape is the one with the most room to forget in.
      const lean = await analyze(true);
      const located = await new SmartEnv(
        cache,
        counter,
        new MetricsCollector()
      ).run({ envFile: envPath, force: true, includeLocations: true });

      expect(lean.parsed?.columns).toEqual(['key']);
      expect(located.parsed?.columns).toEqual(['key', 'line', 'length']);
      expect(JSON.stringify(lean)).not.toContain('"value":');
      expect(JSON.stringify(located)).not.toContain('"value":');
    });
  });
});
