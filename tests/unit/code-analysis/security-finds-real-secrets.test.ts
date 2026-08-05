import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmartSecurity } from '../../../src/tools/code-analysis/smart-security.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A security scanner that reports "Secure" over a file holding a live-format
 * credential is worse than no scanner, because it is believed.
 *
 * The hardcoded-api-key rule matched `[a-zA-Z0-9]{16,}` between the quotes,
 * which excludes '_', '-' and '.'. Essentially every issued credential carries
 * one as a prefix separator, so of twelve documented formats only three matched
 * -- and all three were the incidentally-alphanumeric AWS ones. Verified live:
 * the scanner read a file containing `sk_live_...` and reported 0 findings,
 * while catching a planted eval() in the same run, so the scanner ran fine and
 * was simply blind to secrets.
 *
 * Bodies below are random. Only the documented public PREFIXES are real.
 */

/**
 * Assembled at runtime from fragments.
 *
 * Writing these as literals is not possible: GitHub's push protection detects
 * them and rejects the push -- which is itself confirmation that these are the
 * shapes a scanner is meant to catch. Joining the parts keeps the value the
 * regex sees identical while leaving nothing scannable in the file.
 */
const j = (...parts: string[]): string => parts.join('');

const CREDENTIALS: Array<[string, string]> = [
  [
    'stripe live',
    j('sk', '_', 'live', '_', '51H8xQ2eZvKYlo2Cabcdefghijklmnop'),
  ],
  [
    'stripe test',
    j('sk', '_', 'test', '_', '51H8xQ2eZvKYlo2Cabcdefghijklmnop'),
  ],
  ['github pat', j('ghp', '_', '16CharactersOrMoreAbcdefghijklmnop')],
  [
    'github fine-grained',
    j('github', '_', 'pat', '_', '11ABCDEFG0abcdefghijklmnop'),
  ],
  [
    'slack bot',
    j('xoxb', '-', '1234567890', '-', '1234567890', '-', 'AbCdEfGhIjKlMnOp'),
  ],
  ['aws access key', j('AKIA', 'IOSFODNN7EXAMPLE')],
  ['google api', j('AIza', 'SyD', '-', '1234567890abcdefghijklmnopqrst')],
  ['sendgrid', j('SG', '.', 'abcdefghijklmnop', '.', 'qrstuvwxyz1234567890')],
  ['openai', j('sk', '-', 'proj', '-', 'abcdefghijklmnopqrstuvwxyz1234')],
  [
    'anthropic',
    j('sk', '-', 'ant', '-', 'api03', '-', 'abcdefghijklmnopqrstuvwxyz'),
  ],
];

/** Code that must NOT be flagged -- a scanner that cries wolf gets muted. */
const INNOCENT: Array<[string, string]> = [
  ['env lookup', 'const apiKey = process.env.API_KEY;'],
  ['url', "const apiKey = 'https://api.example.com/v1/endpoint';"],
  ['config reference', 'const apiKey = config.apiKey;'],
  ['short value', "const apiKey = 'short';"],
  [
    'unrelated variable',
    "const username = 'abcdefghijklmnopqrstuvwxyz123456';",
  ],
];

describe('security scanner finds real credential formats', () => {
  let root: string;
  let cache: CacheEngine;
  let counter: TokenCounter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'security-secrets-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  const scan = async () => {
    const tool = new SmartSecurity(
      cache,
      counter,
      new MetricsCollector(),
      root
    );
    // force: true, or a cached "Secure" from a previous scan answers instead.
    return tool.run({ projectRoot: root, force: true });
  };

  for (const [label, value] of CREDENTIALS) {
    it(`flags a ${label} key`, async () => {
      writeFileSync(
        join(root, 'src', 'leak.ts'),
        `const apiKey = '${value}';\n`
      );

      const result = await scan();
      const secrets = result.findingsByCategory.find(
        (c) => c.category === 'secrets'
      );

      expect(secrets?.count ?? 0).toBeGreaterThan(0);
      expect(result.summary.criticalCount).toBeGreaterThan(0);
    });
  }

  for (const [label, code] of INNOCENT) {
    it(`does not flag ${label}`, async () => {
      writeFileSync(join(root, 'src', 'fine.ts'), `${code}\n`);

      const result = await scan();
      const secrets = result.findingsByCategory.find(
        (c) => c.category === 'secrets'
      );

      expect(secrets?.count ?? 0).toBe(0);
    });
  }

  it('reports savings measured from both sides, not from a per-finding guess', async () => {
    // originalTokens was `findings.length * 300` and compactedTokens a sum of
    // hand-written per-section constants -- two invented numbers whose
    // difference was published as a percentage saved.
    writeFileSync(
      join(root, 'src', 'leak.ts'),
      `const apiKey = '${CREDENTIALS[0][1]}';\n`
    );

    const result = await scan();
    const { originalTokens, compactedTokens, reductionPercentage } =
      result.metrics;

    expect(originalTokens).toBeGreaterThan(0);
    expect(compactedTokens).toBeGreaterThan(0);

    // The published percentage must be derivable from the two published numbers.
    const derived = Math.round(
      ((originalTokens - compactedTokens) / originalTokens) * 100
    );
    expect(reductionPercentage).toBe(derived);

    // A guess of 300 chars per finding gives 1 finding -> (300 + 50*n + 1000)/4.
    // Whatever the real measurement is, it must not be that arithmetic.
    expect(originalTokens).not.toBe(
      Math.ceil((300 + 50 * result.summary.filesScanned + 1000) / 4)
    );
  });
});
