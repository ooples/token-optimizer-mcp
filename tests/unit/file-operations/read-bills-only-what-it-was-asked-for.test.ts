import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * What the reply's header carries, and what it stops carrying.
 *
 * This tool's measured first-read loss was almost entirely its own header:
 * 127 tokens of a 1167-token reply against an overhead of about 150, and of
 * those 127, `hash` was 41, `path` 29 restating the argument just sent, and
 * `fileType` and `encoding` 7 each -- four fields no caller in this repository
 * read, plus 22 more for four flags while all four were false.
 *
 * Both halves are pinned here, and they are only worth anything together.
 * Cheaper alone is satisfied by a tool that stopped computing any of it;
 * restorable alone is satisfied by changing nothing. So every claim about what
 * the default reply omits sits beside the arm that asks for it and gets it.
 */
describe('what a read bills the caller for', () => {
  const tempDirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    while (caches.length) {
      try {
        caches.pop()?.close();
      } catch {
        // already closed
      }
    }
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir may linger on Windows
        }
      }
    }
  });

  const BODY = Array.from(
    { length: 40 },
    (_, i) => `export const value${i} = ${i};`
  ).join('\n');

  function makeFixture(name = 'read.ts', body = BODY) {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-header-'));
    tempDirs.push(dir);
    const cache = new CacheEngine(join(dir, 'cache.db'));
    caches.push(cache);
    const file = join(dir, name);
    writeFileSync(file, body);
    return {
      tool: new SmartReadTool(
        cache,
        new TokenCounter(),
        new MetricsCollector()
      ),
      file,
      body,
    };
  }

  it('sends the size and nothing else on an ordinary read', async () => {
    // THE EXACT KEY SET, not a handful of `toBeUndefined` checks: a field that
    // creeps back in is the whole regression, and naming the four that were
    // dropped would miss the fifth somebody adds next.
    const { tool, file } = makeFixture();
    const result = await tool.read(file, { enableCache: false });

    expect(Object.keys(result.metadata)).toEqual(['size']);
    expect(result.metadata.size).toBeGreaterThan(0);
    // And the file still arrives. A header that costs nothing is otherwise
    // satisfied by a tool that returns nothing.
    expect(result.content).toContain('value39 = 39;');
  });

  it('sends all four back when they are asked for', async () => {
    // THE CONTROL ARM. The tool still computes every one of them, so the
    // default is a billing decision the caller can reverse -- not a capability
    // that was removed. Without this arm, a read that had stopped hashing
    // altogether would pass the test above.
    const { tool, file } = makeFixture();
    const asked = await tool.read(file, {
      enableCache: false,
      includeMetadata: true,
    });

    expect(asked.metadata.path).toBe(file);
    expect(asked.metadata.fileType).toBe('typescript');
    expect(asked.metadata.encoding).toBe('utf-8');
    // A sha256 in hex, which is what made this field 41 tokens on its own.
    expect(asked.metadata.hash).toMatch(/^[0-9a-f]{64}$/);

    const plain = await tool.read(file, { enableCache: false });
    // Measured on the two replies as they go on the wire. The saving is the
    // difference between the headers, so it is read off both of them.
    expect(JSON.stringify(asked.metadata).length).toBeGreaterThan(
      4 * JSON.stringify(plain.metadata).length
    );
  });

  it('reports a flag only when it is true, and reports it then', async () => {
    const { tool, file } = makeFixture();

    const cold = await tool.read(file);
    expect(cold.metadata.fromCache).toBeUndefined();

    const warm = await tool.read(file);
    // The informative case still arrives: absence has to mean false, which it
    // cannot if the true case is also absent.
    expect(warm.metadata.fromCache).toBe(true);
  });

  it('names an encoding that is not the one every caller assumes', async () => {
    // The one constant worth sending unasked. Content decoded as latin1 and
    // labelled nothing reads as corrupt rather than as a different encoding,
    // so this is honest verbosity, not payload waste.
    const { tool, file } = makeFixture('latin.txt', 'café au lait');
    const result = await tool.read(file, {
      enableCache: false,
      encoding: 'latin1',
    });

    expect(result.metadata.encoding).toBe('latin1');
    // And `utf8`, the other spelling of the default, still says nothing.
    const same = await tool.read(file, {
      enableCache: false,
      encoding: 'utf8',
    });
    expect(same.metadata.encoding).toBeUndefined();
  });
});
