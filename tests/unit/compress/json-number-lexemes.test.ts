import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';

/**
 * `lossless: true` must mean the NUMBER SOURCE TEXT survived, not just the value.
 *
 * The engine used to minify with `JSON.stringify(JSON.parse(text))`, and a round
 * trip through the parser canonicalises every number: `19.90` came back `19.9`,
 * `0.0500` came back `0.05`, `1e3` came back `1000`. Those bytes are not
 * recoverable from the output, yet the result reported `lossless: true` -- which
 * `types.ts` defines as every dropped byte being reconstructible from the output
 * alone.
 *
 * NOTHING CAUGHT IT, and the reason is worth keeping. The obvious oracle,
 * `JSON.parse(a)` deep-equals `JSON.parse(b)`, is structurally blind here: the
 * values ARE identical, only their spelling differs. So the assertion below is
 * on the lexeme, never on the parsed value.
 *
 * THE FIXTURES ARE HAND-WRITTEN, LINE BY LINE, and that is load-bearing rather
 * than stylistic. `JSON.stringify` would normalise `19.90` to `19.9` before the
 * engine ever saw it, so a generated fixture cannot contain the thing under
 * test -- three earlier probes measured nothing for exactly that reason. It is
 * also why the benchmark corpus missed this entirely: all 11 workloads are
 * machine-generated, carry 5,255 numeric lexemes between them, and not one of
 * them is written in a form the parser would change.
 *
 * Each fixture is a shape the router reaches through MINIFICATION rather than
 * the record-template path, which is the only path that ever had this defect.
 */

const SERVICE_CONFIG = `{
  "service": "checkout",
  "replicas": 3,
  "timeoutSeconds": 30.0,
  "errorBudget": 0.0500,
  "canaryShare": 0.10,
  "retry": {
    "attempts": 5,
    "backoffMultiplier": 2.0,
    "maxDelaySeconds": 60.00
  },
  "limits": { "cpu": "500m", "memory": "512Mi" },
  "featureFlags": ["fast-path", "new-pricing", "async-refunds"],
  "owner": null
}`;

const PRICING_TABLE = `[
  { "sku": "A-1", "price": 19.90, "currency": "USD", "taxRate": 0.0825 },
  { "sku": "B-2", "price": 5.00, "currency": "USD", "taxRate": 0.0825, "bundle": ["A-1", "C-3"] },
  { "sku": "C-3", "price": 100.0, "currency": "EUR", "vatIncluded": true },
  { "sku": "D-4", "price": 2.50, "currency": "USD", "taxRate": 0.0600, "clearance": true, "stock": 0 },
  { "sku": "E-5", "price": 1e3, "currency": "JPY" }
]`;

const METRICS = `{
  "window": "5m",
  "p50": 12.0,
  "p95": 148.50,
  "p99": 1e3,
  "errorRate": 0.00100,
  "byRoute": {
    "/checkout": { "p50": 30.0, "count": 1200 },
    "/cart": { "p50": 8.50, "count": 9400 },
    "/search": { "p50": 2.0, "count": 41000 }
  }
}`;

const FIXTURES = [
  { name: 'a service config', text: SERVICE_CONFIG },
  { name: 'a heterogeneous pricing table', text: PRICING_TABLE },
  { name: 'a nested metrics snapshot', text: METRICS },
];

/** Numbers, excluding digits that are part of an identifier or a key. */
const NUMBER = /(?<![\w."])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])/g;

/** A lexeme only matters here if reparsing would change its text. */
function atRisk(text: string): string[] {
  return [...new Set(text.match(NUMBER) ?? [])].filter((lexeme) => {
    try {
      return String(JSON.parse(lexeme)) !== lexeme;
    } catch {
      return false;
    }
  });
}

/** Number lexemes outside strings, scanned independently of the implementation. */
function numbersOutsideStrings(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i])) i += 1;
      found.push(text.slice(start, i));
      continue;
    }
    i += 1;
  }
  return found;
}

describe('a lossless JSON result keeps every number exactly as written', () => {
  it.each(FIXTURES)('$name', ({ text }) => {
    // A fixture carrying nothing the parser would rewrite cannot detect the
    // defect, and would pass forever while proving nothing.
    expect(atRisk(text).length).toBeGreaterThan(0);

    const result = compressBlock(text, { tuning: DEFAULT_TUNING });

    // An inert engine satisfies the lexeme assertion by doing nothing at all.
    expect(result.text.length).toBeLessThan(text.length);

    // NOT AN ESCAPE HATCH. Returning early when the result is lossy lets a
    // regression satisfy this test by rewriting 19.90 to 19.9 and lowering
    // the flag. These fixtures are all minifiable -- the assertion above
    // requires it -- so losslessness is a requirement here, not a condition.
    expect(result.lossless).toBe(true);
    for (const lexeme of atRisk(text)) expect(result.text).toContain(lexeme);
  });

  it('the parse-based oracle cannot see this, which is why it is not used', () => {
    // Kept as a standing explanation: canonicalising every number leaves the
    // parsed value identical, so deep-equality reports success either way.
    const canonical = JSON.stringify(JSON.parse(SERVICE_CONFIG));
    expect(JSON.stringify(JSON.parse(canonical))).toBe(
      JSON.stringify(JSON.parse(SERVICE_CONFIG))
    );
    expect(canonical).not.toContain('0.0500');
    expect(atRisk(SERVICE_CONFIG)).toContain('0.0500');
  });

  it('never claims losslessness while a number outside a string was rewritten', () => {
    /*
     * A FORWARD GUARD, AND SAID PLAINLY: no input reachable through
     * compressBlock today can break this.
     *
     * The substring form of this check could be fooled by a document like
     * `{"n":1e3,"note":"value 1e3"}` IF the serialising fallback ran, because
     * `1e3` survives inside the note while n becomes 1000. That fallback is
     * taken only when a nested string was compressed, and every nested shape
     * measured -- json arrays, csv rows, key=value lines, 100 to 1200 entries,
     * and log lines -- either leaves the nested string alone (whitespace is
     * the only elision) or compresses it lossily, which lowers the flag on its
     * own. So this asserts the invariant rather than reproducing a live bug,
     * and it starts earning its place the moment that routing changes.
     */
    const payloads = [
      JSON.stringify(
        Array.from({ length: 200 }, (_, i) => ({ id: i, ok: true }))
      ),
      Array.from({ length: 200 }, (_, i) => `${i},row ${i},200,ok`).join('\n'),
      'the quick brown fox jumps over the lazy dog. '.repeat(60),
    ];

    for (const payload of payloads) {
      const text = JSON.stringify(
        { n: 1e3, note: 'value 1e3', payload },
        null,
        2
      ).replace('"n": 1000', '"n": 1e3');
      const result = compressBlock(text, { tuning: DEFAULT_TUNING });
      if (!result.lossless) continue;
      expect(numbersOutsideStrings(result.text)).toEqual(
        numbersOutsideStrings(text)
      );
    }
  });
});
