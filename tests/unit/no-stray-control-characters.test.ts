import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A regex containing a literal control character silently never matches.
 *
 * `/\b(COUNT|SUM|AVG)\b/i` written through a tool that mangles escapes becomes
 * `/<BS>(COUNT|SUM|AVG)<BS>/i` -- a pattern requiring a literal backspace on
 * either side, which no SQL query contains. The guard it protected was
 * therefore always false, and `SELECT COUNT(*) FROM users` was advised to add
 * a WHERE clause it does not need.
 *
 * The failure mode is what makes this worth a test: the file LOOKS right. The
 * character is invisible in most editors, `grep` prints the line as though the
 * escape were there, and the regex is valid, so nothing errors. It took
 * `cat -A` to see `^H`. Nothing else in the toolchain would ever have said so.
 *
 * Tabs and newlines are legitimate; these four are not.
 */

const ROOT = process.cwd();
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.token-optimizer',
]);

/**
 * Control characters that are never intentional in source.
 *
 * NUL WAS MISSING FROM THIS LIST, and a raw NUL byte duly turned up in
 * src/server/index.ts: `.update('\0')` had been written with a literal byte
 * instead of the escape. Same mangling as the backspace above, same
 * invisibility -- but worse in one specific way, because a NUL makes tools treat
 * the whole FILE as binary. `grep` stopped searching src/server/index.ts and
 * printed "Binary file matches" instead, which is how it was noticed at all.
 *
 * The lesson is in the omission, not the byte: this list was written from the
 * one character that had bitten us, so it caught exactly that one. It now
 * covers every C0 control that is not tab, newline, or carriage return.
 */
const ALLOWED_CONTROLS = new Set([9, 10, 13]); // tab, LF, CR

const CONTROL_NAMES: Record<number, string> = {
  0: 'NUL',
  7: 'bell',
  8: 'backspace',
  11: 'vertical tab',
  12: 'form feed',
  27: 'escape',
};

const FORBIDDEN: Array<[number, string]> = Array.from(
  { length: 32 },
  (_, code) => code
)
  .filter((code) => !ALLOWED_CONTROLS.has(code))
  .map((code) => [
    code,
    CONTROL_NAMES[code] ?? `control 0x${code.toString(16)}`,
  ]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('source contains no stray control characters', () => {
  const files = sourceFiles(join(ROOT, 'src'))
    .concat(sourceFiles(join(ROOT, 'tests')))
    .concat(sourceFiles(join(ROOT, 'hooks-core')));

  it('scanned a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no literal control character where an escape was meant', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [code, label] of FORBIDDEN) {
        // Built from a code point, so this file cannot contain the very
        // character it looks for -- the check would otherwise fail on itself.
        const ch = String.fromCharCode(code);
        if (!text.includes(ch)) continue;
        const line = text.slice(0, text.indexOf(ch)).split('\n').length;
        offenders.push(
          `${file.replace(ROOT, '')}:${line} contains a literal ${label} character`
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
