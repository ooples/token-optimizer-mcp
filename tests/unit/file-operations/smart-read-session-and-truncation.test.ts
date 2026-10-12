import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartReadTool } from '../../../src/tools/file-operations/smart-read.js';
import { SmartWriteTool } from '../../../src/tools/file-operations/smart-write.js';
import { SmartConfigReadTool } from '../../../src/tools/configuration/smart-config-read.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import {
  chunkBySyntax,
  truncateContent,
} from '../../../src/tools/shared/syntax-utils.js';

/**
 * #488: a session's first read of a file is the file, never `// No changes`.
 * The cache is on disk and shared by every server process, so a key without a
 * session in it handed a fresh session a diff against a read it never made --
 * and with `ttl` ignored, for as long as the database kept the entry.
 *
 * #489: truncating a large non-code file keeps its top, an explicit chunkIndex
 * still pages a file over maxSize, and the result honours maxSize.
 */
const tempDirs: string[] = [];
const caches: CacheEngine[] = [];
const savedSession = process.env.TOKEN_OPTIMIZER_SESSION_ID;

afterEach(() => {
  if (savedSession === undefined) delete process.env.TOKEN_OPTIMIZER_SESSION_ID;
  else process.env.TOKEN_OPTIMIZER_SESSION_ID = savedSession;
  while (caches.length) {
    try {
      caches.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): { dir: string; cache: CacheEngine } {
  const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-488-'));
  tempDirs.push(dir);
  const cache = new CacheEngine(join(dir, 'cache.db'));
  caches.push(cache);
  return { dir, cache };
}

const reader = (cache: CacheEngine): SmartReadTool =>
  new SmartReadTool(cache, new TokenCounter(), new MetricsCollector());

describe('#488 smart_read is scoped to the session that read', () => {
  it('gives a second session the file on its first read, from a shared cache', async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'fresh.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');

    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-one';
    expect((await reader(cache).read(file)).content).toBe(
      'alpha\nbeta\ngamma\n'
    );

    // A new session, a new tool instance, the same on-disk cache.
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-two';
    expect((await reader(cache).read(file)).content).toBe(
      'alpha\nbeta\ngamma\n'
    );
  });

  it('still answers an unchanged re-read in the same session with no changes', async () => {
    // THE POSITIVE CONTROL: scoping must not switch off the saving it scopes.
    const { dir, cache } = workspace();
    const file = join(dir, 'same.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-one';
    const tool = reader(cache);
    await tool.read(file);
    expect((await tool.read(file)).content).toBe('// No changes');
  });

  it('honours ttl: an expired read is read again in full', async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'ttl.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-one';
    const tool = reader(cache);
    await tool.read(file, { ttl: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await tool.read(file, { ttl: 1 })).content).toBe(
      'alpha\nbeta\ngamma\n'
    );
  });

  it("does not hand another session's smart_write to a fresh reader as a base", async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'written.txt');
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'writer-session';
    await new SmartWriteTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    ).write(file, 'one\ntwo\nthree\n');

    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'reader-session';
    expect((await reader(cache).read(file)).content).toBe('one\ntwo\nthree\n');
  });

  it("still uses the session's own smart_write as a base (positive control)", async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'own-write.txt');
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'writer-session';
    await new SmartWriteTool(
      cache,
      new TokenCounter(),
      new MetricsCollector()
    ).write(file, 'one\ntwo\nthree\n');
    expect((await reader(cache).read(file)).content).toBe('// No changes');
  });
});

describe('#488 the same leak in smart_config_read', () => {
  // Found reviewing the #488 fix: the config reader answers an unchanged
  // re-read with `_status: 'unchanged'` and no config, off a path-and-hash key
  // in the same shared cache, kept for a week by default.
  it("gives a second session the config, and the same session 'unchanged'", async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ name: 'demo', retries: 3 }));
    const configReader = () =>
      new SmartConfigReadTool(
        cache,
        new TokenCounter(),
        new MetricsCollector()
      );
    const unchanged = (result: unknown) =>
      JSON.stringify(result).includes('"_status":"unchanged"');

    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-one';
    expect(unchanged(await configReader().read(file))).toBe(false);
    expect(unchanged(await configReader().read(file))).toBe(true); // positive control

    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-two';
    const fresh = await configReader().read(file);
    expect(unchanged(fresh)).toBe(false);
    expect(JSON.stringify(fresh)).toContain('demo');
  });
});

