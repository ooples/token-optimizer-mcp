import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- scripts ship as plain ESM with no type declarations.
import {
  normalizeEol,
  contentMatches,
  writeIfChanged,
} from '../../scripts/lib/text.mjs';

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
    expect(
      contentMatches('export const x = 1;\r\n', 'export const x = 1;\n')
    ).toBe(true);
  });

  it('still detects a real content change', () => {
    expect(
      contentMatches('export const x = 1;\r\n', 'export const x = 2;\n')
    ).toBe(false);
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

  it.each(GENERATORS)('%s imports the shared EOL-safe helpers', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source).toMatch(/from '\.\/lib\/text\.mjs'/);
  });

  // AN IMPORT IS NOT A CALL, which is what the first version of this guard
  // asserted. Reported by CodeRabbit on this PR, and confirmed by reverting
  // generate-client-entries.mjs to a raw byte comparison AND an unconditional
  // write while keeping the import: all fourteen tests stayed green. A guard
  // that cannot fail is decoration.
  it.each(GENERATORS)(
    '%s routes its comparison through the helpers',
    (file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source).toMatch(/contentMatches\s*\(\s*readIfExists\s*\(/);
    }
  );

  it.each(GENERATORS)('%s routes its writes through writeIfChanged', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source).toMatch(/\bwriteIfChanged\s*\(/);
  });

  // STRUCTURAL, NOT A SPELLING. Banning the literal `current !== contents` --
  // the previous check -- only forbade one variable naming; renaming it walked
  // straight past. No generator imports writeFileSync today, and requiring that
  // to stay true means a direct write cannot be reintroduced under any name,
  // because it has nowhere to come from.
  it.each(GENERATORS)(
    '%s cannot write bytes except through the helper',
    (file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source).not.toMatch(/\bwriteFileSync\b/);
    }
  );

  it.each(GENERATORS)('%s does not compare raw file contents', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // Any identifier compared against the generated `contents`, not one name.
    expect(source).not.toMatch(/\b[A-Za-z_$][\w$]*\s*(===|!==)\s*contents\b/);
    expect(source).not.toMatch(/readFileSync\s*\([^)]*\)\s*(===|!==)/);
  });
});

describe('a generator run against a CRLF working tree', () => {
  // THE PROPERTY ITSELF, not a proxy for it. The assertions above read source
  // text; this one runs the real generator on this real platform and checks the
  // two behaviours the bug actually broke -- --check reporting drift that does
  // not exist, and a write rewriting bytes that were already correct.
  //
  // `ROOT` is derived from the script's own location, so the generator is copied
  // into a temporary tree with its helper and runs entirely inside it. Nothing
  // in the repository is touched.
  const GEN = 'generate-client-entries.mjs';

  function sandbox() {
    const root = mkdtempSync(join(tmpdir(), 'gen-eol-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(
      join(process.cwd(), 'scripts', GEN),
      join(root, 'scripts', GEN)
    );
    copyFileSync(
      join(process.cwd(), 'scripts', 'lib', 'text.mjs'),
      join(root, 'scripts', 'lib', 'text.mjs')
    );
    // Generated hook entries stamp the package version into lifecycle telemetry,
    // making package.json an explicit generator input alongside the script and
    // its EOL-safe text helper.
    copyFileSync(join(process.cwd(), 'package.json'), join(root, 'package.json'));
    return root;
  }

  function run(root: string, args: string[] = []) {
    return spawnSync(process.execPath, [join(root, 'scripts', GEN), ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  function generated(root: string) {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (full.endsWith('.mjs')) out.push(full);
      }
    };
    if (existsSync(join(root, 'integrations')))
      walk(join(root, 'integrations'));
    return out;
  }

  it('reports no drift, and rewrites nothing, when the files are CRLF', () => {
    const root = sandbox();
    try {
      expect(run(root).status).toBe(0);

      const files = generated(root);
      expect(files.length).toBeGreaterThan(0);

      // Exactly what git does on a Windows checkout of an LF-stored file.
      for (const f of files) {
        writeFileSync(f, readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
      }
      const before = files.map((f) => readFileSync(f));

      // 1. --check must not invent drift.
      const checked = run(root, ['--check']);
      expect(checked.stderr || '').not.toMatch(/DRIFT/);
      expect(checked.status).toBe(0);

      // 2. A plain run must leave every already-correct byte alone. This is the
      //    half that turned `npm run sync:hooks` into a ~200-file diff of pure
      //    line-ending churn with the real change buried in it.
      expect(run(root).status).toBe(0);
      files.forEach((f, i) => {
        expect(readFileSync(f).equals(before[i])).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
