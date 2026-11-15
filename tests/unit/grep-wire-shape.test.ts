import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SmartGrepTool,
  compactGrepMatches,
} from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * An aggregation search must be answerable in one call, and a page must spend
 * its budget on hits rather than on repeated keys.
 *
 * THOL `code-settings-inventory-django` (#565) asks for every `settings.NAME`
 * read in Django: 577 hits. smart_grep sent each hit as
 * `{"file":..,"lineNumber":..,"line":..,"match":..}`. The 8,000-token budget ran
 * out at ~225 hits, so the model paged three times and the run cost 2.27x a
 * plain `grep -oh | sort -u`.
 */

const NAMES = 60;
const FILES = 40;
const LINES_PER_FILE = 30;

let dir: string;
let cache: CacheEngine;
let tool: SmartGrepTool;
const tokenCounter = new TokenCounter();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-wire-'));
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  for (let f = 0; f < FILES; f++) {
    const lines: string[] = [];
    for (let l = 0; l < LINES_PER_FILE; l++) {
      const a = `NAME_${(f * LINES_PER_FILE + l) % NAMES}`;
      // Every fifth line reads two settings; the second is a name no line
      // reads first, so only a per-occurrence aggregate can see it.
      lines.push(
        l % 5 === 0
          ? `        if settings.${a} and settings.SECOND_ONLY_${l % 3}:  # padding to look like real source code`
          : `        value = getattr(self, "x", None) or settings.${a}  # padding to look like real source code`
      );
    }
    writeFileSync(join(dir, 'pkg', `mod${f}.py`), lines.join('\n') + '\n');
  }
  cache = new CacheEngine(join(dir, 'cache'), 10);
  tool = new SmartGrepTool(cache, tokenCounter, new MetricsCollector());
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    // temp dir goes anyway
  }
  rmSync(dir, { recursive: true, force: true });
});

const search = (pattern: string, extra: Record<string, unknown> = {}) =>
  tool.grep(pattern, {
    path: join(dir, 'pkg'),
    regex: true,
    limit: 3000,
    ...extra,
  });

describe('smart_grep aggregation', () => {
  it('lists every distinct matched text when the page cannot show every hit', async () => {
    const result = await search('settings\\.[A-Z][A-Z0-9_]+');

    expect(result.metadata.totalMatches).toBe(FILES * LINES_PER_FILE);
    expect(result.metadata.truncated).toBe(true);

    const distinct = result.distinct ?? [];
    const texts = distinct.map(([text]) => text);
    // Every first-read name, plus the names only ever read second on a line.
    expect(texts).toHaveLength(NAMES + 3);
    expect(texts).toContain('settings.SECOND_ONLY_2');
    // The counts are occurrences, so they sum to the occurrence total.
    const summed = distinct.reduce((n, [, count]) => n + count, 0);
    expect(summed).toBe(result.metadata.occurrences);
    // Each carries a real location the caller can open.
    for (const [, , at] of distinct) expect(at).toMatch(/^mod\d+\.py:\d+$/);
  });

  it('keeps hits plus summary within the one-response ceiling', async () => {
    const result = await search('settings\\.[A-Z][A-Z0-9_]+');
    expect(result.distinct).toBeDefined();
    const sent = tokenCounter.count(
      JSON.stringify({
        hits: compactGrepMatches(result.matches ?? []),
        distinct: result.distinct,
      })
    ).tokens;
    expect(sent).toBeLessThanOrEqual(8_000);
  });

  it('adds no summary when every hit is already on the page', async () => {
    const result = await search('settings\\.NAME_7\\b');
    expect(result.metadata.truncated).toBe(false);
    expect(result.distinct).toBeUndefined();
  });

  it('adds no summary for a literal search, where every match is the pattern', async () => {
    const result = await search('padding to look', { regex: false });
    expect(result.distinct).toBeUndefined();
  });
});

describe('smart_grep wire shape', () => {
  it('groups hits by file as [line, text] pairs, keeping every hit', async () => {
    const result = await search('settings\\.[A-Z][A-Z0-9_]+');
    const matches = result.matches ?? [];
    const hits = compactGrepMatches(matches);

    const sent = Object.values(hits).flat();
    expect(sent).toHaveLength(matches.length);
    for (const [file, list] of Object.entries(hits)) {
      for (const [lineNumber, text] of list) {
        const original = matches.find(
          (m) => m.file === file && m.lineNumber === lineNumber
        );
        expect(original?.line).toBe(text);
      }
    }
  });

  it('fits more hits under the response budget than the record form did', async () => {
    const result = await search('settings\\.[A-Z][A-Z0-9_]+');
    const page = result.matches ?? [];
    const compact = tokenCounter.count(
      JSON.stringify({ hits: compactGrepMatches(page) })
    ).tokens;
    const records = tokenCounter.count(
      JSON.stringify({ matches: page })
    ).tokens;

    // Within budget as sent, and a page the record form could never have
    // carried: sized as records, the same hits are over the budget.
    expect(compact).toBeLessThanOrEqual(8_000);
    expect(records).toBeGreaterThan(8_000);
  });

  it('keeps requested columns and context', () => {
    const hits = compactGrepMatches([
      {
        file: 'a.py',
        lineNumber: 3,
        line: 'x = 1',
        column: 0,
        before: ['# b'],
        after: [],
      },
    ]);
    expect(hits).toEqual({
      'a.py': [[3, 'x = 1', { columns: [0], before: ['# b'] }]],
    });
  });
});
