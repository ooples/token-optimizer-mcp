/**
 * A FORMATTER THAT NEVER READS THE FILE.
 *
 * Every operation on this tool accepted `filePath`, checked that one of
 * code/filePath was present, and then worked on `options.code || ''`. A caller
 * who passed a path got back `code: ""`, `formatted: true`, `changes: 0` and a
 * measured 94% token reduction -- the cost of an empty string. The bench had
 * the figure right and the tool wrong: nothing had been formatted at all.
 *
 * The reduction figure was invented twice over. The highlight baseline was
 * `count(code) * 1.5` ("minimal overhead for fresh highlight") and the result
 * was clamped with `Math.max(0, ...)`. Markup is strictly ADDED to the code, so
 * the multiplier existed to make the difference positive and the clamp caught
 * the cases where even that was not enough. Highlighting and formatting cannot
 * save tokens, and the figure now says so.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { SmartPretty } from '../../../src/tools/output-formatting/smart-pretty.js';

const SUBJECT = [
  "export function greet(name: string): string {",
  "  const greeting = 'hello, ' + name;",
  "  return greeting;",
  "}",
  "",
].join('\n');

describe('smart_pretty works on the file it was given', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    for (const cache of caches) {
      cache.close();
    }
    caches.length = 0;
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  const build = (): { tool: SmartPretty; counter: TokenCounter; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'pretty-reads-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'c.db'));
    caches.push(cache);
    const counter = new TokenCounter();
    const tool = new SmartPretty(cache, counter, new MetricsCollector());
    return { tool, counter, dir };
  };

  const fixture = (dir: string, source: string): string => {
    const filePath = join(dir, 'subject.ts');
    writeFileSync(filePath, source, 'utf-8');
    return filePath;
  };

  it('formats the contents of filePath rather than the empty string', async () => {
    const { tool, dir } = build();
    const result = await tool.run({
      operation: 'format-code',
      filePath: fixture(dir, SUBJECT),
    });

    expect(result.data.format).toBeDefined();
    const format = result.data.format;
    if (!format) {
      throw new Error('format result missing');
    }
    expect(format.code).toContain('greet');
    expect(format.code.length).toBeGreaterThan(0);
  });

  it('highlights the contents of filePath rather than the empty string', async () => {
    const { tool, dir } = build();
    const result = await tool.run({
      operation: 'highlight-code',
      filePath: fixture(dir, SUBJECT),
      outputMode: 'ansi',
    });

    const highlight = result.data.highlight;
    if (!highlight) {
      throw new Error('highlight result missing');
    }
    expect(highlight.code).toContain('greet');
    expect(highlight.lineCount).toBeGreaterThan(1);
  });

  it('says which file it could not read instead of answering about nothing', async () => {
    const { tool, dir } = build();
    await expect(
      tool.run({ operation: 'format-code', filePath: join(dir, 'absent.ts') })
    ).rejects.toThrow(/Could not read/);
  });

  it('still honours an explicitly empty code string', async () => {
    const { tool, dir } = build();
    const result = await tool.run({
      operation: 'format-code',
      code: '',
      language: 'typescript',
      filePath: fixture(dir, SUBJECT),
    });

    const format = result.data.format;
    if (!format) {
      throw new Error('format result missing');
    }
    expect(format.code).toBe('');
  });

  it('reports formatting as the cost it is, not a clamped zero', async () => {
    const { tool, counter } = build();
    // prettier reflows this into four lines with spaces inside the braces, so
    // the formatted text is strictly larger than what went in. That is the
    // case the Math.max(0, ...) clamp used to report as a saving of zero.
    const dense = 'const x={a:1,b:2,c:3};function f(y){return y+1}\n';
    const result = await tool.run({
      operation: 'format-code',
      code: dense,
      language: 'typescript',
    });

    const format = result.data.format;
    if (!format) {
      throw new Error('format result missing');
    }
    const input = counter.count(dense).tokens;
    expect(format.metadata.tokensUsed).toBeGreaterThan(input);
    expect(format.metadata.tokensSaved).toBeLessThan(0);
    expect(format.metadata.tokensSaved).toBe(
      input - format.metadata.tokensUsed
    );
    expect(result.metadata.tokensSaved).toBe(format.metadata.tokensSaved);
  });

  it('says highlighting did not happen instead of returning plain code as highlighted', async () => {
    const { tool, counter, dir } = build();
    const result = await tool.run({
      operation: 'highlight-code',
      filePath: fixture(dir, SUBJECT),
      outputMode: 'ansi',
    });

    const highlight = result.data.highlight;
    if (!highlight) {
      throw new Error('highlight result missing');
    }
    // highlight.js is an optional dependency this package does not declare,
    // and the two mode helpers read a module-level handle that only
    // runSmartPretty primed. A caller holding the class therefore got the
    // plain source back with highlighted: true on it. The absence is now
    // loaded for, reported, and -- since nothing was added -- measured at
    // zero rather than asserted at zero.
    expect(highlight.highlighted).toBe(false);
    expect(highlight.highlightError).toContain('highlight.js');
    expect(highlight.code).toBe(SUBJECT);
    expect(highlight.metadata.tokensUsed).toBe(counter.count(SUBJECT).tokens);
    expect(highlight.metadata.tokensSaved).toBe(0);
  });

  it('reports the same figures on a cache hit as on the first call', async () => {
    const { tool, dir } = build();
    const filePath = fixture(dir, SUBJECT);
    const first = await tool.run({ operation: 'format-code', filePath });
    const second = await tool.run({ operation: 'format-code', filePath });

    const a = first.data.format;
    const b = second.data.format;
    if (!a || !b) {
      throw new Error('format result missing');
    }
    // The cache-hit path compared the served output against itself, which
    // reports zero without measuring anything. A hit returns what the fresh
    // call returned, so it costs the same; what the cache saves is time.
    expect(b.metadata.cacheHit).toBe(true);
    expect(b.metadata.tokensUsed).toBe(a.metadata.tokensUsed);
    expect(b.metadata.tokensSaved).toBe(a.metadata.tokensSaved);
  });

  it('surfaces the formatter failure instead of claiming the code was fine', async () => {
    const { tool } = build();
    const result = await tool.run({
      operation: 'format-code',
      code: 'const = = = ;',
      language: 'typescript',
    });

    const format = result.data.format;
    if (!format) {
      throw new Error('format result missing');
    }
    expect(format.formatted).toBe(false);
    expect(format.formatError).toBeDefined();
    expect(format.formatError).not.toBe('');
  });
});