describe('#489 truncation keeps the top, and chunkIndex pages a file over maxSize', () => {
  const notes =
    '# Release Notes\n\nIMPORTANT: read the migration section first.\n\n' +
    Array.from(
      { length: 1_500 },
      (_, i) =>
        `- Change ${i + 1}: adjusted a behaviour in the release pipeline for clarity`
    ).join('\n');

  it('keeps the heading and opening of a large Markdown file', async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'notes.md');
    writeFileSync(file, notes);
    expect(notes.length).toBeGreaterThan(100_000);
    const { content } = await reader(cache).read(file, { diffMode: false });
    expect(content.startsWith('# Release Notes')).toBe(true);
    expect(content).toContain('IMPORTANT: read the migration section first.');
    expect(content).toContain('- Change 1500:'); // and still the end
  });

  it('returns the requested chunk of a file over maxSize', async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'big.txt');
    writeFileSync(file, notes);
    const { content } = await reader(cache).read(file, {
      maxSize: 5_000,
      chunkSize: 4_000,
      chunkIndex: 1,
    });
    expect(content).toContain('[chunk 2 of');
    expect(content).not.toContain('[truncated]');
  });

  it('pages every byte of a one-line file, each reply within maxSize', async () => {
    // Chunks break at lines, so a one-line minified file used to be one chunk:
    // cut to maxSize it read "chunk 1 of 1" and the rest was unreachable.
    const { dir, cache } = workspace();
    const file = join(dir, 'bundle.min.js');
    // Long minified lines AND ordinary ones, so page boundaries fall both
    // inside a line and between lines: every newline has to survive paging.
    const body = Array.from({ length: 12 }, (_, block) =>
      [
        Array.from({ length: 2_500 }, (_, i) => `v${(i + block) % 10}=1;`).join(
          ''
        ),
        ...Array.from({ length: 40 }, (_, i) => `// block ${block} line ${i}`),
      ].join('\n')
    ).join('\n');
    writeFileSync(file, body);
    const tool = reader(cache);
    const footer =
      /\n\n\/\/ \[chunk (\d+) of (\d+)\. Call smart_read again with chunkIndex=<n> for another\.\]$/;

    const first = await tool.read(file, {
      maxSize: 10_000,
      chunkSize: 4_000,
      chunkIndex: 0,
    });
    const total = Number(footer.exec(first.content)?.[2]);
    expect(total).toBeGreaterThan(1);

    let reassembled = '';
    for (let i = 0; i < total; i++) {
      const { content } = await tool.read(file, {
        maxSize: 10_000,
        chunkSize: 4_000,
        chunkIndex: i,
      });
      expect(content.length).toBeLessThanOrEqual(10_000);
      const match = footer.exec(content);
      expect(Number(match?.[1])).toBe(i + 1);
      reassembled += content.slice(
        0,
        content.length - (match?.[0].length ?? 0)
      );
    }
    expect(reassembled).toBe(body);
  });

  it('chunks concatenate back to the exact input, newlines included', () => {
    // The review's case: `ABCD\nz` at 2 paged back as `ABCDz`.
    for (const [content, size] of [
      ['ABCD\nz', 2],
      ['a\nb\nc\n', 1],
      ['line one\nline two\n\nline four', 5],
      ['no newline at all', 4],
      ['ends with newline\n', 3],
      ['\n\n\n', 2],
    ] as const) {
      const { chunks } = chunkBySyntax(content, size);
      expect(chunks.join('')).toBe(content);
      for (const chunk of chunks)
        expect(chunk.length).toBeLessThanOrEqual(size);
    }
  });

  it('counts the chunk footer inside maxSize', async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'lines.txt');
    writeFileSync(file, notes);
    // chunkSize equal to maxSize: the footer used to be added on top of a full chunk.
    for (const chunkIndex of [0, 1, 2]) {
      const { content } = await reader(cache).read(file, {
        maxSize: 4_000,
        chunkSize: 4_000,
        chunkIndex,
      });
      expect(content.length).toBeLessThanOrEqual(4_000);
      expect(content).toContain(`[chunk ${chunkIndex + 1} of`);
    }
  });

  it('refuses to page when maxSize cannot hold the footer, rather than overrunning it', async () => {
    const { dir, cache } = workspace();
    const file = join(dir, 'tiny.txt');
    writeFileSync(file, notes);
    await expect(
      reader(cache).read(file, { maxSize: 50, chunkSize: 40, chunkIndex: 0 })
    ).rejects.toThrow(/cannot page within maxSize=50/);
  });

  it('holds a re-read of a changed file to maxSize', async () => {
    // Found in review: every size check was gated on `!isDiff`, and a changed
    // file whose diff was not worth sending returned the whole file.
    const { dir, cache } = workspace();
    const file = join(dir, 'changing.md');
    const lines = (tag: string) =>
      Array.from(
        { length: 600 },
        (_, i) => `- line ${i} ${tag} ${'x'.repeat(40)}`
      ).join('\n');
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-one';
    const tool = reader(cache);
    writeFileSync(file, lines('first'));
    expect(
      (await tool.read(file, { maxSize: 5_000 })).content.length
    ).toBeLessThanOrEqual(5_000);
    writeFileSync(file, lines('second')); // every line changed
    const again = await tool.read(file, { maxSize: 5_000 });
    expect(again.content.length).toBeLessThanOrEqual(5_000);
    expect(again.content.startsWith('- line 0 second')).toBe(true);
  });

  it('never returns more than maxSize, even when every line is structural', () => {
    // Every line is an `export`, so the structure filter alone would keep the
    // whole file; long top lines would overrun it the same way.
    const exportsOnly = Array.from(
      { length: 4_000 },
      (_, i) => `export const value${i} = ${i};`
    ).join('\n');
    const longTop = Array.from({ length: 200 }, () => 'x'.repeat(5_000)).join(
      '\n'
    );
    for (const content of [exportsOnly, longTop, notes]) {
      const { truncated } = truncateContent(content, 20_000, {
        keepTop: 100,
        keepBottom: 50,
      });
      expect(truncated.length).toBeLessThanOrEqual(20_000);
    }
  });

  it('keeps code structure past the top lines, in file order', () => {
    const code = [
      "import { a } from './a';",
      ...Array.from(
        { length: 2_000 },
        (_, i) => `  // filler ${i} ${'.'.repeat(60)}`
      ),
      'export function late() {}',
      ...Array.from({ length: 200 }, (_, i) => `  // tail ${i}`),
    ].join('\n');
    const { truncated } = truncateContent(code, 50_000, {
      keepTop: 100,
      keepBottom: 50,
    });
    const order = [
      "import { a } from './a';",
      'export function late() {}',
      '  // tail 199',
    ];
    const positions = order.map((line) => truncated.indexOf(line));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });
});
