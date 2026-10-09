/**
 * A range the model asked for is passed through whole, and a fold that cites a
 * file cites the file's own line numbers (issue #473, defect 10).
 *
 * Both were observed in one session through this proxy. A paged Read of
 * adapter.mjs from line 1591 came back with its bodies folded, so the model had
 * to read again to get what it had just asked for. And the folds pointed at
 * `adapter.mjs:14-19` -- the 14th to 19th lines OF THE RESULT, which in the file
 * are its header comment. Following the pointer read the wrong code.
 *
 * The fixture is a real source file, so the engine demonstrably engages: the
 * whole-file read below must fold, or every "left alone" assertion would pass
 * because nothing was ever going to be compressed.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { v1Frontier } from '../../../src/compress/strategy.js';
import { fileLineNumbers } from '../../../src/compress/code.js';
import { readNumbering } from '../../../src/compress/numbering.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILE = join(ROOT, 'hooks-core', 'adapter.mjs');
const SOURCE = readFileSync(FILE, 'utf8').split('\n');

let spillDir: string;
let spilled = 0;
const spill = (content: string, hint: string): string => {
  const path = join(spillDir, `s${++spilled}-${hint}`);
  writeFileSync(path, content);
  return path;
};
beforeAll(() => {
  spillDir = mkdtempSync(join(tmpdir(), 'targeted-reads-'));
});
afterAll(() => rmSync(spillDir, { recursive: true, force: true }));

/** A Read result as Claude Code renders it: `   N\t` before every line. */
const numbered = (from: number, count: number): string =>
  SOURCE.slice(from - 1, from - 1 + count)
    .map((line, i) => `${String(from + i).padStart(6)}\t${line}`)
    .join('\n');

const request = (input: Record<string, unknown>, body: string): ProviderRequest =>
  ({
    model: 'claude-test',
    messages: [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: body }] },
    ],
  }) as unknown as ProviderRequest;

const resultText = (input: Record<string, unknown>, body: string): string => {
  const out = v1Frontier(request(input, body), { spill });
  const block = (out.request.messages[2].content as Array<{ content: string }>)[0];
  return block.content;
};

/** Every `-> path:a-b` a fold left behind. */
const pointers = (text: string): Array<{ path: string; from: number; to: number }> =>
  [...text.matchAll(/\[\.\.\. body, [^\]]*?-> (.+?):(\d+)-(\d+)/g)].map((m) => ({
    path: m[1],
    from: Number(m[2]),
    to: Number(m[3]),
  }));

describe('a whole-file read is compressed (the control)', () => {
  it('folds bodies, so the assertions below are not vacuous', () => {
    const body = numbered(1, SOURCE.length);
    expect(resultText({ file_path: FILE }, body).length).toBeLessThan(body.length / 2);
  });
});

describe('a range the model asked for comes back whole', () => {
  it.each([
    ['a paged Read', { file_path: FILE, offset: 1590, limit: 135 }],
    ['a Read with only a limit', { file_path: FILE, limit: 400 }],
    ['sed -n', { command: `sed -n '1,400p' ${FILE}` }],
    ['head', { command: `head -n 400 ${FILE}` }],
    ['Get-Content -TotalCount', { command: `Get-Content -TotalCount 400 '${FILE}'` }],
    ['a PowerShell index range', { command: `$l = Get-Content '${FILE}'; $l[0..399]` }],
    ['Select-Object -First', { command: `Get-Content '${FILE}' | Select-Object -First 400` }],
  ])('%s', (_, input) => {
    const body = numbered(1, 400);
    expect(resultText(input, body)).toBe(body);
  });

  it('a "range" longer than one page is compressed like a dump', () => {
    // `head -n 200000` is a range in form only. Past the 2,000 lines a Read
    // returns per call, the pass-through would ship whole dumps unfolded.
    const bigFile = join(ROOT, 'hooks-core', 'doctor.mjs');
    const big = readFileSync(bigFile, 'utf8')
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
      .join('\n');
    expect(big.split('\n').length).toBeGreaterThan(2000);
    expect(
      resultText({ command: `head -n 200000 ${bigFile}`, file_path: bigFile }, big).length
    ).toBeLessThan(big.length);
  });

  it('the same 400 lines read without a range are compressed', () => {
    // The pass-through above is about the RANGE, not the size: identical
    // content from an unranged Read is folded.
    const body = numbered(1, 400);
    expect(resultText({ file_path: FILE }, body).length).toBeLessThan(body.length);
  });
});

describe('a fold that cites the file cites its line numbers', () => {
  it('a read numbered from line 1201 points into lines 1201 onward', () => {
    const text = resultText({ file_path: FILE }, numbered(1201, 400));
    const cited = pointers(text).filter((p) => p.path === FILE);
    expect(cited.length).toBeGreaterThan(0);
    for (const { from, to } of cited) {
      expect(from).toBeGreaterThanOrEqual(1201);
      expect(to).toBeLessThan(1601);
      // The cited first line is the line the fold removed: its text survives
      // nowhere else in the result at that number.
      expect(text).not.toContain(`${String(from).padStart(6)}\t`);
    }
  });

  it('a whole file without line numbers is cited with its own numbering', () => {
    // The engine's standing contract for `sourcePath`: unnumbered content is the
    // file from line 1, so its lines are the file's lines.
    const text = resultText({ file_path: FILE }, SOURCE.join('\n'));
    const cited = pointers(text).filter((p) => p.path === FILE);
    expect(cited.length).toBeGreaterThan(0);
    for (const { from } of cited) {
      // The cited line is gone from the result: it is the one the fold removed.
      const removed = SOURCE[from - 1];
      expect(removed.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('line numbers are read off the result', () => {
  it('fileLineNumbers maps every line, carrying a number over a blank tail', () => {
    expect(fileLineNumbers(['    41\ta', '    42\tb', ''])).toEqual([41, 42, 42]);
    expect(fileLineNumbers(['41→a', '42→b'])).toEqual([41, 42]);
    expect(fileLineNumbers(['a', '    42\tb'])).toBeNull();
  });

  it('readNumbering reports the number it stripped from each line', () => {
    const numbering = readNumbering(numbered(1201, 5));
    expect(numbering?.lineNumbers).toEqual([1201, 1202, 1203, 1204, 1205]);
  });
});
