import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const write = jest.fn<typeof fs.writeFileSync>(fs.writeFileSync);
const asyncWrite = jest.fn<typeof fsp.writeFile>(fsp.writeFile);
const rename = jest.fn<typeof fsp.rename>(fsp.rename);
jest.unstable_mockModule('fs', () => ({
  ...fs,
  writeFileSync: write,
}));
jest.unstable_mockModule('fs/promises', () => ({
  ...fsp,
  writeFile: asyncWrite,
  rename,
}));
const { SmartEditTool } = await import(
  '../../../src/tools/file-operations/smart-edit.js'
);
const { CacheEngine } = await import('../../../src/core/cache-engine.js');
const { TokenCounter } = await import('../../../src/core/token-counter.js');
const { MetricsCollector } = await import('../../../src/core/metrics.js');

describe('smart_edit preserves the original on storage failure', () => {
  let root: string;
  let file: string;
  let cache: InstanceType<typeof CacheEngine>;
  let counter: InstanceType<typeof TokenCounter>;
  let tool: InstanceType<typeof SmartEditTool>;
  const original = 'keep this\nstate=pending\nkeep this too\n';
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'edit-storage-failure-'));
    file = join(root, 'notes.txt');
    fs.writeFileSync(file, original);
    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
    tool = new SmartEditTool(cache, counter, new MetricsCollector());
    write.mockReset().mockImplementation(fs.writeFileSync);
    asyncWrite.mockReset().mockImplementation(fsp.writeFile);
    rename.mockReset().mockImplementation(fsp.rename);
  });
  afterEach(() => {
    cache.close();
    counter.free();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const edit = () =>
    tool.edit(
      file,
      [{ type: 'replace', startLine: 2, endLine: 2, content: 'state=ready' }],
      { createBackup: false }
    );
  function expectOriginal() {
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(
      fs
        .readdirSync(root)
        .filter((name) => name.startsWith('.token-optimizer-edit-'))
    ).toEqual([]);
  }
  it('survives a partial write followed by ENOSPC without a backup', async () => {
    asyncWrite.mockImplementationOnce(async (target) => {
      await fsp.writeFile(target, 'partial');
      throw Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      });
    });
    write.mockImplementationOnce((target) => {
      fs.writeFileSync(target, 'partial');
      throw Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      });
    });
    const result = await edit();
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOSPC');
    expectOriginal();
  });
  it('preserves the original when replacement is denied', async () => {
    rename.mockImplementationOnce(async () => {
      throw Object.assign(new Error('EPERM: replacement denied'), {
        code: 'EPERM',
      });
    });
    const result = await edit();
    expect(result.success).toBe(false);
    expect(result.error).toContain('EPERM');
    expectOriginal();
  });
  it('commits a complete edit and removes the temporary file', async () => {
    const result = await edit();
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      original.replace('pending', 'ready')
    );
    expect(
      fs
        .readdirSync(root)
        .filter((name) => name.startsWith('.token-optimizer-edit-'))
    ).toEqual([]);
  });
  it('rejects a stale concurrent edit instead of overwriting the first commit', async () => {
    const results = await Promise.all([edit(), edit()]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toContain(
      'File changed'
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(
      original.replace('pending', 'ready')
    );
  });
  it('preserves an external change made while writing the temporary file', async () => {
    asyncWrite.mockImplementationOnce(async (target, content, options) => {
      await fsp.writeFile(target, content, options);
      fs.writeFileSync(file, 'changed by another writer');
    });
    expect((await edit()).success).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('changed by another writer');
  });
  (process.platform === 'win32' ? it.skip : it)(
    'preserves executable permissions',
    async () => {
      fs.chmodSync(file, 0o750);
      expect((await edit()).success).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o750);
    }
  );
  (process.platform === 'win32' ? it.skip : it)(
    'edits a symlink target without replacing the link',
    async () => {
      const target = file;
      file = join(root, 'link.txt');
      fs.symlinkSync(target, file);
      expect((await edit()).success).toBe(true);
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(
        original.replace('pending', 'ready')
      );
    }
  );
});
