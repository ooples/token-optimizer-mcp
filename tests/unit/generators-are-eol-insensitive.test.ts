import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- scripts ship as plain ESM with no type declarations.
import { normalizeEol, contentMatches, writeIfChanged } from '../../scripts/lib/text.mjs';

/**
 * The generators compared generated content to on-disk content byte-for-byte,
 * so every Windows checkout reported drift that did not exist.
 *
 * `.gitattributes` sets `* text=auto`: files are stored with LF and written to
 * the working tree with CRLF on Windows. Generators build their output with '\n'
 * regardless, so a byte comparison finds every line different.
 *
 * sync-hook-core.mjs already carries the fix and documents it at length -- it
 * was written after `npm test` failed on a fresh Windows clone. But the same fix
 * was never applied to generate-client-entries.mjs or generate-client-configs.mjs,
 * so `npm run sync:hooks:check` still reported 10 phantom drifted entry files on
 * Windows while Linux CI stayed green.
 *
 * That matters more now than it did: sync:hooks:check has become a CI gate, and
 * `npm run verify:all` is the documented pre-flight. A gate that cannot pass
 * locally on a supported platform trains contributors to skip it.
 *
 * The write path has the same defect from the other side. Writing LF into a
 * CRLF working tree rewrites every byte of ~200 files that were already correct,
 * so `npm run sync:hooks` on Windows produces a diff of pure line-ending churn
 * with the real change buried in it.
 *
 * The last test is the one that prevents recurrence. The bug was not that the
 * comparison was wrong -- it was that the correct comparison existed in one of
 * three generators. A shared helper plus an assertion that every generator uses
 * it is what closes that, rather than a third hand-copied `normalize`.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eol-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeEol', () => {
  it('makes CRLF and LF compare equal', () => {
    expect(normalizeEol('a\r\nb\r\n')).toBe(normalizeEol('a\nb\n'));
  });

  it('leaves a lone CR alone, which is a real content difference', () => {
    // Old Mac line endings are not what git rewrites, so treating them as
    // equivalent would hide genuine drift.
    expect(normalizeEol('a\rb')).toBe('a\rb');
  });
});

describe('contentMatches', () => {
  it('treats a CRLF file as matching LF generated output', () => {
    expect(contentMatches('export const x = 1;\r\n', 'export const x = 1;\n')).toBe(true);
  });

  it('still detects a real content change', () => {
    expect(contentMatches('export const x = 1;\r\n', 'export const x = 2;\n')).toBe(false);
  });

  it('reports a missing file as not matching', () => {
    expect(contentMatches(null, 'anything')).toBe(false);
  });
});

describe('writeIfChanged', () => {
  it('does not touch a file that differs only in line endings', () => {
    const path = join(dir, 'generated.mjs');
    writeFileSync(path, 'line one\r\nline two\r\n');
    const before = statSync(path).mtimeMs;

    const written = writeIfChanged(path, 'line one\nline two\n');

    expect(written).toBe(false);
    // The bytes on disk are untouched, so the working tree stays clean.
    expect(readFileSync(path, 'utf8')).toBe('line one\r\nline two\r\n');
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('writes when the content genuinely changed', () => {
    const path = join(dir, 'generated.mjs');
    writeFileSync(path, 'old\r\n');

    const written = writeIfChanged(path, 'new\n');

    expect(written).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('new\n');
  });

  it('creates a file that does not exist yet', () => {
    const path = join(dir, 'nested', 'generated.mjs');

    expect(writeIfChanged(path, 'fresh\n')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('fresh\n');
  });
});

describe('every generator', () => {
  const ROOT = process.cwd();
  const GENERATORS = [
    'scripts/sync-hook-core.mjs',
    'scripts/generate-client-entries.mjs',
    'scripts/generate-client-configs.mjs',
  ];

  it.each(GENERATORS)('%s uses the shared EOL-safe comparison', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');

    // The recurrence guard: the original bug was a correct comparison living in
    // one generator and not the other two. Requiring the shared import means a
    // fourth generator cannot quietly reintroduce it.
    expect(source).toMatch(/from '\.\/lib\/text\.mjs'/);
  });

  it.each(GENERATORS)('%s does not compare raw file bytes', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');

    // `current !== contents` is the exact shape that produced the phantom drift.
    expect(source).not.toMatch(/current\s*!==\s*contents/);
  });
});
