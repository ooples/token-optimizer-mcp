import { describe, it, expect, afterEach } from '@jest/globals';
import {
  engineFor,
  registerEngine,
  registeredEngines,
  runEngine,
  unregisterEngine,
} from '../../../src/compress/registry.js';
import { BUILT_IN_ENGINES, classify, compressBlock, engineNameFor } from '../../../src/compress/router.js';
import type { EngineRegistration } from '../../../src/compress/registry.js';

/**
 * The extension point, and the boundary that makes it safe to use.
 *
 * A registered engine runs in this process and sees the content it is given --
 * this is not a sandbox, and registering one is the same trust decision as
 * installing a dependency. What the boundary guarantees is narrower and more
 * useful: no engine, ours or anyone's, can make the request larger, wedge the
 * agent, or drop content it cannot say how to recover.
 */

const CUSTOM = 'test-only-engine';

afterEach(() => {
  unregisterEngine(CUSTOM);
});

const lossless = (text: string) => ({ text, elisions: [], lossless: true });

describe('registration', () => {
  it('ships the built-ins through the same path as anybody else', () => {
    // No privileged tier: one dispatch path, one set of rules to test.
    const names = registeredEngines().map((e) => e.name);
    for (const built of BUILT_IN_ENGINES) expect(names).toContain(built);
  });

  it('orders by priority, highest first', () => {
    const priorities = registeredEngines().map((e) => e.priority ?? 0);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  });

  it('lets a custom engine claim content ahead of a built-in', () => {
    // A user who knows their own format knows better than our heuristics.
    const json = '{"a":1,"b":2}';
    expect(engineNameFor(json)).toBe('json');

    registerEngine({
      name: CUSTOM,
      priority: 100,
      claims: (text) => text.startsWith('{'),
      compress: lossless,
    });

    expect(engineNameFor(json)).toBe(CUSTOM);
    expect(classify(json)).toBe('custom');
  });

  it('replaces a registration with the same name rather than duplicating it', () => {
    const before = registeredEngines().length;
    registerEngine({ name: CUSTOM, claims: () => false, compress: lossless });
    registerEngine({ name: CUSTOM, claims: () => false, compress: lossless });
    expect(registeredEngines().length).toBe(before + 1);
  });

  it('refuses a registration that cannot work', () => {
    expect(() => registerEngine({ name: '', claims: () => true, compress: lossless })).toThrow();
    expect(() =>
      registerEngine({ name: CUSTOM, claims: undefined as never, compress: lossless })
    ).toThrow();
  });

  it('unregisters, and reports whether it did', () => {
    registerEngine({ name: CUSTOM, claims: () => false, compress: lossless });
    expect(unregisterEngine(CUSTOM)).toBe(true);
    expect(unregisterEngine(CUSTOM)).toBe(false);
  });

  it('treats a throwing claim as no claim rather than a failed request', () => {
    // Fail open applies to the decision as well as the transform: one broken
    // engine must not stop everything else being compressed.
    registerEngine({
      name: CUSTOM,
      priority: 100,
      claims: () => {
        throw new Error('broken claim');
      },
      compress: lossless,
    });
    expect(engineNameFor('{"a":1}')).toBe('json');
  });
});

describe('the boundary', () => {
  const run = (engine: Partial<EngineRegistration>, text: string): string =>
    runEngine(
      { name: CUSTOM, claims: () => true, compress: lossless, ...engine } as EngineRegistration,
      text,
      {}
    ).text;

  const INPUT = 'x'.repeat(200);

  it('discards output larger than the input', () => {
    expect(run({ compress: (t) => ({ text: t + t, elisions: [], lossless: true }) }, INPUT)).toBe(
      INPUT
    );
  });

  it('passes the input through when an engine throws', () => {
    expect(
      run(
        {
          compress: () => {
            throw new Error('boom');
          },
        },
        INPUT
      )
    ).toBe(INPUT);
  });

  it('passes the input through when an engine returns nonsense', () => {
    expect(run({ compress: () => undefined as never }, INPUT)).toBe(INPUT);
    expect(run({ compress: () => ({ text: 'ok' }) as never }, INPUT)).toBe(INPUT);
  });

  it('refuses a lossy elision with nowhere to recover from', () => {
    // The rule `code` already applied to itself, now applied to everyone.
    const dropped = run(
      {
        compress: () => ({
          text: 'tiny',
          elisions: [{ removed: 'everything', recoverAt: null, lossless: false }],
          lossless: false,
        }),
      },
      INPUT
    );
    expect(dropped).toBe(INPUT);
  });

  it('accepts a lossy elision that names where the content went', () => {
    const kept = run(
      {
        compress: () => ({
          text: 'tiny',
          elisions: [{ removed: 'the rest', recoverAt: '/spill/1.txt', lossless: false }],
          lossless: false,
        }),
      },
      INPUT
    );
    expect(kept).toBe('tiny');
  });

  it('accepts lossless elisions alongside a lossy one', () => {
    // PER ELISION, NOT PER RESULT. A JSON document removes whitespace and null
    // keys losslessly and elides its repeating tail lossily; judging the result
    // rejected all of it and took three workloads to 0%.
    const kept = run(
      {
        compress: () => ({
          text: 'tiny',
          elisions: [
            { removed: '900 bytes of whitespace', recoverAt: null, lossless: true },
            { removed: '12 null fields', recoverAt: null, lossless: true },
            { removed: '57 repeating rows', recoverAt: '/spill/1.json', lossless: false },
          ],
          lossless: false,
        }),
      },
      INPUT
    );
    expect(kept).toBe('tiny');
  });
});

describe('dispatch', () => {
  it('leaves content nothing claims untouched', () => {
    const odd = '';
    expect(compressBlock(odd).text).toBe(odd);
    expect(engineFor(odd, {})).toBeNull();
  });

  it('routes a custom engine through the same boundary as a built-in', () => {
    registerEngine({
      name: CUSTOM,
      priority: 100,
      claims: (text) => text.includes('CLAIM-ME'),
      compress: (text) => ({ text: text + text, elisions: [], lossless: true }),
    });
    const text = 'CLAIM-ME ' + 'y'.repeat(100);
    // It grew, so the boundary discarded it -- exactly as for one of ours.
    expect(compressBlock(text).text).toBe(text);
  });
});
