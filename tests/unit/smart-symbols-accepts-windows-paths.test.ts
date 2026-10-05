/**
 * smart_symbols must accept the paths a Windows client actually sends.
 *
 * Its language-service host compared the requested file name against the one it
 * held using string equality. TypeScript addresses files by a path it has
 * normalised to forward slashes, so on Windows the host was asked for
 * 'C:/dir/x.ts', held 'C:\dir\x.ts', answered undefined, and the service
 * reported "Could not find source file". Every absolute Windows path and every
 * relative path failed; the single input that worked was a forward-slash
 * absolute path, which no Windows client sends.
 *
 * The bug was invisible to the suite because nothing drove the tool with a real
 * platform path -- so the cases below are the three forms a caller can send,
 * each against its own file so a cache hit cannot stand in for a parse.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { runSmartSymbols } from '../../src/tools/code-analysis/smart-symbols.js';

const SOURCE = `export interface Shape {\n  sides: number;\n}\n\nexport function describe(shape: Shape): string {\n  return \`a shape with \${shape.sides} sides\`;\n}\n`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'smart-symbols-paths-'));
});

/** Each case writes its own file, so no reading can be served from another's cache. */
function fileFor(name: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, SOURCE, 'utf8');
  return path;
}

describe('the path forms a client sends', () => {
  test('an absolute path in the platform separator', async () => {
    const output = await runSmartSymbols({ filePath: fileFor('platform') });
    expect(output).toContain('describe');
    expect(output).not.toContain('Could not find source file');
  });

  test('an absolute path with forward slashes', async () => {
    const path = fileFor('forward').split(sep).join('/');
    const output = await runSmartSymbols({ filePath: path });
    expect(output).toContain('describe');
    expect(output).not.toContain('Could not find source file');
  });

  // The separators can also be mixed, which is what join() returns once any
  // part of a path has come from a client that sends forward slashes.
  test('an absolute path with mixed separators', async () => {
    const path = fileFor('mixed');
    const mixed = path.slice(0, path.lastIndexOf(sep)) + '/' + 'mixed.ts';
    const output = await runSmartSymbols({ filePath: mixed });
    expect(output).toContain('describe');
    expect(output).not.toContain('Could not find source file');
  });

  // A relative path is deliberately not a case here. It resolves against the
  // server's working directory rather than anything the caller passes -- the
  // options carry no project root, only the constructor does -- so a test for
  // it would have to chdir the whole process, and a process-wide mutation in a
  // shared jest worker is how suites poison each other. The server path is
  // covered where it belongs, by the stdio contract test.

  // A POSITIVE CONTROL ON THE ASSERTIONS ABOVE. They are satisfied by any
  // output naming the symbol, including one from a tool that never resolved the
  // file and reported nothing useful. This is the arm that proves the tool still
  // refuses what it should: a file that is not there must not quietly succeed.
  test('a file that does not exist is still refused', async () => {
    await expect(
      runSmartSymbols({ filePath: join(dir, 'absent.ts') })
    ).rejects.toThrow(/File not found/);
  });
});