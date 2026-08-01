import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { SmartEditTool, BACKUP_ROOT } from '../../../src/tools/file-operations/smart-edit.js';
import { createHash } from 'crypto';
import { SmartGlobTool } from '../../../src/tools/file-operations/smart-glob.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * An edit must give a file back the line endings it came with.
 *
 * Measured on Windows against a real CRLF file: `split('\n')` left a trailing
 * '\r' on every untouched line while the replaced line had none, and
 * `join('\n')` wrote the result back -- turning 4 CRLF into 3 CRLF + 1 bare LF.
 * Nothing errors, so it stays invisible until git reports the line as changed
 * or a .gitattributes check fails, and it compounds with every later edit.
 */
describe('smart_edit line endings', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];
  const backupDirs: string[] = [];

  afterEach(() => {
    while (caches.length) {
      try { caches.pop()?.close(); } catch { /* already closed */ }
    }
    while (dirs.length) {
      const d = dirs.pop();
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows */ } }
    }
    // Every successful edit writes a backup under the user's HOME directory,
    // outside the temp fixture. Removing only the fixture left one directory
    // per test behind on the machine running the suite, for ever -- a test
    // suite that litters the developer's home is its own small defect.
    while (backupDirs.length) {
      const d = backupDirs.pop();
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows */ } }
    }
  });

  function fixture(body: string): { tool: SmartEditTool; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-eol-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'c.db'));
    caches.push(cache);
    const file = join(dir, 'file.ts');
    writeFileSync(file, body);
    // Keyed exactly as writeBackup keys it, so teardown removes the real one.
    backupDirs.push(
      join(BACKUP_ROOT, createHash('sha256').update(file).digest('hex').slice(0, 16))
    );
    return { tool: new SmartEditTool(cache, new TokenCounter(), new MetricsCollector()), file };
  }

  const counts = (s: string) => {
    const crlf = (s.match(/\r\n/g) || []).length;
    return { crlf, bareLf: (s.match(/\n/g) || []).length - crlf };
  };

  it('keeps a CRLF file entirely CRLF', async () => {
    const lines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
    const { tool, file } = fixture(lines.join('\r\n'));

    await tool.edit(file, { type: 'replace', startLine: 3, endLine: 3, content: 'REPLACED' });

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('REPLACED');
    expect(counts(after).bareLf).toBe(0);
    expect(counts(after).crlf).toBe(4);
  });

  it('keeps an LF file entirely LF', async () => {
    const { tool, file } = fixture(['a', 'b', 'c'].join('\n'));

    await tool.edit(file, { type: 'replace', startLine: 2, endLine: 2, content: 'B' });

    const after = readFileSync(file, 'utf8');
    expect(after).toBe(['a', 'B', 'c'].join('\n'));
    expect(counts(after).crlf).toBe(0);
  });

  it('normalises multi-line inserted content to the file it lands in', async () => {
    // The caller types '\n' regardless of the file's convention.
    const { tool, file } = fixture(['x', 'y', 'z'].join('\r\n'));

    await tool.edit(file, { type: 'insert', startLine: 2, content: 'one\ntwo' });

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('one');
    expect(after).toContain('two');
    expect(counts(after).bareLf).toBe(0);
  });

  it('leaves no backup file in the working tree', async () => {
    // Measured live: an edit to a real checkout left an untracked README.md.bak
    // in `git status`, one `git add -A` from being committed, and nothing ever
    // removed it. A safety net that dirties the tree it protects is a bad
    // trade, so backups live under the home directory instead.
    const { tool, file } = fixture(['a', 'b', 'c'].join('\n'));
    const dir = dirname(file);
    const before = readdirSync(dir);

    await tool.edit(file, { type: 'replace', startLine: 1, endLine: 1, content: 'A' });

    const after = readdirSync(dir);
    expect(after.filter((f) => f.endsWith('.bak'))).toEqual([]);
    expect(after.sort()).toEqual(before.sort());
  });

  it('still keeps the previous content somewhere recoverable', async () => {
    const { tool, file } = fixture(['keep', 'me'].join('\n'));

    await tool.edit(file, { type: 'replace', startLine: 1, endLine: 1, content: 'changed' });

    const key = createHash('sha256').update(file).digest('hex').slice(0, 16);
    const stash = join(BACKUP_ROOT, key);
    expect(existsSync(stash)).toBe(true);
    const saved = readdirSync(stash).map((f) => readFileSync(join(stash, f), 'utf8'));
    expect(saved.some((s) => s.includes('keep'))).toBe(true);
    rmSync(stash, { recursive: true, force: true });
  });

  it('does not rewrite a whole file because of one stray ending', async () => {
    // Dominance, not first-match: a mostly-LF file stays LF.
    const { tool, file } = fixture('a\nb\r\nc\nd\ne\n');

    await tool.edit(file, { type: 'replace', startLine: 4, endLine: 4, content: 'D' });

    expect(counts(readFileSync(file, 'utf8')).crlf).toBe(0);
  });
});

/**
 * A search tool that hides real matches must at least say so.
 *
 * `dist` and `build` are conventions, not guarantees, and the hook DENIES the
 * built-in Glob and sends callers here -- so a silent omission is not a smaller
 * result set, it is the caller concluding their file does not exist. Measured
 * live: '**\/*.csproj' over AiDotNet.Tensors returned 16 of its 18, with the two
 * under build/ dropped and nothing said.
 */
describe('smart_glob reports what it withheld', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    while (caches.length) {
      try { caches.pop()?.close(); } catch { /* already closed */ }
    }
    while (dirs.length) {
      const d = dirs.pop();
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows */ } }
    }
  });

  function repo(): { tool: SmartGlobTool; cwd: string } {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-glob-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'c.db'));
    caches.push(cache);
    const work = join(dir, 'work');
    for (const rel of ['src/a.csproj', 'build/LicenseValidator/b.csproj', 'src/nested/c.csproj']) {
      const full = join(work, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '<Project />');
    }
    return { tool: new SmartGlobTool(cache, new TokenCounter(), new MetricsCollector()), cwd: work };
  }

  it('names the count and the way to see them', async () => {
    const { tool, cwd } = repo();
    const r = await tool.glob('**/*.csproj', { cwd, useCache: false });

    expect(r.metadata.ignoredMatches).toBe(1);
    expect(r.metadata.ignoreNote).toContain('ignore: []');
    expect((r.files ?? []).length).toBe(2);
  });

  it('says nothing when nothing was withheld', async () => {
    const { tool, cwd } = repo();
    const r = await tool.glob('src/**/*.csproj', { cwd, useCache: false });

    expect(r.metadata.ignoredMatches).toBeUndefined();
    expect(r.metadata.ignoreNote).toBeUndefined();
  });

  it('an explicit empty ignore really does return everything', async () => {
    const { tool, cwd } = repo();
    const r = await tool.glob('**/*.csproj', { cwd, ignore: [], useCache: false });

    expect((r.files ?? []).length).toBe(3);
  });
});
