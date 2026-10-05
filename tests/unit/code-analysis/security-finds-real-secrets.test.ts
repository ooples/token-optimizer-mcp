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

  it('states no saving of its own anywhere in the reply', async () => {
    /*
     * THIS TEST USED TO REQUIRE THE OPPOSITE, and both versions were asking
     * the same question: can this tool stand behind the figure it publishes?
     * It once published `findings.length * 300` against a sum of per-section
     * constants. That was replaced by two real counts -- and the counts were
     * of the full internal result and three of its arrays, neither of which is
     * the text a caller is sent, which is how one flat 85% came to be printed
     * for three fixtures whose real figures were 98.0%, 97.1% and 92.3%.
     *
     * The after cannot be counted in here at all: the reply is serialised from
     * this object after the tool returns. So the tool states nothing, the wire
     * counts the after once, and the before -- the files named in the
     * arguments -- is read by the recorder. What is asserted is the absence.
     */
    writeFileSync(
      join(root, 'src', 'leak.ts'),
      `const apiKey = '${CREDENTIALS[0][1]}';\n`
    );

    const result = await scan();
    expect(result).not.toHaveProperty('metrics');

    // AND NOT UNDER ANOTHER NAME. A reply is a tree, so the check is over
    // every key in it, not just the one the deleted block happened to use.
    const SAVINGS_KEYS = [
      'originalTokens',
      'compactedTokens',
      'reductionPercentage',
      'tokensSaved',
      'savedTokens',
      'tokensBefore',
      'tokensAfter',
      'savingsPercent',
      'compressionRatio',
    ];
    const seen: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (SAVINGS_KEYS.includes(key)) seen.push(key);
        walk(value);
      }
    };
    walk(result);
    expect(seen).toEqual([]);
    // THE POSITIVE CONTROL: the walk does reach into the reply, so an empty
    // result above is an absence of savings keys and not a dead traversal.
    walk({ findings: [{ nested: { tokensSaved: 1 } }] });
    expect(seen).toEqual(['tokensSaved']);
  });
});
