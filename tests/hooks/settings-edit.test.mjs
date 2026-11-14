import { describe, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editSettings } from '../../src/hooks-core/settings-edit.mjs';

const moduleUrl = pathToFileURL(join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'hooks-core', 'settings-edit.mjs')).href;

function sandbox(content) {
  const root = mkdtempSync(join(tmpdir(), 'settings-edit-'));
  const path = join(root, 'claude', 'settings.json');
  mkdirSync(join(root, 'claude'), { recursive: true });
  if (content !== undefined) writeFileSync(path, content);
  return { root, path };
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('editSettings', () => {
  test('merges into what the file holds, with a byte-exact backup', () => {
    const s = sandbox('{ "theme": "dark" }');
    const out = editSettings(s.path, (settings) => ({ next: { ...settings, a: 1 }, note: 'x' }), { now: 7, backupTag: 'tag' });
    expect(out).toMatchObject({ status: 'written', existed: true, note: 'x' });
    expect(read(s.path)).toEqual({ theme: 'dark', a: 1 });
    expect(readFileSync(out.backup, 'utf8')).toBe('{ "theme": "dark" }');
    expect(out.backup.endsWith('settings.json.tag-7.bak')).toBe(true);
    expect(readdirSync(join(s.root, 'claude')).some((n) => n.includes('.lock'))).toBe(false);
  });

  test('a missing file is created without a backup; a skip writes nothing', () => {
    const s = sandbox();
    expect(editSettings(s.path, () => ({ skip: 'no' }))).toMatchObject({ status: 'skipped', reason: 'no', existed: false });
    expect(existsSync(s.path)).toBe(false);
    const out = editSettings(s.path, () => ({ next: { a: 1 } }), { backupTag: 'tag' });
    expect(out).toMatchObject({ status: 'written', existed: false, backup: null });
    expect(read(s.path)).toEqual({ a: 1 });
  });

  test('never rewrites a file that is not a JSON object', () => {
    for (const [content, status] of [['{ nope', 'unparseable'], ['[1]', 'not-object'], ['null', 'not-object']]) {
      const s = sandbox(content);
      expect(editSettings(s.path, () => ({ next: { a: 1 } })).status).toBe(status);
      expect(readFileSync(s.path, 'utf8')).toBe(content);
    }
  });

  test('waits for a held lock, then reports busy; a stale one is taken over', () => {
    const s = sandbox('{}');
    const lock = `${s.path}.token-optimizer.lock`;
    writeFileSync(lock, 'someone');
    expect(editSettings(s.path, () => ({ next: { a: 1 } }), { timeoutMs: 100 }).status).toBe('busy');
    expect(read(s.path)).toEqual({});
    expect(readFileSync(lock, 'utf8')).toBe('someone');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(editSettings(s.path, () => ({ next: { a: 1 } }), { timeoutMs: 100 }).status).toBe('written');
    expect(read(s.path)).toEqual({ a: 1 });
    expect(existsSync(lock)).toBe(false);
  });

  test('concurrent writers in separate processes lose no update', async () => {
    const s = sandbox('{}');
    const writers = 8;
    const script = (i) =>
      `import { editSettings } from ${JSON.stringify(moduleUrl)};` +
      `const at = Date.now() + 400; while (Date.now() < at) {}` +
      `const out = editSettings(${JSON.stringify(s.path)}, (x) => { const t = Date.now() + 30; while (Date.now() < t) {} return { next: { ...x, k${i}: ${i} } }; }, { timeoutMs: 20000 });` +
      `process.exitCode = out.status === 'written' ? 0 : 1;`;
    const codes = await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script(i)], { stdio: 'ignore' });
          child.on('exit', resolve);
        })
      )
    );
    expect(codes).toEqual(Array(writers).fill(0));
    expect(Object.keys(read(s.path)).sort()).toEqual(Array.from({ length: writers }, (_, i) => `k${i}`).sort());
  }, 60_000);
});
