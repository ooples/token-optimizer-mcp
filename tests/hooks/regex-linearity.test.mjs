/**
 * Every regex on the hook path must stay linear.
 *
 * CodeQL named one pattern in `rewrite.mjs`, and no input could be found that
 * made it measurably slow. Driving the patterns directly instead found a
 * different one that was genuinely quadratic: the C# modifier patterns in
 * `symbols.mjs` began `^\s*(?:public|...|\s)*`, where a leading `\s*` and a
 * group that also matches `\s` give every run of whitespace two places to be
 * consumed. Doubling the input quadrupled the time -- 1,000 spaces in 2ms,
 * 4,000 in 31ms, 16,000 in 498ms -- which puts a 64,000-space line near eight
 * seconds, on patterns that run over real file content during indexing.
 *
 * A static rule cannot express "this quantifier is ambiguous", so this measures
 * instead: every regex literal in the hook path is run against inputs shaped to
 * exploit ambiguity, and each must finish well inside a budget a linear pattern
 * clears by two orders of magnitude.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIRS = ['hooks-core', join('plugin', 'hooks')];

/**
 * A budget, not a benchmark.
 *
 * SIZED FOR A WIDE GAP, NOT A TIGHT MARGIN. At 16,000 characters the slowest of
 * the four real offenders measured 251ms against a 250ms budget, so the gate
 * caught it only about half the time -- a gate that reports a defect by coin
 * toss is worse than none, because it teaches people the failure is noise.
 * Quadrupling the input quadruples a quadratic pattern's cost and leaves a
 * linear one where it was, which buys the separation instead of borrowing it
 * from luck: every linear pattern here still finishes in single-digit
 * milliseconds, and each of the four originals now takes over a second.
 */
const BUDGET_MS = 250;

/** Inputs shaped so an ambiguous quantifier has to try every division. */
const attacks = (n) => [
  ' '.repeat(n),
  ' '.repeat(n) + '!',
  '\t'.repeat(n) + '!',
  'A='.repeat(n) + '!',
  'A=x '.repeat(n) + '1bad',
  'a'.repeat(n) + '!',
  ('-' + 'a'.repeat(4) + ' ').repeat(n) + '!',
  'tail ' + '-f '.repeat(n) + '!',
  'x/'.repeat(n) + '!',
  ('public ' + 'static ').repeat(n) + '!',
];

/**
 * Source with its comments removed.
 *
 * THE GATE MUST READ CODE, NOT PROSE. Without this it flagged a pattern that had
 * already been fixed -- the doc comment explaining the fix quoted the old
 * regex, and the scanner found it there. A gate that fails on its own
 * explanation trains people to stop reading it.
 */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Regex literals in a source file, skipping comments and division. */
function regexLiterals(source) {
  const found =
    withoutComments(source).match(
      // DISJOINT ALTERNATIVES. `\\.` overlapped `[^\]]`, and the generic branch
      // overlapped the bracket branch on `[`, so a fragment that looks like an
      // unterminated regex could be divided between them an exponential number of
      // ways -- a ReDoS gate that can itself be stalled by the source it reads,
      // which CodeQL caught and this test could not, since it never times itself.
      /(?<![\w/\\])\/(?![/*])(?:\\.|\[(?:\\.|[^\\\]])*\]|[^/\n\\\[])+\/[gimsuy]*/g
    ) || [];

  const compiled = [];
  for (const literal of new Set(found)) {
    const lastSlash = literal.lastIndexOf('/');
    try {
      compiled.push({
        literal,
        // `g` and `y` carry state across calls, which would make repeated
        // timing runs measure the wrong thing.
        regex: new RegExp(
          literal.slice(1, lastSlash),
          literal.slice(lastSlash + 1).replace(/[gy]/g, '')
        ),
      });
    } catch {
      // Not a regex after all -- a division, or a pattern this crude scan
      // mis-sliced. Skipping is right: a false positive here would fail the
      // suite for something that is not even a pattern.
    }
  }
  return compiled;
}

const files = [];
for (const dir of DIRS) {
  const full = join(ROOT, dir);
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push({ name: join(dir, entry.name), path: join(full, entry.name) });
    }
  }
}

describe('regexes on the hook path are linear', () => {
  it('scans a meaningful number of files and patterns', () => {
    // Guards the scan itself. A rename or a moved directory would leave this
    // suite passing while checking nothing -- and so would a comment stripper
    // that got greedy and removed the code along with the prose, which is a
    // live risk now that one runs before extraction.
    expect(files.length).toBeGreaterThan(20);

    const total = files.reduce(
      (sum, f) => sum + regexLiterals(readFileSync(f.path, 'utf8')).length,
      0
    );
    expect(total).toBeGreaterThan(100);
  });

  it.each(files.map((f) => [f.name, f.path]))('%s', (_name, path) => {
    const offenders = [];

    for (const { literal, regex } of regexLiterals(readFileSync(path, 'utf8'))) {
      for (const input of attacks(32_000)) {
        const started = process.hrtime.bigint();
        try {
          regex.test(input);
        } catch {
          continue;
        }
        const ms = Number(process.hrtime.bigint() - started) / 1e6;

        if (ms > BUDGET_MS) {
          offenders.push(`${ms.toFixed(0)}ms on ${input.length} chars: ${literal.slice(0, 90)}`);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
